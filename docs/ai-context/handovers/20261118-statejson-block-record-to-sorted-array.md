---
created_at: 2026-11-18
updated_at: 2026-11-18
topic: statejson-block-record-to-sorted-array
status: resolved
affected_modules: [src/state.ts, src/cli.ts, src/arbitrate.ts, docs/USING.md, .pi/extensions/translate.ts, .pi/extensions/translate-prompt.ts, test/state.test.ts]
tags: [doubao, translate, state.json, JSON.stringify, key-hoisting, block-ordering, migration, agent-drift]
---

# State.json: blocks Record → Code-Sorted Array (JSON Integer-Key Hoisting)

## 1. Context & Problem
`artifacts/state.json` stored `blocks` as a `Record<code, BlockState>`. `JSON.stringify` hoists canonical integer-like keys (`"100"`..`"132"`) to the front in numeric order, but zero-padded codes (`"000"`..`"098"`) are not canonical and stay at the back. Result: one file, two separated regions — the tail section first, the head last. During a real translation run the agent read from `offset=1`, got blocks 100–112 (not its batch 000–008), then fell into linear paging through the whole 184K file (Doubao refs carry long Chinese explanations). Context bloated to ~56k tokens and the final model call was aborted (`stopReason: "aborted"`); the batch was never submitted. Paid Doubao data (9 min of fetches) survived on disk — resumable.

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)
- **Attempt**: Sort block codes with `localeCompare` when converting to an array.
  - **Failure Reason**: Lexicographic — `"1000".localeCompare("999")` → `-1`, so 4-digit codes misorder. `markdown.ts` `pad()` never stops incrementing at 999. Caught in verification round 1. Use numeric `parseInt` comparison with a string tiebreak (keeps `010p`/`1000b` suffix siblings adjacent to their base code).
- **Attempt**: Update only the two obviously-known agent-facing path strings (`docs/USING.md`, `cli.ts` instructions).
  - **Failure Reason**: Three more lived elsewhere: `.pi/extensions/translate.ts:307` (arbitrate_next tool description), `.pi/extensions/translate-prompt.ts:77` (system prompt), `src/arbitrate.ts:66` (ack-mismatch rejection message). Caught in verification round 2. ALWAYS sweep `src/`, `.pi/`, `docs/` with `grep 'blocks\.<code>\|blocks\.\${'` after changing the state shape.
- **Attempt**: Migrate on load only (constructor converts Record→array in memory), expect it persisted immediately.
  - **Failure Reason**: Migration persists only on the next `flushGlobal()` (first write op). Byte-compare against disk right after load shows the old format still there — not a bug, but verify migration via a forced flush.
- **Gotcha**: `JSON.parse` object-key reordering is silent — data is intact, layout is not. Diffing parsed dicts shows NO difference; only file line order reveals it.

## 3. Decision & Verified Solution
- **Chosen Approach**: Store `blocks` as `BlockEntry[]` (`{ code, sentences?, refs? }`), sorted by numeric `codeOrder()` on every flush; auto-migrate old Record format in the `State` constructor; internal `Map` keeps `getBlock(code)` API unchanged. User chose option 1 (array) over prefixing keys (`b000`) or inlining refs into `arbitrate next` output.
- **Key Changes**: `src/state.ts` (array + `codeOrder` + migration + `ensureEntry`), `src/cli.ts:126` (`Object.keys(state.all.blocks)` → `.map(b => b.code)`), path-string updates in `cli.ts:283`, `arbitrate.ts:66`, `.pi/extensions/translate.ts:307`, `.pi/extensions/translate-prompt.ts:77`, `docs/USING.md:100`; `test/state.test.ts` (array order, Record migration preserving refs, 999/1000 + suffix adjacency).
- **Minimal Code / Command Reference**:
  ```ts
  // src/state.ts — the whole bug is this comparator choice
  function codeOrder(a: string, b: string): number {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    if (na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  // constructor: migrate old Record, persisted on next flush
  if (!Array.isArray(this.global.blocks)) {
    this.global.blocks = Object.entries(this.global.blocks as Record<string, BlockState>)
      .map(([code, b]) => ({ code, ...b }))
      .sort((a, b) => codeOrder(a.code, b.code));
  }
  ```
- Verified: tsc clean; 36/37 tests (1 pre-existing environmental failure — terms.test.ts expects empty global list, untracked root `terms.json` has 26 entries); real state.json migrated: 67 entries ascending, 151 refs intact; full CLI E2E (split → doubao → arbitrate next/submit → collect → verify) byte-identical to HEAD output.

## 4. Hard Constraints for Future AI
- NEVER store block collections as a plain object keyed by block code — `JSON.stringify` reorders integer-like keys. Array (or prefixed non-numeric keys) only.
- NEVER sort block codes with `localeCompare` — numeric comparison (`parseInt`) with suffix-aware tiebreak only.
- ALWAYS grep `src/`, `.pi/`, `docs/` for the old shape after changing any agent-facing file path — the same contract string lives in tool descriptions, system prompts, AND error messages.
- ALWAYS verify state migrations against the real artifacts file with a forced flush + byte-compare; in-memory migration is invisible on disk until the next write.

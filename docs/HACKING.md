# HACKING.md — contract for agents changing this codebase

Read `README.md` first for the what & why. This file covers the code.

## Architecture

Six CLI subcommands in `src/cli.ts`, one flow:

```
split → terms → (per batch) arbitrate next/submit → collect → verify
```

- `split` chunks the Markdown and splits sentences; both land in
  `artifacts/state.json`.
- `doubao` fetches /translate + /explain per sentence, serial, saved to
  disk after every sentence (resume support).
- `arbitrate next` picks the next un-arbitrated batch (CLI-chosen, cap
  10) and prints source + refs + ack fingerprints; `arbitrate submit`
  validates a payload (ids, ack, terms, placeholders) and is the only
  writer of `translations.json` (`src/arbitrate.ts` holds the pure
  validation logic).
- `collect` takes the agent's translations JSON and assembles the
  bilingual file.
- `verify` checks the output for completeness.

## Module roles

| File | Role |
|---|---|
| `src/cli.ts` | Subcommand dispatch, argument parsing, all I/O. Each subcommand block ends with `process.exit`. |
| `src/arbitrate.ts` | `validateBlock`/`ackOf`/`blockDone`: pure per-batch arbitration checks (ids, ack, terms, placeholders). No I/O. |
| `src/terms.ts` | `createTerms`: keep-in-English list, word-shape matching (`variants`/`pattern`). |
| `src/markdown.ts` | `splitIntoChunks`: remark AST → ordered blocks. Only top-level nodes. |
| `src/sentence.ts` | `splitBlockIntoSentences`: per-line ICU split, mask/restore of ⟦n⟧ placeholders. |
| `src/doubao.ts` | `createDoubao`: serial HTTP client, retries with backoff, throws `DoubaoError` on final failure (no fallback). Also `health()`. |
| `src/state.ts` | `State`: `artifacts/state.json` read/write. Global JSON file, flushed on every record. |
| `src/env.ts` | `.env` parsing → `Config` (doubaoBaseUrl, doubaoRetries, doubaoTimeoutMs). |

Dependencies are only `remark-parse`, `remark-gfm`,
`remark-frontmatter`, `unified`. Runtime is Node 20+ (`Intl.Segmenter`,
`fetch`).

## Invariants — do not break these

1. **Byte-level reconstruction.** Join all chunk `raw` values in order →
   the normalized (CRLF→LF) source, byte-for-byte. Blank lines are
   separate `b` blocks for this reason. `test/markdown.test.ts` checks
   it; if your change breaks that test, the change is wrong.
2. **Code writes all files.** `collect` is the only writer of the
   bilingual output (tmp + `renameSync`, atomic). The agent must never
   need file-write access to the output.
3. **Doubao failure = loud failure.** `doubao.ts` throws
   `DoubaoError`; `cli.ts` dies with exit 1. No null-refs, no silent
   degradation, no `<!-- TODO -->` fallbacks. This was a deliberate
   product decision — do not re-add fallback ladders.
4. **Serial Doubao calls.** One sentence at a time, translate then
   explain. Do not parallelize (upstream risk-control reasons).
5. **Per-sentence persistence.** Every fetched reference is flushed to
   `state.json` immediately. An interrupted run must never re-fetch
   completed sentences.
6. **collect refuses partial input.** Missing or blank sentence → exit
   1, nothing written. The check runs before any write.

## Block model

- Translatable: `code` = `007` (no suffix), `kind` = para/heading/quote/list.
- Passthrough content: `code` = `010p` — copied to output unchanged.
- Blank gaps: `code` = `011b` — spacing between blocks.
- Codes are global, zero-padded, sequential. They double as state keys.
- Sentence ids are per-block, start at 1, continuous across lines;
  `lineIds[i]` lists the ids on line i (empty array for blank lines).
  `collect` rebuilds the translation block line-by-line with it.

## Placeholder masking

`mask()` replaces, in order: inline code, images, bare URLs, leading
ordered-list numbers → `⟦n⟧` (n = index into a stash array).
`restore()` puts the originals back. The stash lives inside one
`splitBlockIntoSentences` call, so a block's translations must go
through the same call's `restore` (collect re-splits to get it).

## Tests

```bash
npm test        # node:test, markdown + sentence suites (18 cases)
npm run build   # tsc --noEmit
```

Tests are behavior-only: input → output of `splitIntoChunks` and
`splitBlockIntoSentences`. If you add a module with real logic, give it
a `test/<name>.test.ts` in the same style.

## Known sharp edges

- `verify` checks `output.includes(raw)` for passthrough blocks —
  substring, not uniqueness. Fine for tampering detection; don't reuse
  it as an ordering check.
- The placeholder check in `verify` compares sorted placeholder lists of
  source vs translation. A translation that writes out the masked
  content literally (instead of keeping ⟦n⟧) fails — this is intended
  (the standard mandates keeping them).
- `collect` with a nonexistent translations path throws a raw ENOENT
  stack (exit 1, nothing written). Polish opportunity, not a bug.
- Doubao upstream latency: minutes for long text. Timeouts live in
  `env.ts` (`DOUBAO_TIMEOUT_MS`, default 10 min). Do not lower it.

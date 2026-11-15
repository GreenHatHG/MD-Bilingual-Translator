# USING.md — contract for agents translating with this repo

You drive the translation. You call the subcommands, merge translations,
fix verification problems. You do NOT write or edit the output file.

## Hard rules

- **Never create or edit `*.bilingual.md` yourself.** Only `collect`
  writes the output file.
- **Doubao references are a hard prerequisite.** If the service is down,
  commands exit with an error. Do not fall back to translating alone —
  start the service (see below). If it still fails, report it honestly.
  Never invent references.
- **Every sentence must be finalized.** `collect` rejects the whole batch
  if one sentence is missing. No skipped, merged, or added sentences.
- **Keep placeholders ⟦n⟧ as-is** at the right spot in the translation.
  Do not translate them, do not add or drop them.
- **Keep `terms.json` words in English** at every place they appear (see
  step 2); match the exact source word form.
- **Never reuse translations from a previous run** as final output; see
  step 4.
- All subcommands: stdout is JSON (for you to parse), stderr is human
  logs.
- Exit codes: 0 = success; 1 = usage/input error; 2 = verify found
  problems.

## Prerequisite: Doubao service

```bash
node /Users/jooooody/Projects/doubao_hook/start_doubao.sh          # Doubao with debug port
node /Users/jooooody/Projects/doubao_hook/lib/doubao_server.js     # listens on 127.0.0.1:8765
curl -s localhost:8765/health                                      # ok:true = ready
```

One Doubao call can take minutes; client timeout defaults to 10 minutes
(`DOUBAO_TIMEOUT_MS`). Calls are serial — do not try to parallelize them.

## Workflow (in order)

### 1. split — chunk + sentence split

```bash
npx tsx src/cli.ts split input.md
```

```json
{ "inputFile": "x.md", "blocks": [ { "code": "002", "kind": "para",
  "sentenceCount": 2, "sentences": [ { "id": 1, "text": "Hello world. " } ] } ] }
```

- `code` with no suffix = translatable; `p` suffix = passthrough (do not
  translate); `b` = blank lines (ignore).
- Sentence ids start at 1 and are continuous within a block. `text` is
  the full source sentence, with masks already restored.
- The result is saved to `artifacts/state.json`; later steps refer to
  blocks by `code`.

### 2. terms — agree on keep-in-English words (fast, before doubao)

**This step has a hard STOP: you must wait for the user's reply before
going further.** It cannot be skipped or batched with later steps.

1. Read the source article and propose words/phrases that should stay
   in English (product names, agent jargon like `subagent`,
   `context window`, `skill`). Merge in any words already present in an
   existing `terms.json` from earlier translations.
2. Post the proposed list to the user and **end your turn.** The user
   decides what goes in — this is a user decision, not yours.
3. Only after the user confirms: write the final list to `terms.json`
   (JSON string array) and validate it.
4. If the user says to skip terms — and only then — proceed without a
   list and say so in your final report.

Validation command:

```bash
npx tsx src/cli.ts terms input.md terms.json
```

```json
{ "ok": true, "file": "/path/terms.json", "count": 2,
  "hits": { "subagent": 18, "subagents": 26 }, "missing": [] }
```

- `missing` = words in the list that never appear in the source
  (usually a typo) — fix them before continuing.
- Matching is word-shape aware: plurals and common suffixes count as a
  hit, but the final translation must keep the exact original spelling.
- `terms.json` is maintained across articles. Reuse it next time, and
  add new confirmed words to it — the list gets better with every
  translation. Only the user adds/removes entries; never invent terms
  the user has not confirmed.
- During arbitration, keep every listed word untranslated at each place
  it appears in that sentence.

### 3. doubao — fetch references (one command, resumable)

```bash
npx tsx src/cli.ts doubao input.md          # all translatable blocks, serial
npx tsx src/cli.ts doubao input.md 042 044  # subset, if you need one
```

```json
{ "ok": true, "blocks": 63, "requested": ["000", "002", "004", "…"] }
```

- One command runs all blocks serially; per-sentence progress goes to
  stderr, and every fetched sentence is flushed to disk immediately.
- A re-run skips cached sentences and finished blocks. If a block fails,
  the command lists the failed codes on stderr and exits 1; already
  fetched sentences are kept — just re-run the same command.
- Do not wrap this in shell `for` loops; the resume logic is inside.
- Refs per sentence land in `artifacts/state.json` under
  `blocks.<code>.refs` (raw `translation` + full `explanation`).

### 4. Arbitrate — merge the final translations (in small batches)

For each block you get three inputs: the source sentence, the Doubao
translation (raw, word-by-word), and the Doubao explanation (full
notes). **Arbitrate in batches of ~5 blocks.** Read the refs for those
blocks from `artifacts/state.json`, decide the final text for every
sentence in the batch, append to `translations.json`, then move to the
next batch. Do NOT write 100+ sentences in one sitting — attention
dilutes and quality drops.

**Never copy old translations forward.** If `translations.json` already
holds translations from a previous run (note: `artifacts/state.json`
only ever caches Doubao refs, never final translations), do NOT reuse
them as final output. Every sentence must be re-arbitrated
against the source and the Doubao refs in this run; existing entries
are at best a draft to review, not an answer.

How to use the two Doubao results:

- **Read the explanation first.** It often contains Doubao's own
  polished translation (look for a "翻译" / "译文" section). That one is
  usually the best base: Doubao refined it against the context, so it
  beats the raw translation.
- **No 译文 section? Still mine it.** The word notes and sense
  disambiguation ("X 这里不是 A，而是 B") are exactly the traps to avoid;
  use them to fix word choices and phrasing even when no ready
  translation is offered.
- **Compare the two candidates.** If the explanation's translation and
  the raw translation agree, merge them into the final text directly.
  If they conflict, use the explanation to decide which one is closer
  to the real meaning, and start from that one.
- **A base is not a copy — but don't rewrite for its own sake.** Start
  from the best candidate, then fix only real defects: stiff
  word-by-word phrasing, English word order, broken tone. If a
  candidate already reads like a native writer and is faithful, use it
  as-is. Every needless rewrite is a chance to make the text worse.
  Faithfulness to the source beats any reference. If both candidates
  are wrong, drop them and translate yourself.
- **One sentence in, one sentence out.** Do not move content between
  sentences, do not merge or split ids.

Write a JSON file (e.g. `translations.json`) — start from an empty file
on a new translation run:

```json
{ "002": { "1": "你好，世界。", "2": "这是一个测试。" },
  "004": { "1": "## 一个标题" } }
```

Outer keys are block `code` strings; inner keys are sentence ids as
strings.

### 5. collect — assemble the bilingual file

```bash
npx tsx src/cli.ts collect input.md translations.json
```

```json
{ "ok": true, "output": "/path/to/input.bilingual.md" }
```

- Any missing sentence → exit 1 with a list `[{code, sentenceId}]`. No
  file is written. Fill the gaps and re-run.
- ⟦n⟧ placeholders in your translations are restored to the original
  content by code. You just keep them in place, per the standard.

### 6. verify — completeness check

```bash
npx tsx src/cli.ts verify input.md
npx tsx src/cli.ts verify input.md output.md my-translations.json   # non-default names
```

```json
{ "ok": true, "output": "/path/to/input.bilingual.md", "problems": [] }
```

- Exit 0 = pass. Exit 2 = `problems` is not empty: fix each item, go
  back to step 4 (only the affected sentences), then collect + verify
  again.
- Checks: passthrough blocks byte-for-byte, translatable originals in
  place, placeholder match per sentence.

## Debugging

- `chunk <input.md>`: chunk only, nothing saved — quick look at block
  structure.
- After an interrupt: just re-run the same step. Saved parts are reused.
- Start over: delete the `artifacts/` directory.

---

# Translation standard

Your task: translate the sentences of an English tech blog into
simplified Chinese. Output JSON.

## Faithfulness (top priority)

- Keep all facts, numbers, versions, dates, percentages, code
  identifiers, opinions, logic, and argument structure from the source.
- Never drop or add content. Every input id must have an output.
- If the source has an obvious typo, you may fix it in the translation.

## Sentence rules

- Translate sentence by sentence, one output id per input id. Joined in
  id order, the translations must read as one fluent text.
- Inside a sentence you may split a long English sentence or reorder
  clauses; between sentences you may add connective words.
- Do not move content from one sentence into another. Do not merge or
  split ids.
- Match register and tone: keep the original's casualness, emotional
  force, irony, and humor. Do not flatten them into neutral prose.

## Terms and names

- Use the accepted Chinese term for technical terms; if none exists,
  keep the English.
- Keep names of people, places, products, and companies in English.
- Never translate inline code, commands, file names, API names.

## Inline Markdown

- Keep markers: bold `**…**`, italic `*…*`, links `[text](url)`, inline
  code `` `…` ``, footnotes `[^1]`.
- Keep URLs, inline code, and footnote anchors unchanged. Translate link
  text: `[docs](https://x.com)` → `[文档](https://x.com)`.
- Keep list markers `- ` and quote markers `> ` as they are.

## Placeholders

- `⟦0⟧`-style placeholders stand for masked inline code, URLs, images,
  or ordered-list numbers. Keep them at the matching spot in the
  translation.
- Do not translate, rewrite, add, or drop them. Do not invent new ones.

## Notes (use with restraint)

- If the Doubao explanation gives key background the reader needs
  (jargon, metaphor, cultural reference), you may add a short
  `（注：xxx）` inside that sentence's translation.
- When not needed, add nothing. No stacked notes.

## Chinese typography

- Full-width punctuation: ，。：；？！. Ellipsis is ……; dash is ——.
- One space between Chinese and English words or numbers: 「使用 Node
  实现」「共 3 章」.
- Use curly quotes "" in Chinese text.
- One space between emphasis markers like `**加粗**` and Chinese text.

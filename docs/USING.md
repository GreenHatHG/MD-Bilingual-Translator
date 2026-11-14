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

### 2. doubao — fetch references per block (expensive, saved per sentence)

```bash
npx tsx src/cli.ts doubao input.md 002
```

```json
{ "code": "002", "cached": false,
  "refs": { "1": { "translation": "你好，世界。", "explanation": "……markdown notes" },
            "2": { "translation": "…", "explanation": "…" } } }
```

- Serial /translate + /explain calls. Each sentence is written to disk
  as soon as it arrives; a re-run only fetches missing sentences.
- If everything was already fetched, returns `cached: true` with no
  network calls.
- Service down / a sentence failed for good → exit 1. Fetched sentences
  are not lost.

### 3. Arbitrate — merge the final translations

For each block you get three inputs: the source sentence, the Doubao
translation (raw, word-by-word), and the Doubao explanation (full notes).

How to use the two Doubao results:

- **Read the explanation first.** It often contains Doubao's own
  polished translation (look for a "翻译" / "译文" section). That one is
  usually the best base: Doubao refined it against the context, so it
  beats the raw translation.
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

Write a JSON file (e.g. `translations.json`):

```json
{ "002": { "1": "你好，世界。", "2": "这是一个测试。" },
  "004": { "1": "## 一个标题" } }
```

Outer keys are block `code` strings; inner keys are sentence ids as
strings.

### 4. collect — assemble the bilingual file

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

### 5. verify — completeness check

```bash
npx tsx src/cli.ts verify input.md
```

```json
{ "ok": true, "output": "/path/to/input.bilingual.md", "problems": [] }
```

- Exit 0 = pass. Exit 2 = `problems` is not empty: fix each item, go
  back to step 3 (only the affected sentences), then collect + verify
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

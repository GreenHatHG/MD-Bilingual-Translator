# AGENTS.md — agent contract

This repo splits bilingual Markdown translation into mechanical steps
(code) and arbitration (you, the agent). You: call the subcommands, merge
translations, fix verification problems. You do NOT: write or edit the
output file directly.

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
translation, and the Doubao explanation. Follow `TRANSLATION_STANDARD.md`
(read it first — it is the only standard). Key points:

- If the explanation contains Doubao's own polished translation, it is
  usually better than the raw one — use it as the base. But whatever the
  base is, rewrite it to native-writer level. Faithfulness first.
- Write a JSON file (e.g. `translations.json`):

```json
{ "002": { "1": "你好，世界。", "2": "这是一个测试。" },
  "004": { "1": "## 一个标题" } }
```

- Outer keys are block `code` strings; inner keys are sentence ids as
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

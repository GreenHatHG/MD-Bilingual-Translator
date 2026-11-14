# MD-Bilingual-Translator

Translate an English blog post (Markdown) into a bilingual document:
original block, then a blank line, then the translated block.

This project is **not one auto-running pipeline**. The mechanical steps
(chunking, sentence split, Doubao calls, assembly, verification) are five
standalone CLI subcommands. An agent calls them step by step. Doubao gives
a translation and an explanation; the agent merges them into the final
translation, following `TRANSLATION_STANDARD.md`. Code checks the result
for missing content at the end.

## Architecture

```
input.md
  │
[code] split: remark splits the Markdown into blocks (paragraphs, headings,
  │    quotes and lists are translatable; code fences, frontmatter, HTML,
  │    tables pass through untouched) → ICU sentence split per line.
  │    Inline code / images / bare URLs are masked as ⟦n⟧ so periods
  │    inside them do not break the split. Result goes to
  │    artifacts/state.json.
  │
[code] doubao: for each sentence, serial calls to /translate + /explain.
  │    Doubao is a hard prerequisite — on failure the command exits with
  │    an error, no fallback. Each sentence is written to disk right
  │    after it arrives, so a re-run after an interrupt never re-fetches.
  │
[agent] arbitration: reads the source sentence + Doubao translation +
  │    full explanation + the translation standard, and writes the final
  │    translations as JSON.
  │
[code] collect: rejects the whole batch if one sentence is missing.
  │    Assembles the output by line structure. The original text area is
  │    always built by code from the source file, and the write is atomic.
  │    The agent never writes the output file.
  │
[code] verify: passthrough blocks byte-for-byte, originals in place,
  │    sentence-level placeholder check.
```

Core safety design: **the agent never writes any file**. The original text
area is always assembled by code from the source file. The agent only
supplies per-sentence translations; `collect` checks them and refuses to
proceed if any sentence is missing. No guessing, no filling gaps.

## Block model (why it looks like this)

- **Translatable block** (no suffix, `kind` = para/heading/quote/list):
  goes into the translation flow.
- **Passthrough block** (code has a `p` suffix): frontmatter, code fences,
  tables, etc. Copied into the output unchanged.
- **Blank block** (code has a `b` suffix): the blank lines between blocks,
  kept as separate blocks so spacing in the bilingual output stays correct.

Key property (covered by tests): join all block `raw` values in order and
you get back the normalized source file byte-for-byte. So the original
layout never gets lost, no matter how translations are inserted.

## Usage

```bash
npm install
cp .env.example .env        # default is http://127.0.0.1:8765, usually fine
```

Day-to-day translation is the agent's job (it follows `AGENTS.md`).
A manual run looks like this:

```bash
npx tsx src/cli.ts split   input.md
npx tsx src/cli.ts doubao  input.md 002        # Doubao refs for block 002
npx tsx src/cli.ts collect input.md translations.json
npx tsx src/cli.ts verify  input.md
```

Output goes next to the input: `<name>.bilingual.md`.

## Doubao service (prerequisite)

Doubao references come from a local HTTP service (the `doubao_server.js`
in the doubao_hook project):

```bash
node /Users/jooooody/Projects/doubao_hook/start_doubao.sh   # start Doubao with debug port
node /Users/jooooody/Projects/doubao_hook/lib/doubao_server.js
curl -s localhost:8765/health   # ok:true means ready
```

- If the service is down, commands **exit with a clear error. No fallback.**
  Doubao references are a hard prerequisite.
- Long text can take minutes upstream. Tune `DOUBAO_RETRIES` /
  `DOUBAO_TIMEOUT_MS` (see `.env.example`).
- Resume: references are written to disk per sentence in
  `artifacts/state.json`. A re-run only fetches the missing sentences.
  Delete `artifacts/` to start over.

## Tests

```bash
npm test        # markdown chunking + sentence split, 18 cases
npm run build   # tsc --noEmit
```

## Layout

| Path | Role |
|---|---|
| `src/cli.ts` | Five subcommands: chunk / split / doubao / collect / verify |
| `src/markdown.ts` | remark AST chunking, passthrough classes, blank-line gaps |
| `src/sentence.ts` | Per-line sentence split + ICU + placeholder mask/restore |
| `src/doubao.ts` | Doubao HTTP client (retries, then throw — no fallback) |
| `src/state.ts` | artifacts/state.json resume state |
| `src/env.ts` | .env parsing and config |
| `AGENTS.md` | Agent contract: command signatures, JSON shapes, hard rules |
| `TRANSLATION_STANDARD.md` | Translation standard the agent must follow |

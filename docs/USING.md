# USING.md — contract for agents translating with this repo

You drive the translation. You call the subcommands, merge translations,
fix verification problems. You do NOT write or edit the output file.

## Hard rules

- **Never create or edit `translations.json` yourself.** Only
  `arbitrate submit` writes it (the CLI validates and merges). You only
  write per-batch payload files.
- **Never create or edit `*.bilingual.md` yourself.** Only `collect`
  writes the output file.
- **Doubao references are a hard prerequisite.** If the service is down,
  commands exit with an error. Do not fall back to translating alone —
  start the service (see below). If it still fails, report it honestly.
  Never invent references.
- **Every sentence must be finalized.** `arbitrate submit` and `collect`
  both reject the batch if one sentence is missing, merged, or added.

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

Stdout is a compact block summary (codes + sentence counts); add `--full`
to include the sentences themselves.

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

```bash
npx tsx src/cli.ts terms input.md terms.json
```

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

### 4. arbitrate — the CLI drives, you translate one batch at a time

You never write or edit `translations.json`. The CLI owns that file;
you only submit payloads and it validates + merges. This is enforced by
exit codes, not by trust.

Loop until done:

```bash
npx tsx src/cli.ts arbitrate next input.md [--batch N]
```

- The CLI picks the batch (default 5 blocks, `--batch` capped at 10 —
  quality degrades past that). You do not choose blocks — ever.
  Translate only what's in `payload`.
- For each sentence in the payload: translate `text`, echo `ack`
  unchanged, and keep every `termHits` word form untranslated in
  `text`. One sentence in, one sentence out — do not merge, split, or
  move content between ids.
- Write a payload file `{"<code>": {"<sentenceId>": {"text": "…",
  "ack": "…"}}}` for exactly the batch you received, then run:

```bash
npx tsx src/cli.ts arbitrate submit <payload.json>
```

- Exit 0 = merged; the output's `next` field says what to run.
- Exit 2 = rejected with a per-sentence `problems` list; nothing is
  merged. Fix exactly those sentences and resubmit.

How to use the two Doubao results (this is the judgment part the CLI
cannot check):

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
  sentences, do not merge or split ids. (The CLI enforces this: ids
  must match the split exactly.)

### 5. collect — assemble the bilingual file

```bash
npx tsx src/cli.ts collect input.md translations.json
```

### 6. verify — completeness check

```bash
npx tsx src/cli.ts verify input.md
```

- Exit 2 = fix each reported problem, go back to step 4 (only the
  affected sentences), then collect + verify again.

## Debugging

- `chunk <input.md>`: chunk only, nothing saved — quick look at block
  structure.
- After an interrupt: just re-run the same step. Saved parts are reused.

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

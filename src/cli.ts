/**
 * CLI entry: six subcommands, called step by step by the agent. All stdout is JSON,
 * Human-readable logs go to stderr. Doubao unavailable → hard error exit (no fallback).
 *
 *   chunk   <input.md>                        chunk only, output block list
 *   split   <input.md> [--full]                  chunk + sentence split, persisted (deletes stale translations.json);
 *                                                stdout is a compact summary unless --full
 *   doubao  <input.md> [<codes>|-a]           fetch Doubao refs; -a/omitted = all translatable blocks
 *   terms   <input.md> <article-terms.json>  validate the user-confirmed list for THIS article
 *                                          (strict: unknown words → exit 2; global terms.json auto-loaded, exempt; writes artifacts/terms.json)
 *   arbitrate next <input.md> [--batch N]      print next batch to arbitrate (source + ack fingerprints; refs stay in artifacts/state.json); CLI picks the batch
 *   arbitrate submit <payload.json>            validate one payload batch and merge into translations.json (CLI-exclusive writer)
 *   collect <input.md> <translations.json>   assemble the bilingual file atomically (translations.json is maintained by arbitrate)
 *   verify  <input.md> [output.md] [translations.json]  completeness check of the output, JSON report
 *
 * Workflow: split → terms (propose list, user confirms) → doubao -a (serial, resumable)
 * → arbitrate next/submit loop (CLI picks batches, validates, exclusively writes
 * translations.json) → collect → verify; on failure fix per report and re-run collect.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename, relative } from "node:path";
import { loadConfig } from "./env.js";
import { splitIntoChunks, type Chunk } from "./markdown.js";
import { splitBlockIntoSentences } from "./sentence.js";
import { createDoubao } from "./doubao.js";
import { createTerms, pattern } from "./terms.js";
import { State, type BlockState } from "./state.js";
import { Terms } from "./terms.js";
import { ackOf, validateBlock, blockDone, type Submission } from "./arbitrate.js";

const cwd = process.cwd();
const cmd = process.argv[2];
const TRANSLATIONS_PATH = resolve(cwd, "translations.json");

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function readInput(inputArg: string | undefined): { path: string; source: string } {
  if (!inputArg) die("Missing <input.md> argument");
  const path = resolve(cwd, inputArg);
  if (!existsSync(path)) die(`Input file not found: ${path}`);
  return { path, source: readFileSync(path, "utf8") };
}

function out(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function chunksOf(inputPath: string): Chunk[] {
  return splitIntoChunks(readFileSync(inputPath, "utf8"));
}

/** terms word-shape matching (plurals/suffix variants, longest first) — same rules as the terms subcommand */
function patternOf(list: string[]): RegExp {
  return pattern(list);
}
/** Count of translatable blocks not yet fully arbitrated (some sentences missing) */
function remainingCount(chunks: Chunk[], state: State, translations: Record<string, Record<string, string>>): number {
  return chunks.filter((c) => {
    const b = state.getBlock(c.code);
    return b?.sentences?.length && !blockDone(translations, c.code, b.sentences);
  }).length;
}

/** submit uses this: reads the input path from state.json (agent need not pass input) */
function readInputState(): { path: string; source: string } {
  const state = new State(cwd);
  const name = state.all.inputFile;
  if (!name) die("state.json has no inputFile; run split first");
  // State written before the relative-path fix stored a bare filename; fall back to it.
  const resolved = resolve(cwd, name);
  if (existsSync(resolved)) return readInput(resolved);
  return readInput(name);
}

/** Terms for arbitration: global terms.json + confirmed article list (artifacts/terms.json) */
function unionTerms(): string[] {
  const global = createTerms(resolve(cwd, "terms.json"));
  const article = createTerms(resolve(cwd, "artifacts/terms.json"));
  return [...new Set([...global.load(), ...article.load()].filter((t) => t.trim()))];
}

// ---------- chunk ----------
if (cmd === "chunk") {
  const { path } = readInput(process.argv[3]);
  out(chunksOf(path).map((c) => ({ code: c.code, kind: c.kind, raw: c.raw })));
  process.exit(0);
}

// ---------- split ----------
if (cmd === "split") {
  const { path } = readInput(process.argv[3]);
  const chunks = chunksOf(path);
  const state = new State(cwd);
  // Store cwd-relative so later steps (e.g. arbitrate submit from the repo root) can re-resolve it.
  state.setInputFile(relative(cwd, path) || basename(path));
  // New article run: clear last run's finals so stale translations can never be reused.
  // Also clear the previous article's confirmed list; the new list is written at terms.
  // Deleted automatically — the agent never manages these files' lifecycle.
  if (existsSync(TRANSLATIONS_PATH)) unlinkSync(TRANSLATIONS_PATH);
  const ARTICLE_TERMS = resolve(cwd, "artifacts/terms.json");
  if (existsSync(ARTICLE_TERMS)) unlinkSync(ARTICLE_TERMS);
  const blocks: Array<{ code: string; kind: string; sentenceCount: number; sentences?: Array<{ id: number; text: string }> }> = [];
  const full = process.argv.slice(3).includes("--full");
  for (const c of chunks) {
    if (c.kind === "passthrough") continue;
    const { sentences } = splitBlockIntoSentences(c.raw);
    state.recordSentences(c.code, sentences);
    blocks.push(full ? { code: c.code, kind: c.kind, sentenceCount: sentences.length, sentences } : { code: c.code, kind: c.kind, sentenceCount: sentences.length });
  }
  out({
    inputFile: basename(path),
    blocks,
    note: "Sentences saved to artifacts/state.json; stdout omits them unless --full. code without suffix = translatable; p = passthrough (do not translate); b = blank lines (ignore). Sentence ids start at 1 and are continuous. Later steps refer to blocks by code. Next: terms",
  });
  process.exit(0);
}

// ---------- doubao ----------
if (cmd === "doubao") {
  const { path } = readInput(process.argv[3]);
  const rest = process.argv.slice(4);
  const state0 = new State(cwd);
  const allCodes = Object.keys(state0.all.blocks).filter((c) => state0.getBlock(c)?.sentences?.length);
  let codes: string[];
  if (rest.length === 0 || rest[0] === "-a") {
    codes = allCodes;
    if (codes.length === 0) die("No sentence records; run split first");
  } else {
    codes = rest;
  }
  const config = loadConfig(cwd);
  const doubao = createDoubao(config);
  if (!(await doubao.health())) {
    die(`Doubao service unavailable (${config.doubaoBaseUrl}). Prerequisite: ./start_doubao.sh then node lib/doubao_server.js`);
  }
  const state = new State(cwd);
  const failed: string[] = [];
  for (const code of codes) {
    const block = state.getBlock(code);
    if (!block?.sentences?.length) {
      console.error(`Skipping ${code}: no sentence records (run split first)`);
      continue;
    }
    if (block.refs && Object.keys(block.refs).length === block.sentences.length) {
      console.error(`[${code}] cached, skipping`);
      continue;
    }
    const refs: BlockState["refs"] = block.refs ?? {};
    for (const s of block.sentences) {
      if (refs[s.id]) continue; // already fetched, reuse
      process.stderr.write(`[${code}] sentence ${s.id}/${block.sentences.length} ...`);
      try {
        refs[s.id] = await doubao.reference(s.text);
      } catch (err) {
        // fetched sentences are already persisted; a re-run fetches only the missing ones
        process.stderr.write(" failed\n");
        console.error(String(err instanceof Error ? err.message : err));
        failed.push(code);
        break; // abort this block, move to the next
      }
      process.stderr.write(" done\n");
      state.recordRefs(code, refs); // persisted per sentence; interrupted runs never refetch
    }
  }
  if (failed.length > 0) die(`Doubao failed for blocks: ${failed.join(", ")}. Fetched sentences are already persisted; re-run to retry only the missing ones.`);
  out({ ok: true, blocks: codes.length, requested: codes, note: "Next: arbitrate next" });
  process.exit(0);
}

// ---------- terms ----------
if (cmd === "terms") {
  const { source } = readInput(process.argv[3]);
  const fileArg = process.argv[4];
  if (!fileArg) die("Missing <article-terms.json> argument (JSON string array of the user-confirmed list for THIS article)");
  const terms = createTerms(resolve(cwd, fileArg));
  const list = terms.load().filter((t) => t.trim());
  const globalList = terms.loadGlobal().filter((t) => t.trim());
  const { hits, missing } = terms.check(list, source);
  if (missing.length > 0) {
    console.error(JSON.stringify({
      ok: false,
      missing,
      note: "missing = article terms that never appear in the source (usually a typo). Remove them and resubmit, or re-confirm with the user. Global terms.json words are exempt.",
    }, null, 2));
    process.exit(2);
  }
  // Confirmed article list persisted for arbitrate (union with global terms.json); CLI-exclusive writer.
  mkdirSync(resolve(cwd, "artifacts"), { recursive: true });
  createTerms(resolve(cwd, "artifacts/terms.json")).save(list);
  const { hits: globalHits } = terms.check(globalList, source);
  out({
    ok: true,
    file: terms.file,
    count: list.length,
    globalCount: globalList.length,
    hits,
    globalHits,
    savedTo: "artifacts/terms.json",
    note: "Article terms confirmed. Next: doubao",
  });
  process.exit(0);
}

// ---------- arbitrate ----------
if (cmd === "arbitrate") {
  const sub = process.argv[3];

  if (sub === "next") {
    const { path } = readInput(process.argv[4]);
    const batchIdx = process.argv.indexOf("--batch");
    let batch = batchIdx > 0 ? Number(process.argv[batchIdx + 1]) : 5;
    if (!Number.isInteger(batch) || batch < 1) die("--batch must be a positive integer");
    if (batch > 10) die("--batch cap is 10 (quality degrades past that; see USING.md step 4)");

    const chunks = chunksOf(path).filter((c) => c.kind !== "passthrough");
    const state = new State(cwd);
    let translations0: Record<string, Record<string, string>>;
    try {
      translations0 = existsSync(TRANSLATIONS_PATH)
        ? (JSON.parse(readFileSync(TRANSLATIONS_PATH, "utf8")) as Record<string, Record<string, string>>)
        : {};
    } catch (err) {
      die(`translations.json is not valid JSON (it is maintained by arbitrate submit): ${err instanceof Error ? err.message : err}`);
    }
    const translations = translations0!;
    const termsList = unionTerms();
    const termRe = termsList.length > 0 ? patternOf(termsList) : null;

    const picked: string[] = [];
    const payload: Array<Record<string, unknown>> = [];
    for (const c of chunks) {
      if (picked.length >= batch) break;
      const block = state.getBlock(c.code);
      if (!block?.sentences?.length) continue;
      if (blockDone(translations, c.code, block.sentences)) continue;
      const missingRef = block.sentences.find((s) => !block.refs?.[s.id]);
      if (missingRef) die(`Block ${c.code} sentence ${missingRef.id} has no Doubao ref; run doubao ${c.code} first`);
      picked.push(c.code);
      payload.push({
        code: c.code,
        kind: c.kind,
        sentences: block.sentences.map((s) => ({
          id: s.id,
          text: s.text,
          ack: ackOf(block.refs![s.id]!.translation),
          termHits: termRe ? [...new Set([...s.text.matchAll(termRe)].map((m) => m[0].toLowerCase()))] : [],
        })),
      });
    }
    if (picked.length === 0) {
      out({ ok: true, done: true, message: "All blocks finalized. Next: collect" });
      process.exit(0);
    }
    out({
      ok: true,
      batch: picked,
      remainingBlocks: remainingCount(chunks, state, translations),
      instructions: 'Echo each ack unchanged; keep termHits words untranslated; one sentence in, one sentence out. Doubao refs are NOT inline — read them from artifacts/state.json blocks.<code>.refs.<id>. See USING.md step 4.',
      payload,
    });
    process.exit(0);
  }

  if (sub === "submit") {
    const fileArg = process.argv[4];
    if (!fileArg) die("Missing <payload.json> argument");
    let submission: Submission;
    try {
      submission = JSON.parse(readFileSync(resolve(cwd, fileArg), "utf8"));
    } catch (err) {
      die(`Payload is not valid JSON: ${err instanceof Error ? err.message : err}`);
    }
    const { path } = readInputState();
    const state = new State(cwd);
    let translations: Record<string, Record<string, string>>;
    try {
      translations = existsSync(TRANSLATIONS_PATH)
        ? (JSON.parse(readFileSync(TRANSLATIONS_PATH, "utf8")) as Record<string, Record<string, string>>)
        : {};
    } catch (err) {
      die(`translations.json is not valid JSON (it is maintained by arbitrate submit): ${err instanceof Error ? err.message : err}`);
    }
    const termsList = unionTerms();
    const chunks = chunksOf(path).filter((c) => c.kind !== "passthrough");
    const termRe = termsList.length > 0 ? patternOf(termsList) : null;

    const allProblems: Array<{ code: string; sentenceId: number; reason: string }> = [];
    for (const [code, sentMap] of Object.entries(submission)) {
      const block = state.getBlock(code);
      if (!block?.sentences?.length) {
        allProblems.push({ code, sentenceId: 0, reason: "Unknown block code (run split first; never invent codes)" });
        continue;
      }
      const termHits: Record<number, string[]> = {};
      if (termRe) {
        for (const s of block.sentences) {
          termHits[s.id] = [...new Set([...s.text.matchAll(termRe)].map((m) => m[0].toLowerCase()))];
        }
      }
      const problems = validateBlock({ code, sentences: block.sentences, refs: block.refs ?? {}, termHits, submitted: sentMap });
      for (const p of problems) allProblems.push({ code, ...p });
    }
    if (Object.keys(submission).length === 0) allProblems.push({ code: "", sentenceId: 0, reason: "Empty payload" });
    if (allProblems.length > 0) {
      console.error(JSON.stringify({ ok: false, problems: allProblems }, null, 2));
      process.exit(2);
    }
    // merge (CLI-exclusive writer of translations.json)
    for (const [code, sentMap] of Object.entries(submission)) {
      translations[code] = { ...translations[code] };
      for (const [id, sub2] of Object.entries(sentMap)) translations[code][id] = sub2.text;
    }
    writeFileSync(TRANSLATIONS_PATH, JSON.stringify(translations, null, 2) + "\n");
    const total = chunks.filter((c) => state.getBlock(c.code)?.sentences?.length).length;
    const done = total - remainingCount(chunks, state, translations);
    out({ ok: true, merged: Object.keys(submission), blocksDone: done, blocksTotal: total, next: done >= total ? "collect" : "arbitrate next" });
    process.exit(0);
  }

  die("Usage: arbitrate next <input.md> [--batch N] | arbitrate submit <payload.json>");
}

// ---------- collect ----------
if (cmd === "collect") {
  const { path } = readInput(process.argv[3]);
  const translationsArg = process.argv[4];
  if (!translationsArg) die("Missing <translations.json> argument ({blockCode: {sentenceId: translation}})");
  const given = JSON.parse(readFileSync(resolve(cwd, translationsArg), "utf8")) as Record<string, Record<string, string>>;
  const state = new State(cwd);
  const chunks = chunksOf(path);
  const missing: Array<{ code: string; sentenceId: number }> = [];

  for (const c of chunks) {
    if (c.kind === "passthrough") continue;
    const block = state.getBlock(c.code);
    if (!block?.sentences?.length) die(`Block ${c.code} has no sentence records; run split first`);
    const t = given[c.code] ?? {};
    for (const s of block.sentences) {
      if (!t[String(s.id)]?.trim()) missing.push({ code: c.code, sentenceId: s.id });
    }
  }
  if (missing.length > 0) {
    die(`Missing translations for ${missing.length} sentences: ${JSON.stringify(missing)}`);
  }

  // Assembly: the source side is always built by code from the source file; the
  // translation block is appended after each source block. Finals live only in
  // translations.json, never in state, so they can't be mistaken for a "done" cache.
  const outParts: string[] = [];
  for (const c of chunks) {
    if (c.kind === "passthrough") {
      outParts.push(c.raw);
      continue;
    }
    const block = state.getBlock(c.code)!;
    const t = (given[c.code] ?? {}) as Record<string, string>;
    const { lineIds, restore } = splitBlockIntoSentences(c.raw);
    const translationBlock = c.raw
      .split("\n")
      .map((_, i) => (lineIds[i] ?? []).map((id) => restore(t[String(id)]!).trim()).join(" "))
      .join("\n");
    outParts.push(c.raw, "\n\n", translationBlock);
  }
  if (!outParts.at(-1)?.endsWith("\n")) outParts.push("\n");

  const outputName = basename(path).replace(/\.md$/i, "") + ".bilingual.md";
  const outputPath = resolve(dirname(path), outputName);
  writeFileSync(outputPath + ".tmp", outParts.join(""));
  renameSync(outputPath + ".tmp", outputPath);
  out({ ok: true, output: outputPath });
  process.exit(0);
}

// ---------- verify ----------
if (cmd === "verify") {
  const { path } = readInput(process.argv[3]);
  const outputArg = process.argv[4];
  const outputName = outputArg
    ? basename(resolve(cwd, outputArg))
    : basename(path).replace(/\.md$/i, "") + ".bilingual.md";
  const outputPath = resolve(dirname(path), outputName);
  if (!existsSync(outputPath)) die(`Output file not found: ${outputPath}`);

  const output = readFileSync(outputPath, "utf8");
  const chunks = chunksOf(path);
  const state = new State(cwd);
  // Translations are checked from translations.json (state never holds finals)
  const trFile = process.argv[5] ?? "translations.json";
  const trPath = resolve(cwd, trFile);
  if (!existsSync(trPath)) die(`Translations file not found: ${trPath}`);
  let outputTranslations: Record<string, Record<string, string>>;
  try {
    outputTranslations = JSON.parse(readFileSync(trPath, "utf8"));
  } catch (err) {
    die(`Translations file is not valid JSON: ${trPath} — ${err instanceof Error ? err.message : err}`);
  }
  const problems: string[] = [];

  // 1. Passthrough blocks appear byte-for-byte in the output
  for (const c of chunks) {
    if (c.kind === "passthrough" && c.raw.trim() && !output.includes(c.raw)) {
      problems.push(`Passthrough block missing or altered: ${c.code}`);
    }
  }
  // 2. Each translatable block: source + translation both present, sentence count matches, placeholders intact
  for (const c of chunks) {
    if (c.kind === "passthrough") continue;
    if (!output.includes(c.raw)) problems.push(`Source block missing from output: ${c.code}`);
    const block = state.getBlock(c.code);
    if (!block?.sentences) continue;
    const { sentences } = splitBlockIntoSentences(c.raw);
    for (const s of sentences) {
      const t = (outputTranslations[c.code] ?? {})[String(s.id)];
      if (!t) { problems.push(`${c.code} sentence ${s.id}: no translation`); continue; }
      // Placeholder reconciliation: every ⟦n⟧ in the source must appear in the translation
      const srcPh = (s.text.match(/⟦\d+⟧/g) ?? []).sort();
      const dstPh = (t.match(/⟦\d+⟧/g) ?? []).sort();
      if (srcPh.join() !== dstPh.join()) {
        problems.push(`${c.code} sentence ${s.id} placeholder mismatch: source ${srcPh.join("")} translation ${dstPh.join("")}`);
      }
    }
  }
  out({ ok: problems.length === 0, output: outputPath, problems });
  process.exit(problems.length === 0 ? 0 : 2);
}

die(`Unknown command: ${cmd}. Available: chunk | split | doubao | terms | arbitrate next/submit | collect | verify`);

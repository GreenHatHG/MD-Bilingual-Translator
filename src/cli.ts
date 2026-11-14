/**
 * CLI 入口：五个独立子命令，供 agent 逐步调用。所有输出为 JSON（stdout），
 * 人读日志走 stderr。豆包不可用 → 明确报错退出（不降级）。
 *
 *   chunk   <input.md>                        切块，输出块列表
 *   split   <input.md>                        切块 + 全部可译块拆句，落盘
 *   doubao  <input.md> <blockCode>            取某块逐句豆包参考（串行），落盘
 *   collect <input.md> <translations.json>   收 agent 译文 → 原子拼装双语文件
 *   verify  <input.md> [output.md]            校验输出完整性，JSON 报告
 *
 * agent 工作流：split → 对每个块 doubao → agent 参考豆包+TRANSLATION_STANDARD.md
 * 自己定稿 → collect → verify，失败按报告修复后重跑 collect。
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { loadConfig } from "./env.js";
import { splitIntoChunks, type Chunk } from "./markdown.js";
import { splitBlockIntoSentences } from "./sentence.js";
import { createDoubao } from "./doubao.js";
import { State, type BlockState } from "./state.js";

const cwd = process.cwd();
const cmd = process.argv[2];

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function readInput(inputArg: string | undefined): { path: string; source: string } {
  if (!inputArg) die("缺少 <input.md> 参数");
  const path = resolve(cwd, inputArg);
  if (!existsSync(path)) die(`输入文件不存在: ${path}`);
  return { path, source: readFileSync(path, "utf8") };
}

function out(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function chunksOf(inputPath: string): Chunk[] {
  return splitIntoChunks(readFileSync(inputPath, "utf8"));
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
  state.setInputFile(basename(path));
  const blocks: Array<{ code: string; kind: string; sentenceCount: number; sentences: Array<{ id: number; text: string }> }> = [];
  for (const c of chunks) {
    if (c.kind === "passthrough") continue;
    const { sentences } = splitBlockIntoSentences(c.raw);
    state.recordSentences(c.code, sentences);
    blocks.push({ code: c.code, kind: c.kind, sentenceCount: sentences.length, sentences });
  }
  out({ inputFile: basename(path), blocks });
  process.exit(0);
}

// ---------- doubao ----------
if (cmd === "doubao") {
  const { path } = readInput(process.argv[3]);
  const code = process.argv[4];
  if (!code) die("缺少 <blockCode> 参数");
  const config = loadConfig(cwd);
  const doubao = createDoubao(config);
  if (!(await doubao.health())) {
    die(`豆包服务不可用（${config.doubaoBaseUrl}）。前置：./start_doubao.sh 后 node lib/doubao_server.js`);
  }
  const state = new State(cwd);
  const block = state.getBlock(code);
  if (!block?.sentences?.length) die(`块 ${code} 无拆句记录，先跑 split`);
  if (block.refs && Object.keys(block.refs).length === block.sentences.length) {
    out({ code, cached: true, refs: block.refs });
    process.exit(0);
  }
  const refs: BlockState["refs"] = block.refs ?? {};
  for (const s of block.sentences) {
    if (refs[s.id]) continue; // 已取过的句子直接复用
    process.stderr.write(`[${code}] 句 ${s.id}/${block.sentences.length} ...`);
    try {
      refs[s.id] = await doubao.reference(s.text);
    } catch (err) {
      // 已取回的句子已逐句落盘，重跑只补缺的句子
      process.stderr.write(` failed\n`);
      die(String(err instanceof Error ? err.message : err));
    }
    process.stderr.write(" done\n");
    state.recordRefs(code, refs); // 每句落盘，中断不重取
  }
  out({ code, cached: false, refs });
  process.exit(0);
}

// ---------- collect ----------
if (cmd === "collect") {
  const { path } = readInput(process.argv[3]);
  const translationsArg = process.argv[4];
  if (!translationsArg) die("缺少 <translations.json> 参数（{blockCode: {sentenceId: 译文}}）");
  const given = JSON.parse(readFileSync(resolve(cwd, translationsArg), "utf8")) as Record<string, Record<string, string>>;
  const state = new State(cwd);
  const chunks = chunksOf(path);
  const missing: Array<{ code: string; sentenceId: number }> = [];

  for (const c of chunks) {
    if (c.kind === "passthrough") continue;
    const block = state.getBlock(c.code);
    if (!block?.sentences?.length) die(`块 ${c.code} 无拆句记录，先跑 split`);
    const t = given[c.code] ?? {};
    for (const s of block.sentences) {
      if (!t[String(s.id)]?.trim()) missing.push({ code: c.code, sentenceId: s.id });
    }
  }
  if (missing.length > 0) {
    die(`缺译文 ${missing.length} 句: ${JSON.stringify(missing)}`);
  }

  // 记录 + 拼装：原文区永远由代码从源文件拼装，译文块追加在原块之后
  const outParts: string[] = [];
  for (const c of chunks) {
    if (c.kind === "passthrough") {
      outParts.push(c.raw);
      continue;
    }
    const block = state.getBlock(c.code)!;
    const t = (given[c.code] ?? {}) as Record<string, string>;
    state.recordTranslations(c.code, t as unknown as Record<number, string>);
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
  if (!existsSync(outputPath)) die(`输出文件不存在: ${outputPath}`);

  const output = readFileSync(outputPath, "utf8");
  const chunks = chunksOf(path);
  const state = new State(cwd);
  const problems: string[] = [];

  // 1. 直通块字节级原样出现在输出中
  for (const c of chunks) {
    if (c.kind === "passthrough" && c.raw.trim() && !output.includes(c.raw)) {
      problems.push(`直通块缺失或被改动: ${c.code}`);
    }
  }
  // 2. 每个可译块：原块 + 译文块都在输出中，句子数一致，占位符完整
  for (const c of chunks) {
    if (c.kind === "passthrough") continue;
    if (!output.includes(c.raw)) problems.push(`原文块缺失: ${c.code}`);
    const block = state.getBlock(c.code);
    if (!block?.sentences) continue;
    const { sentences } = splitBlockIntoSentences(c.raw);
    const trans = block.translations ?? {};
    for (const s of sentences) {
      const t = trans[s.id];
      if (!t) { problems.push(`${c.code} 句 ${s.id} 无译文`); continue; }
      // 占位符对账：原文里的 ⟦n⟧ 必须出现在译文中
      const srcPh = (s.text.match(/⟦\d+⟧/g) ?? []).sort();
      const dstPh = (t.match(/⟦\d+⟧/g) ?? []).sort();
      if (srcPh.join() !== dstPh.join()) {
        problems.push(`${c.code} 句 ${s.id} 占位符不匹配: 原 ${srcPh.join("")} 译 ${dstPh.join("")}`);
      }
    }
  }
  out({ ok: problems.length === 0, output: outputPath, problems });
  process.exit(problems.length === 0 ? 0 : 2);
}

die(`未知命令: ${cmd}。可用: chunk | split | doubao | collect | verify`);

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { chat } from "./llm.js";
import { buildTranslationPrompt, type SentenceRef } from "./prompt.js";
import type { DoubaoClient } from "./doubao.js";
import type { Block } from "./markdown.js";
import { splitBlockIntoSentences } from "./sentence.js";
import type { ManifestApi } from "./manifest.js";
import type { Config } from "./env.js";

const STANDARD = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../TRANSLATION_STANDARD.md"),
  "utf8",
);

/** 块翻译结果：译文行（可能带兜底标记），以及统计 */
export interface BlockResult {
  translationBlock: string;
  sentenceCount: number;
  /** 豆包译文（translate）成功的句子数，即兜底时可用豆包译文的句子数；explain 失败不计入 */
  doubaoTranslateOk: number;
  fallback: Array<{ sentence: string; reason: string }>;
}

/** 翻译一个可译块：拆句 → 豆包参考 → LLM 综合定稿 → id 对账 */
export async function translateBlock(
  block: Block,
  doubao: DoubaoClient,
  config: Config,
  m: ManifestApi,
  blockLabel: string,
): Promise<BlockResult> {
  // ---- 拆句（纯代码，按行 + ICU）----
  const { sentences, lineIds, restore } = splitBlockIntoSentences(block.raw);
  m.recordSentences(block.code, sentences);

  // ---- 豆包参考（串行，失败记 null，不阻塞）----
  const refs: SentenceRef[] = [];
  let doubaoTranslateOk = 0;
  for (const s of sentences) {
    // 翻译与解释相互独立：各自失败记 null，互不阻塞
    const tr = await doubao.translate(s.text);
    const ex = await doubao.explain(s.text);
    if (tr !== null) doubaoTranslateOk++;
    refs.push({ id: s.id, source: s.text, doubaoTr: tr, doubaoEx: ex });
    m.recordDoubao(block.code, s.id, tr, ex);
  }

  // ---- LLM 综合定稿 ----
  const user = buildTranslationPrompt(block.raw, refs);
  const fallback: Array<{ sentence: string; reason: string }> = [];
  let translations = new Map<number, string>();
  let llmOk = false;
  try {
    const raw = await chat(config, [
      { role: "system", content: STANDARD },
      { role: "user", content: user },
    ]);
    const parsed = parseJsonArray(raw);
    translations = new Map(
      parsed
        .filter((e) => Number.isInteger(e?.id))
        .map((e) => [e.id as number, String(e.translation ?? "")]),
    );
    llmOk = true;
  } catch (err) {
    console.error(`  [LLM] ${blockLabel} 调用失败: ${err instanceof Error ? err.message : err}`);
  }

  // ---- id 对账 + 三级兜底（LLM 译文 → 豆包译文 → 原文 + TODO）----
  const finalById = new Map<number, string>();
  for (const s of sentences) {
    const t = translations.get(s.id);
    const doubaoTr = refs.find((r) => r.id === s.id)?.doubaoTr ?? null;
    if (llmOk && typeof t === "string" && t.trim()) {
      finalById.set(s.id, restore(t.trim()));
    } else if (doubaoTr) {
      finalById.set(s.id, restore(doubaoTr));
      const reason = llmOk ? "LLM 漏译该句" : "LLM 调用失败";
      fallback.push({ sentence: s.text, reason: `${reason}，采用豆包译文` });
      m.recordFallback(block.code, s.id, reason);
    } else {
      finalById.set(s.id, `${s.text} <!-- TODO: 翻译失败，待人工处理 -->`);
      const reason = llmOk ? "LLM 漏译该句且豆包失败" : "LLM 调用失败且豆包失败";
      fallback.push({ sentence: s.text, reason });
      m.recordFallback(block.code, s.id, reason);
    }
  }

  // 按原文行结构重组：每行 = 该行句子译文空格连接，Markdown 渲染与原文一致
  const translationBlock = block.raw
    .split("\n")
    .map((rawLine, i) => {
      const ids = lineIds[i] ?? [];
      if (ids.length === 0) return "";
      return ids.map((id) => finalById.get(id) ?? "").join(" ");
    })
    .join("\n");
  m.recordTranslation(block.code, translationBlock);

  return { translationBlock, sentenceCount: sentences.length, doubaoTranslateOk, fallback };
}

/** 从 LLM 回复中提取 JSON 数组（容忍 markdown 代码围栏与前后杂讯） */
function parseJsonArray(raw: string): Array<{ id?: number; translation?: unknown }> {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("响应中未找到 JSON 数组");
  }
  const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("JSON 不是数组");
  return parsed as Array<{ id?: number; translation?: unknown }>;
}

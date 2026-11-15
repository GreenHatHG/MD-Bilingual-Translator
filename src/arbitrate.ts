/**
 * arbitrate 步骤的纯校验逻辑（CLI 负责 I/O，这里不碰文件系统）。
 *
 * 目标：把 USING.md 里的纪律变成退出码——
 *   - 每次只提交 CLI 指定的块（ids 必须与 state 完全一致，多/少/拼错都拒绝）
 *   - ack 前缀匹配：提交里必须回显 CLI 打印的豆包参考指纹，没读参考就交不上
 *   - terms 词必须原样保留在译文中
 *   - ⟦n⟧ 占位符逐句对账
 */
import { createHash } from "node:crypto";
import type { Sentence } from "./sentence.js";
import type { DoubaoResult } from "./doubao.js";

/** Echo fingerprint length (first 8 hex of sha256 of the Doubao raw translation) */
export const ACK_LEN = 8;

export function ackOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, ACK_LEN);
}

export interface SubmittedSentence {
  text: string;
  ack: string;
}

/** 提交载荷：{ "042": { "1": { text, ack } } }（句子 id 用字符串键） */
export type Submission = Record<string, Record<string, SubmittedSentence>>;

export interface BlockCheck {
  code: string;
  sentences: Sentence[];
  refs: Record<number, DoubaoResult>;
  /** 句子 id → 该句源文命中的 terms 词形（小写） */
  termHits: Record<number, string[]>;
  submitted: Record<string, SubmittedSentence>;
}

export function validateBlock(input: BlockCheck): Array<{ sentenceId: number; reason: string }> {
  const problems: Array<{ sentenceId: number; reason: string }> = [];
  const given = input.submitted ?? {};

  // ids 必须与拆句结果完全一致
  const want = input.sentences.map((s) => String(s.id)).sort();
  const got = Object.keys(given).sort();
  if (want.join() !== got.join()) {
    problems.push({
      sentenceId: 0,
      reason: `Sentence ids mismatch: expected [${want.join(", ")}] got [${got.join(", ")}] (one sentence in, one sentence out — never add, drop, or merge)`,
    });
    return problems;
  }

  for (const s of input.sentences) {
    const sub = given[String(s.id)];
    if (!sub?.text?.trim()) {
      problems.push({ sentenceId: s.id, reason: "Empty translation" });
      continue;
    }
    // ack 必须与该句豆包参考的指纹一致 —— 没读参考就给不出 ack
    const ref = input.refs[s.id];
    if (!ref) {
      problems.push({ sentenceId: s.id, reason: "No Doubao ref for this sentence; run doubao first" });
      continue;
    }
    if (sub.ack !== ackOf(ref.translation)) {
      problems.push({ sentenceId: s.id, reason: `ack mismatch (${sub.ack || "empty"}) — read artifacts/state.json blocks.${input.code}.refs.${s.id} first, then finalize` });
    }
    // terms 命中必须原样保留
    for (const hit of input.termHits[s.id] ?? []) {
      const re = new RegExp(`(?<![\\w-])${hit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
      if (!re.test(sub.text)) {
        problems.push({ sentenceId: s.id, reason: `terms.json word not kept in English: ${hit}` });
      }
    }
    // 占位符对账
    const srcPh = (s.text.match(/⟦\d+⟧/g) ?? []).sort().join();
    const dstPh = (sub.text.match(/⟦\d+⟧/g) ?? []).sort().join();
    if (srcPh !== dstPh) {
      problems.push({ sentenceId: s.id, reason: `Placeholder mismatch: source ${srcPh || "none"} translation ${dstPh || "none"}` });
    }
  }
  return problems;
}

/** 一个块是否已全部定稿（存在且逐句非空） */
export function blockDone(translations: Record<string, Record<string, string>>, code: string, sentences: Sentence[]): boolean {
  const t = translations[code];
  if (!t) return false;
  return sentences.every((s) => t[String(s.id)]?.trim());
}

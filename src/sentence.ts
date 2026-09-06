export interface Sentence {
  id: number;
  text: string;
}

export interface BlockSentences {
  sentences: Sentence[];
  /**
   * 每一行包含的句子 id（与块内行一一对应）。
   *
   * 二维数组：外层 = 块的每一行（lineIds.length === raw.split("\n").length，
   * 与行号 i 直接对应）；内层 = 该行拆出的句子 id 列表，一行可含多句，
   * 空行/纯空白行对应空数组 []（占住行号，保证行结构不塌）。
   *
   * 例："One. Two.\n\n- item" → [[1,2],[],[3]]
   *
   * 存在的意义：Markdown 行结构（段落间距、列表/引用行边界）全在换行上，
   * 译文必须按行重组才不会破坏渲染；pipeline 靠它把每行的各句译文
   * 用空格拼接回一行。句子 id 从 1 起，跨行连续递增。
   */
  lineIds: number[][];
  /** 把 LLM 译文里的 ⟦n⟧ 占位符还原为原始内容（URL / 行内代码 / 图片 / 列表序号） */
  restore: (text: string) => string;
}

const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const PLACEHOLDER = /⟦\s*(\d+)\s*⟧/g;

/**
 * 按行拆句（纯代码，零 LLM）：
 * - 每行独立拆句，行内用 ICU（Intl.Segmenter）分句；行间天然隔离，
 *   列表项、引用行、软换行段落都不会跨行粘连。
 * - 拆分前行内代码、图片、裸 URL、行首有序列表序号替换为 ⟦n⟧ 占位符，
 *   防止其中的句点/序号被误切；restore 负责还原。
 * - 单行内的句子拼接时用空格连接；译文块按行重组，Markdown 渲染与原文一致。
 */
export function splitBlockIntoSentences(raw: string): BlockSentences {
  const stash: string[] = [];
  const sentences: Sentence[] = [];
  const lineIds: number[][] = [];
  let nextId = 1;

  for (const line of raw.split("\n")) {
    const ids: number[] = [];
    const masked = mask(line, stash);
    const parts: string[] = [];
    for (const s of segmenter.segment(masked)) parts.push(s.segment);

    // 合并被切散的碎片（缩写尾点、孤立标点等）
    const merged: string[] = [];
    for (const part of parts) {
      const prev = merged[merged.length - 1];
      if (prev !== undefined && isFragment(part)) {
        merged[merged.length - 1] = prev + part;
      } else {
        merged.push(part);
      }
    }

    for (const part of merged) {
      const text = unmask(part, stash);
      if (!text.trim()) continue;
      const id = nextId++;
      sentences.push({ id, text });
      ids.push(id);
    }
    lineIds.push(ids);
  }

  return {
    sentences,
    lineIds,
    restore: (t: string) => unmask(t, stash),
  };
}

function mask(text: string, stash: string[]): string {
  const take = (m: string) => `⟦${stash.push(m) - 1}⟧`;
  return text
    .replace(/`[^`\n]+`/g, take) // 行内代码
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, take) // 图片 ![alt](url)
    .replace(/https?:\/\/[^\s)\]<>"]*[^\s)\]<>".,;:!?)\]]/g, take) // 裸 URL，排除句尾标点
    .replace(/^(\s*)(\d{1,3}|[a-zA-Z])[.)](\s+)/, (m) => take(m)); // 行首有序列表序号
}

function unmask(text: string, stash: string[]): string {
  return text.replace(PLACEHOLDER, (_, i) => stash[Number(i)] ?? "");
}

function isFragment(part: string): boolean {
  const t = part.trim();
  if (t.length <= 2) return true;
  return /^[)\]>,.;:!?…"'”’\s]+$/.test(t);
}

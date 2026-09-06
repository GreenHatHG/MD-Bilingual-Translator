import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import { unified } from "unified";

/** 可翻译块：送入拆句 → 豆包 → LLM 流程 */
export interface Block {
  kind: "para" | "heading" | "quote" | "list";
  code: string;
  raw: string;
}

/**
 * 直通块：不翻译、原样进输出。code 后缀 p = 内容块本身
 * （frontmatter/代码块/表格/HTML 等），b = 块间空行（blank）。
 * 空行独立成块是为了拼双语输出时块距不会算乱，
 * 详见 README「切块模型」。
 */
export interface Passthrough {
  kind: "passthrough";
  code: string;
  raw: string;
}

export type Chunk = Block | Passthrough;

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter);

const TRANSLATABLE = new Set(["paragraph", "heading", "blockquote", "list"]);
const KIND: Record<string, Block["kind"]> = {
  paragraph: "para",
  heading: "heading",
  blockquote: "quote",
  list: "list",
};

/**
 * 把 markdown 源文本切成有序块序列。
 * 只取 AST 顶层节点：段落/标题/引用/列表可翻译；代码块、frontmatter、
 * HTML、表格、脚注定义、链接定义、分隔线等一律直通。
 * 块间空行作为 passthrough 保留，保证重排后字节级还原原文。
 */
export function splitIntoChunks(md: string): Chunk[] {
  const normalized = md.replace(/\r\n?/g, "\n");
  const tree = parser.parse(normalized);
  const chunks: Chunk[] = [];
  let index = 0;
  let cursor = 0;

  const pad = (n: number) => String(n).padStart(3, "0");

  const emitGap = (gap: string) => {
    if (!gap) return;
    chunks.push({ kind: "passthrough", code: `${pad(index)}b`, raw: gap });
    index++;
  };

  for (const node of tree.children) {
    const pos = node.position;
    if (!pos || pos.start.offset === undefined || pos.end.offset === undefined) continue;
    const start = pos.start.offset;
    const end = pos.end.offset;
    if (start > cursor) emitGap(normalized.slice(cursor, start));
    const raw = normalized.slice(start, end);
    if (TRANSLATABLE.has(node.type)) {
      chunks.push({ kind: KIND[node.type] ?? "passthrough", code: pad(index), raw });
    } else {
      chunks.push({ kind: "passthrough", code: `${pad(index)}p`, raw });
    }
    index++;
    cursor = end;
  }
  if (cursor < normalized.length) emitGap(normalized.slice(cursor));
  return chunks;
}

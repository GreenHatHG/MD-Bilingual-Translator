import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Sentence } from "./sentence.js";
import type { DoubaoResult } from "./doubao.js";

/**
 * 断点续跑状态目录（artifacts/）：豆包参考是最贵的一步（解释可达数分钟/句），
 * 每句取回后立刻落盘，中断重跑直接复用。纯 JSON 文件，agent 也能直接读。
 *
 * 结构：
 *   artifacts/state.json                     —— 全局：输入文件、按 code 升序的块数组（含拆句与豆包参考）
 */
export interface BlockState {
  sentences?: Sentence[];
  /** 句子 id → 豆包参考（translation + explanation）。终稿译文不入 state，只存 translations.json */
  refs?: Record<number, DoubaoResult>;
}

export interface BlockEntry extends BlockState {
  code: string;
}

export interface GlobalState {
  inputFile?: string;
  /** 按 code 升序的数组。必须用数组：对象键会被 JSON.stringify 重排（整数键前置），
   *  导致 "100".."132" 排到 "000".."098" 前面，agent 顺序读取时拿到错位的块。 */
  blocks: BlockEntry[];
}

const STATE_DIR = "artifacts";

/** Numeric code order ("002" < "100" < "1000"); parseInt handles the p/b suffixes ("010p" → 10).
 *  localeCompare would misorder 4-digit codes ("1000" < "999") — that IS the bug this file fixes. */
function codeOrder(a: string, b: string): number {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  if (na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

export class State {
  readonly dir: string;
  private global: GlobalState;
  private byCode: Map<string, BlockEntry>;

  /** 全局状态只读快照（块 code → 拆句/参考/译文） */
  get all(): GlobalState {
    return this.global;
  }

  constructor(cwd: string) {
    this.dir = resolve(cwd, STATE_DIR);
    mkdirSync(this.dir, { recursive: true });
    const path = resolve(this.dir, "state.json");
    this.global = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : { blocks: [] };
    if (!Array.isArray(this.global.blocks)) {
      // 旧格式（Record<string, BlockState>）：转成按 code 升序的数组，下次 flush 落盘
      this.global.blocks = Object.entries(this.global.blocks as Record<string, BlockState>)
        .map(([code, b]) => ({ code, ...b }))
        .sort((a, b) => codeOrder(a.code, b.code));
    }
    this.byCode = new Map(this.global.blocks.map((b) => [b.code, b]));
  }

  private flushGlobal() {
    this.global.blocks.sort((a, b) => codeOrder(a.code, b.code));
    writeFileSync(resolve(this.dir, "state.json"), JSON.stringify(this.global, null, 2));
  }

  setInputFile(name: string) {
    this.global.inputFile = name;
    this.flushGlobal();
  }

  /** 记录拆句结果（split 步骤） */
  recordSentences(code: string, sentences: Sentence[]) {
    const entry = this.ensureEntry(code);
    entry.sentences = sentences;
    this.flushGlobal();
  }

  getBlock(code: string): BlockState | undefined {
    return this.byCode.get(code);
  }

  /** 记录豆包参考（doubao 步骤）；每句落盘，中断后不重取 */
  recordRefs(code: string, refs: Record<number, DoubaoResult>) {
    const entry = this.ensureEntry(code);
    entry.refs = refs;
    this.flushGlobal();
  }

  private ensureEntry(code: string): BlockEntry {
    let entry = this.byCode.get(code);
    if (!entry) {
      entry = { code };
      this.global.blocks.push(entry);
      this.byCode.set(code, entry);
    }
    return entry;
  }

}

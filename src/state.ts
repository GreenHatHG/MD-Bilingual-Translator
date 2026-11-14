import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Sentence } from "./sentence.js";
import type { DoubaoResult } from "./doubao.js";

/**
 * 断点续跑状态目录（artifacts/）：豆包参考是最贵的一步（解释可达数分钟/句），
 * 每句取回后立刻落盘，中断重跑直接复用。纯 JSON 文件，一个块一个文件，
 * agent 也能直接读。
 *
 * 结构：
 *   artifacts/state.json                     —— 全局：输入文件、拆句结果
 *   artifacts/blocks/<code>.json             —— 每块的豆包参考与最终译文
 */
export interface BlockState {
  sentences?: Sentence[];
  /** 句子 id → 豆包参考（translation + explanation） */
  refs?: Record<number, DoubaoResult>;
  /** 句子 id → agent 定稿译文（restore 后的原文文本） */
  translations?: Record<number, string>;
}

export interface GlobalState {
  inputFile?: string;
  blocks: Record<string, BlockState>;
}

const STATE_DIR = "artifacts";

export class State {
  readonly dir: string;
  private global: GlobalState;

  constructor(cwd: string) {
    this.dir = resolve(cwd, STATE_DIR);
    mkdirSync(this.dir, { recursive: true });
    const path = resolve(this.dir, "state.json");
    this.global = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : { blocks: {} };
  }

  private flushGlobal() {
    writeFileSync(resolve(this.dir, "state.json"), JSON.stringify(this.global, null, 2));
  }

  setInputFile(name: string) {
    this.global.inputFile = name;
    this.flushGlobal();
  }

  /** 记录拆句结果（split 步骤） */
  recordSentences(code: string, sentences: Sentence[]) {
    this.global.blocks[code] = { ...this.global.blocks[code], sentences };
    this.flushGlobal();
  }

  getBlock(code: string): BlockState | undefined {
    return this.global.blocks[code];
  }

  /** 记录豆包参考（doubao 步骤）；每句落盘，中断后不重取 */
  recordRefs(code: string, refs: Record<number, DoubaoResult>) {
    this.global.blocks[code] = { ...this.global.blocks[code], refs };
    this.flushGlobal();
  }

  /** 记录 agent 定稿译文（collect 步骤） */
  recordTranslations(code: string, translations: Record<number, string>) {
    this.global.blocks[code] = { ...this.global.blocks[code], translations };
    this.flushGlobal();
  }

}

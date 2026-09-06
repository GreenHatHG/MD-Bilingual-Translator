import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Sentence } from "./sentence.js";

/**
 * 断点续跑状态文件（artifacts/manifest.json）。
 * 只记录事实：拆句、豆包结果、块译文、兜底。每步写盘，中断重跑跳过已完成块。
 */
export interface Manifest {
  inputFile?: string;
  blocks: Record<
    string,
    {
      done: boolean;
      sentences?: Sentence[];
      doubao?: Record<string, { tr: string | null; ex: string | null }>;
      translation?: string;
      fallback?: Array<{ sentenceId: number; reason: string }>;
    }
  >;
}

export function createManifest(cwd: string) {
  const dir = resolve(cwd, "artifacts");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, "manifest.json");
  const manifest: Manifest = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { blocks: {} };

  const flush = () => writeFileSync(path, JSON.stringify(manifest, null, 2));

  const api = {
    manifest,
    save: flush,
    recordSentences(code: string, sentences: Sentence[]) {
      manifest.blocks[code] ??= { done: false };
      manifest.blocks[code].sentences = sentences;
      flush();
    },
    recordDoubao(code: string, id: number, tr: string | null, ex: string | null) {
      const b = manifest.blocks[code];
      if (!b) return;
      b.doubao ??= {};
      b.doubao[String(id)] = { tr, ex };
      flush();
    },
    recordTranslation(code: string, translation: string) {
      manifest.blocks[code] ??= { done: false };
      manifest.blocks[code].translation = translation;
      flush();
    },
    recordFallback(code: string, sentenceId: number, reason: string) {
      const b = manifest.blocks[code];
      if (!b) return;
      b.fallback ??= [];
      b.fallback.push({ sentenceId, reason });
      flush();
    },
    finishBlock(code: string) {
      manifest.blocks[code] ??= { done: false };
      manifest.blocks[code].done = true;
      flush();
    },
  };
  return api;
}

export type ManifestApi = ReturnType<typeof createManifest>;

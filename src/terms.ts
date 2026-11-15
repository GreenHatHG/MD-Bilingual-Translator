import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 「原文保留词」清单（terms.json，用户确认后生效）：翻译时这些单词/短语
 * 直接保留英文原文，不意译（如 subagent、context window）。跨翻译任务
 * 持久维护，越用越全。纯词形匹配（大小写不敏感、复数/常见后缀兼容），
 * 短语按词序列匹配，命中处原样替换回原文。
 */
export interface Terms {
  readonly file: string;
  load(): string[];
  save(list: string[]): void;
  /** 每个词在源文中的出现情况；missing = 词单里有但文章没有（拼写错误提醒） */
  check(list: string[], source: string): { hits: Record<string, number>; missing: string[] };
}

/** 加词形变体：复数 -s/-es、常见动词/形容词后缀，避免逐个手工列举 */
export function variants(term: string): string[] {
  const t = term.toLowerCase();
  const v = [t];
  if (t.endsWith("y") && t.length > 2) v.push(t.slice(0, -1) + "ies");
  if (/(s|x|z|ch|sh)$/.test(t)) v.push(t + "es");
  else if (t.endsWith("s") && !t.endsWith("ss")) v.push(t.slice(0, -1)); // 词单给了复数，也匹配单数
  else v.push(t + "s", t + "es");
  if (t.endsWith("e")) v.push(t.slice(0, -1) + "ing", t + "d");
  else v.push(t + "ing", t + "ed");
  return [...new Set(v)];
}

export function pattern(list: string[]): RegExp {
  const alts = list
    .flatMap(variants)
    .sort((a, b) => b.length - a.length) // 长词优先，避免 short 吞掉 shortcut
    .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // 词边界：前后不能是字母/数字/连字符，防子串误伤（如 win 匹配 window）
  return new RegExp(`(?<![\\w-])(?:${alts.join("|")})(?![\\w-])`, "gi");
}

function short(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createTerms(file: string): Terms {
  const path = resolve(file);
  return {
    file: path,
    load() {
      if (!existsSync(path)) return [];
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(path, "utf8"));
      } catch (err) {
        throw new Error(`terms 文件不是合法 JSON: ${path} — ${short(err)}`);
      }
      if (!Array.isArray(data) || data.some((x) => typeof x !== "string")) {
        throw new Error(`terms 文件格式错误（应为字符串数组）: ${path}`);
      }
      return data as string[];
    },
    save(list) {
      writeFileSync(path, JSON.stringify(list, null, 2) + "\n");
    },
    check(list, source) {
      if (list.length === 0) return { hits: {}, missing: [] };
      const re = pattern(list.filter((t) => t.trim()));
      const hits: Record<string, number> = {};
      for (const m of source.matchAll(re)) {
        const key = m[0].toLowerCase();
        hits[key] = (hits[key] ?? 0) + 1;
      }
      // 词单里的词按原形判断是否在文中出现过（含变体）
      const missing = list.filter((t) => !variants(t).some((v) => v in hits));
      return { hits, missing };
    },
  };
}

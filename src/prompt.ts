export interface SentenceRef {
  id: number;
  source: string;
  doubaoTr: string | null;
  doubaoEx: string | null;
}

/** 组装每块的 user prompt：原文上下文 + 编号句子 + 豆包参考 */
export function buildTranslationPrompt(blockRaw: string, refs: SentenceRef[]): string {
  const sentenceLines = refs.map((r) => `${r.id}. ${r.source}`).join("\n");
  const referenceLines = refs
    .map((r) => {
      const tr = r.doubaoTr ?? "（无）";
      const ex = r.doubaoEx ?? "（无）";
      return `- 句 ${r.id}\n  豆包翻译：${tr}\n  豆包解释：${ex}`;
    })
    .join("\n");

  return `## 原文

<original>
${blockRaw}
</original>

## 句子列表

${sentenceLines}

## 豆包参考

${referenceLines}`;
}

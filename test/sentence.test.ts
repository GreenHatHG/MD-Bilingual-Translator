import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitBlockIntoSentences } from "../src/sentence.js";

/**
 * 返回值三要素（与 pipeline 的用法对应）：
 * - sentences：送翻译的句子列表，id 从 1 起跨行连续递增
 * - lineIds：与块内行一一对应，每行是该行句子的 id 数组（空行 → 空数组），
 *   翻译后按它把每行的译文重新拼回一块
 * - restore：把 LLM 译文里的 ⟦n⟧ 占位符还原成原始内容
 */
describe("splitBlockIntoSentences", () => {
  it("单行多句：ICU 分句，句子间的空格保留在前一句尾部", () => {
    const r = splitBlockIntoSentences("One. Two. Three.");
    assert.deepEqual(
      r.sentences.map((s) => [s.id, s.text]),
      [
        [1, "One. "],
        [2, "Two. "],
        [3, "Three."],
      ],
    );
    assert.deepEqual(r.lineIds, [[1, 2, 3]]);
  });

  // 核心场景：一个真实混合块。链接/行内代码/图片/裸 URL/列表序号在拆分前
  // 被替换为 ⟦n⟧ 占位符保护起来（防句点误切），输出时已还原，因此句子
  // 文本总是完整的原文；id 跨行连续，空行在 lineIds 里是空数组。
  it("混合块拆句：占位符保护内容完整、id 跨行连续、空行行号为空", () => {
    const block = [
      "Read the [docs](https://example.com/a.b) first.", // 链接 URL 带句点，不能被误切
      "",
      "Use `npm test` and `npm run build`, then visit https://example.com/x.",
      "",
      "![logo](https://example.com/logo.png)",
      "",
      "1. First item",
      "2. Second item",
    ].join("\n");
    const r = splitBlockIntoSentences(block);
    assert.deepEqual(
      r.sentences.map((s) => [s.id, s.text]),
      [
        [1, "Read the [docs](https://example.com/a.b) first."],
        [2, "Use `npm test` and `npm run build`, then visit https://example.com/x."],
        [3, "![logo](https://example.com/logo.png)"],
        [4, "1. First item"],
        [5, "2. Second item"],
      ],
    );
    // 8 行输入 → 8 个条目；空行没有句子
    assert.deepEqual(r.lineIds, [[1], [], [2], [], [3], [], [4], [5]]);
    // restore：⟦n⟧ 按占位符在块内出现的全局顺序还原
    assert.equal(
      r.restore("译文 ⟦0⟧ 中 ⟦1⟧ 结束 ⟦2⟧ 完 ⟦3⟧"),
      "译文 https://example.com/a.b 中 `npm test` 结束 `npm run build` 完 https://example.com/x",
    );
    // 越界占位符还原为空串，不抛错
    assert.equal(r.restore("⟦99⟧"), "");
  });

  it("软换行段落：每行独立拆句，不跨行粘连", () => {
    const r = splitBlockIntoSentences("line1\nline2");
    assert.deepEqual(
      r.sentences.map((s) => [s.id, s.text]),
      [
        [1, "line1"],
        [2, "line2"],
      ],
    );
    assert.deepEqual(r.lineIds, [[1], [2]]);
  });

  it("字母序号行首标记同样受保护，整行成为一句", () => {
    const r = splitBlockIntoSentences("a. Alpha\nb. Beta");
    assert.deepEqual(
      r.sentences.map((s) => [s.id, s.text]),
      [
        [1, "a. Alpha"],
        [2, "b. Beta"],
      ],
    );
    assert.deepEqual(r.lineIds, [[1], [2]]);
  });

  // FIXME: 这块需要修复
  it("常见缩写：U.S.、e.g.、1.2.3 不被误切；Dr. 人名前缀会被切开（已知限制）", () => {
    const texts = (md: string) => splitBlockIntoSentences(md).sentences.map((s) => s.text);
    assert.deepEqual(texts("U.S. economy grew fast."), ["U.S. economy grew fast."]);
    assert.deepEqual(texts("Version 1.2.3 is out now."), ["Version 1.2.3 is out now."]);
    assert.deepEqual(texts("Compare e.g. apples. Oranges are similar."), [
      "Compare e.g. apples. ",
      "Oranges are similar.",
    ]);
    // ICU 不认识 Dr. 缩写，会拆开成独立句送翻（现状行为，先钉住）
    assert.deepEqual(texts("Dr. Smith went to Washington D.C. He was happy."), [
      "Dr. ",
      "Smith went to Washington D.C. ",
      "He was happy.",
    ]);
  });

  it("纯标点碎片合并回前一句，避免产生只有标点的句子", () => {
    // ICU 在引号内句点后切开，"..."." 一段是纯标点碎片，合并回前句
    const r = splitBlockIntoSentences('He said: "...". Then left.');
    assert.deepEqual(
      r.sentences.map((s) => [s.id, s.text]),
      [
        [1, 'He said: "...". '],
        [2, "Then left."],
      ],
    );
    assert.deepEqual(r.lineIds, [[1, 2]]);
  });

  it("空输入与空白行：不产生句子，但行结构照常反映在 lineIds", () => {
    assert.deepEqual(splitBlockIntoSentences("").sentences, []);
    assert.deepEqual(splitBlockIntoSentences("").lineIds, [[]]);
    const r = splitBlockIntoSentences("   \n\n");
    assert.deepEqual(r.sentences, []);
    assert.deepEqual(r.lineIds, [[], [], []]);
  });
});

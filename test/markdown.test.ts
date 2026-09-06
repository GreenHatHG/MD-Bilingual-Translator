import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitIntoChunks, type Chunk } from "../src/markdown.js";

/** 按顺序拼接所有块的 raw，用于字节级还原校验 */
const join = (chunks: Chunk[]) => chunks.map((c) => c.raw).join("");

describe("splitIntoChunks", () => {
  it("空输入返回空数组", () => {
    assert.deepEqual(splitIntoChunks(""), []);
  });

  it("纯空白输入产生单个 passthrough 空隙块", () => {
    assert.deepEqual(splitIntoChunks("\n\n\n"), [
      { kind: "passthrough", code: "000b", raw: "\n\n\n" },
    ]);
  });

  it("单个段落拆成段落块 + 尾部空行", () => {
    assert.deepEqual(splitIntoChunks("Hello world\n"), [
      { kind: "para", code: "000", raw: "Hello world" },
      { kind: "passthrough", code: "001b", raw: "\n" },
    ]);
  });

  // 一份包含所有块类型的文档，验证完整切块结果。三种角色一目了然：
  //   可译块：无后缀，kind = heading/para/quote/list，进翻译流程
  //   直通内容块：kind = passthrough + code 带 p 后缀，原样保留不翻译
  //   块间空行：kind = passthrough + code 带 b 后缀，只负责隔开块
  it("一次完整切块：可译块无后缀、直通内容块带 p、空行带 b，编号全局连续", () => {
    const doc =
      [
        "---",
        "title: x",
        "---",
        "",
        "# Head",
        "",
        "Some **bold** text.",
        "",
        "> quoted",
        "",
        "```js",
        "const a = 1;",
        "```",
        "",
        "| a | b |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "<div>",
        "raw html",
        "</div>",
        "",
        "[id]: http://example.com",
        "",
        "- item 1",
        "- item 2",
        "",
        "---",
        "",
        "tail para",
      ].join("\n") + "\n";
    // 每行一个块：[code, kind, 原文]
    assert.deepEqual(
      splitIntoChunks(doc).map((c) => [c.code, c.kind, c.raw]),
      [
        ["000p", "passthrough", "---\ntitle: x\n---"], // frontmatter
        ["001b", "passthrough", "\n\n"],
        ["002", "heading", "# Head"],
        ["003b", "passthrough", "\n\n"],
        ["004", "para", "Some **bold** text."],
        ["005b", "passthrough", "\n\n"],
        ["006", "quote", "> quoted"],
        ["007b", "passthrough", "\n\n"],
        ["008p", "passthrough", "```js\nconst a = 1;\n```"], // 围栏代码块
        ["009b", "passthrough", "\n\n"],
        ["010p", "passthrough", "| a | b |\n|---|---|\n| 1 | 2 |"], // 表格
        ["011b", "passthrough", "\n\n"],
        ["012p", "passthrough", "<div>\nraw html\n</div>"], // HTML 块
        ["013b", "passthrough", "\n\n"],
        ["014p", "passthrough", "[id]: http://example.com"], // 链接定义
        ["015b", "passthrough", "\n\n"],
        ["016", "list", "- item 1\n- item 2"],
        ["017b", "passthrough", "\n\n"],
        ["018p", "passthrough", "---"], // 分隔线（写法同 frontmatter，此处是正文内容）
        ["019b", "passthrough", "\n\n"],
        ["020", "para", "tail para"],
        ["021b", "passthrough", "\n"], // 文件末尾换行
      ],
    );
    // 直通块原样保留：所有块 raw 拼起来等于归一化后的原文
    assert.equal(join(splitIntoChunks(doc)), doc);
  });

  it("嵌套结构（引用内加粗、列表项）作为整体单块输出", () => {
    const chunks = splitIntoChunks("> quote with **bold**\n\n- item 1\n- item 2\n");
    assert.deepEqual(
      chunks.filter((c) => c.kind !== "passthrough").map((c) => c.raw),
      ["> quote with **bold**", "- item 1\n- item 2"],
    );
  });

  it("段内软换行保留在同一个段落块内", () => {
    const chunks = splitIntoChunks("line1\nline2\n\nnext\n");
    assert.deepEqual(
      chunks.filter((c) => c.kind !== "passthrough").map((c) => c.raw),
      ["line1\nline2", "next"],
    );
  });

  it("CRLF 与 CR 统一归一化为 LF", () => {
    const md = "para\r\nline\r\r# Head\r";
    const chunks = splitIntoChunks(md);
    assert.deepEqual(
      chunks.filter((c) => c.kind !== "passthrough").map((c) => c.raw),
      ["para\nline", "# Head"],
    );
    // 归一化后 raw 只含 \n
    for (const c of chunks) assert.ok(!c.raw.includes("\r"));
  });

  it("首块前的空行保留为块前空隙", () => {
    assert.deepEqual(splitIntoChunks("\n\nstart para\n")[0], {
      kind: "passthrough",
      code: "000b",
      raw: "\n\n",
    });
  });

  it("块间与末尾多余空行原样保留", () => {
    const chunks = splitIntoChunks("- item 1\n- item 2\n\n\n");
    assert.deepEqual(chunks.at(-1), { kind: "passthrough", code: "001b", raw: "\n\n\n" });
  });

  it("拼接所有 raw 可字节级还原归一化后的原文", () => {
    const md = [
      "\n\n",
      "---",
      "title: doc",
      "---",
      "",
      "# Head",
      "",
      "intro text",
      "",
      "```js",
      "const a = 1;",
      "```",
      "",
      "| a | b |",
      "|---|---|",
      "",
      "> quote",
      "",
      "- x",
      "- y",
      "",
      "tail para",
    ].join("\n");
    const normalized = md.replace(/\r\n?/g, "\n");
    assert.equal(join(splitIntoChunks(md)), normalized);
    // 同样适用于 CRLF 输入（对归一化后的文本成立）
    const crlf = md.replace(/\n/g, "\r\n");
    assert.equal(join(splitIntoChunks(crlf)), normalized);
  });

  it("编号超过 999 后不再补零（编号含空隙块一起累计）", () => {
    const md = Array.from({ length: 1001 }, () => "x").join("\n\n");
    const chunks = splitIntoChunks(md);
    // 1001 个段落 + 1000 个块间空隙
    assert.equal(chunks.length, 2001);
    assert.equal(chunks[0]!.code, "000");
    assert.equal(chunks[999]!.code, "999b"); // 恰好三位补零的最后一格（此处是空隙块）
    assert.equal(chunks[1000]!.code, "1000"); // 之后不再补零
    assert.equal(chunks[2000]!.code, "2000");
  });
});

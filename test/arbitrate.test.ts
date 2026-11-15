import { test } from "node:test";
import assert from "node:assert/strict";
import { ackOf, validateBlock, blockDone } from "../src/arbitrate.js";
import type { DoubaoResult } from "../src/doubao.js";

const ref: DoubaoResult = { translation: "译文甲", explanation: "注" };
const sentences = [
  { id: 1, text: "Hello ⟦0⟧ world. " },
  { id: 2, text: "Use subagents here. " },
];
const refs = { 1: ref, 2: ref };

test("correct submission passes validation", () => {
  const problems = validateBlock({
    code: "004",
    sentences,
    refs,
    termHits: {},
    submitted: {
      "1": { text: "你好 ⟦0⟧ 世界。", ack: ackOf(ref.translation) },
      "2": { text: "这里使用 subagents。", ack: ackOf(ref.translation) },
    },
  });
  assert.deepEqual(problems, []);
});

test("wrong ack is rejected", () => {
  const problems = validateBlock({
    code: "004", sentences, refs, termHits: {},
    submitted: { "1": { text: "你好 ⟦0⟧ 世界。", ack: "deadbeef" }, "2": { text: "x", ack: ackOf(ref.translation) } },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.reason, /ack 不匹配/);
});

test("missing or extra sentence ids are rejected", () => {
  const problems = validateBlock({
    code: "004", sentences, refs, termHits: {},
    submitted: { "1": { text: "你好 ⟦0⟧ 世界。", ack: ackOf(ref.translation) }, "3": { text: "多出来的", ack: ackOf(ref.translation) } },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.reason, /句子 id 不匹配/);
});

test("placeholder mismatch is rejected", () => {
  const problems = validateBlock({
    code: "004", sentences, refs, termHits: {},
    submitted: { "1": { text: "把占位符写丢了", ack: ackOf(ref.translation) }, "2": { text: "x", ack: ackOf(ref.translation) } },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.reason, /占位符不匹配/);
});

test("term word dropped from translation is rejected", () => {
  const problems = validateBlock({
    code: "004", sentences, refs,
    termHits: { 2: ["subagent"] },
    submitted: { "1": { text: "你好 ⟦0⟧ 世界。", ack: ackOf(ref.translation) }, "2": { text: "这里使用子代理。", ack: ackOf(ref.translation) } },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.reason, /terms 词未保留/);
});

test("blockDone requires every sentence non-empty", () => {
  assert.equal(blockDone({}, "004", sentences), false);
  assert.equal(blockDone({ "004": { "1": "你好 ⟦0⟧ 世界。", "2": " " } }, "004", sentences), false);
  assert.equal(blockDone({ "004": { "1": "你好 ⟦0⟧ 世界。", "2": "好" } }, "004", sentences), true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.js";
import type { DoubaoResult } from "../src/doubao.js";

const ref: DoubaoResult = { translation: "译文", explanation: "注" };

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "state-"));
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

test("state.json persists blocks as a code-sorted array", () => {
  const dir = sandbox();
  try {
    const state = new State(dir);
    state.setInputFile("in.md");
    state.recordSentences("100", [{ id: 1, text: "later " }]);
    state.recordSentences("000", [{ id: 1, text: "first " }]);
    const raw = JSON.parse(readFileSync(join(dir, "artifacts/state.json"), "utf8"));
    assert.ok(Array.isArray(raw.blocks));
    assert.deepEqual(raw.blocks.map((b: { code: string }) => b.code), ["000", "100"]);
  } finally {
    cleanup(dir);
  }
});

test("old Record-format state.json migrates without losing refs", () => {
  const dir = sandbox();
  try {
    mkdirSync(join(dir, "artifacts"));
    // Integer-like keys ("100") hoist before zero-padded ones ("000") in old files —
    // exactly the ordering bug that pushed the agent into linear scanning.
    writeFileSync(
      join(dir, "artifacts/state.json"),
      JSON.stringify({ inputFile: "in.md", blocks: { "100": { sentences: [{ id: 1, text: "b" }], refs: { 1: ref } }, "000": { sentences: [{ id: 1, text: "a" }], refs: { 1: ref } } } }),
    );
    const state = new State(dir);
    assert.equal(state.getBlock("000")?.refs?.[1]?.translation, "译文");
    assert.equal(state.getBlock("100")?.refs?.[1]?.translation, "译文");
    assert.deepEqual(state.all.blocks.map((b) => b.code), ["000", "100"]);
    // migration survives a flush
    state.recordRefs("002", { 1: ref });
    const raw = JSON.parse(readFileSync(join(dir, "artifacts/state.json"), "utf8"));
    assert.deepEqual(raw.blocks.map((b: { code: string }) => b.code), ["000", "002", "100"]);
  } finally {
    cleanup(dir);
  }
});

test("numeric code order: 1000 sorts after 999, suffixed codes stay adjacent to base", () => {
  const dir = sandbox();
  try {
    const state = new State(dir);
    state.setInputFile("in.md");
    for (const code of ["999", "1000", "010", "010p", "1000b"]) state.recordSentences(code, [{ id: 1, text: "x " }]);
    const raw = JSON.parse(readFileSync(join(dir, "artifacts/state.json"), "utf8"));
    assert.deepEqual(raw.blocks.map((b: { code: string }) => b.code), ["010", "010p", "999", "1000", "1000b"]);
  } finally {
    cleanup(dir);
  }
});

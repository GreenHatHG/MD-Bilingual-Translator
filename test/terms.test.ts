import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerms } from "../src/terms.js";

test("substring does not count as a hit", () => {
  const t = createTerms("/tmp/terms-test.json");
  const { hits } = t.check(["win"], "the window is open");
  assert.deepEqual(hits, {});
});

test("plural counts as a hit for the base term", () => {
  const t = createTerms("/tmp/terms-test.json");
  const { hits, missing } = t.check(["subagent"], "Subagents fan out; each subagent returns.");
  assert.equal(hits["subagents"], 1);
  assert.equal(hits["subagent"], 1);
  assert.deepEqual(missing, []);
});

test("word absent from source is reported missing", () => {
  const t = createTerms("/tmp/terms-test.json");
  const { missing } = t.check(["subagent", "skill"], "we built one subagent");
  assert.deepEqual(missing, ["skill"]);
});

test("loadGlobal returns the fixed <cwd>/terms.json when file differs, [] when absent", () => {
  const t = createTerms("/tmp/terms-test.json");
  assert.deepEqual(t.loadGlobal(), []);
});

test("loadGlobal returns file contents when file IS the global terms.json", () => {
  const t = createTerms(process.cwd() + "/terms.json");
  assert.deepEqual(t.loadGlobal(), t.load());
});

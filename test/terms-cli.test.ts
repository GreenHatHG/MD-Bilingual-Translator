import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run cli.ts terms in a sandbox cwd (repo copied npx tsx invocation). */
function runTerms(cwd: string, article: string, list: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("npx", ["tsx", join(process.cwd(), "src/cli.ts"), "terms", article, "list.json"], {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "terms-cli-"));
}

test("terms exits 2 when an article term never appears in the source", () => {
  const dir = sandbox();
  writeFileSync(join(dir, "in.md"), "We use subagents here.\n");
  writeFileSync(join(dir, "list.json"), JSON.stringify(["subagent", "skill"]));
  const r = runTerms(dir, "in.md", []);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /"missing"/);
  assert.match(r.stderr, /skill/);
  rmSync(dir, { recursive: true, force: true });
});

test("terms exits 0 with clean list and writes artifacts/terms.json", () => {
  const dir = sandbox();
  writeFileSync(join(dir, "in.md"), "We use subagents here.\n");
  writeFileSync(join(dir, "list.json"), JSON.stringify(["subagent"]));
  const r = runTerms(dir, "in.md", []);
  assert.equal(r.code, 0, r.stderr);
  const saved = JSON.parse(readFileSync(join(dir, "artifacts/terms.json"), "utf8"));
  assert.deepEqual(saved, ["subagent"]);
  rmSync(dir, { recursive: true, force: true });
});

test("global terms.json is exempt from the missing check", () => {
  const dir = sandbox();
  writeFileSync(join(dir, "in.md"), "We use subagents here.\n");
  writeFileSync(join(dir, "terms.json"), JSON.stringify(["MCP"])); // global, not in source
  writeFileSync(join(dir, "list.json"), JSON.stringify(["subagent"]));
  const r = runTerms(dir, "in.md", []);
  assert.equal(r.code, 0, r.stderr);
  const saved = JSON.parse(readFileSync(join(dir, "artifacts/terms.json"), "utf8"));
  assert.deepEqual(saved, ["subagent"]); // global not merged into article list
  rmSync(dir, { recursive: true, force: true });
});

test("split clears the previous article's artifacts/terms.json", () => {
  const dir = sandbox();
  writeFileSync(join(dir, "in.md"), "We use subagents here.\n");
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  writeFileSync(join(dir, "artifacts/terms.json"), JSON.stringify(["stale-word"]));
  execFileSync("npx", ["tsx", join(process.cwd(), "src/cli.ts"), "split", "in.md"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  assert.equal(existsSync(join(dir, "artifacts/terms.json")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("terms without list file is a usage error (exit 1, die)", () => {
  const dir = sandbox();
  writeFileSync(join(dir, "in.md"), "We use subagents here.\n");
  try {
    execFileSync("npx", ["tsx", join(process.cwd(), "src/cli.ts"), "terms", "in.md"], { cwd: dir, encoding: "utf8" });
    assert.fail("expected nonzero exit");
  } catch (err) {
    const e = err as { status?: number };
    assert.equal(e.status, 1);
  }
  rmSync(dir, { recursive: true, force: true });
});

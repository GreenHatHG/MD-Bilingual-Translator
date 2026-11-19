/**
 * Translation-mode extension (repo-local, gated by PI_TRANSLATE_MODE=1).
 *
 * Exposes the repo's CLI workflow (split → terms → doubao → arbitrate next/submit
 * → collect → verify) as typed tools so the model never needs a shell. Launched
 * via ./translate.sh; plain `pi` in this repo never loads these tools.
 *
 * Error model (decided): validation failures (CLI exit 2) return the problems
 * list as a normal error result the model fixes and resubmits. Fatal failures
 * (CLI crash, Doubao service down) trip a latch — every workflow tool then
 * refuses until the user relaunches, because there is no shell escape hatch.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CLI = ["npx", "tsx", "src/cli.ts"] as const;
const TIMEOUT_MS = 60 * 60 * 1000; // Doubao calls can take minutes per sentence

const latch = { tripped: false, reason: "" };
// Terms gate: doubao/arbitrate_next refuse until terms_set succeeded this session.
// The confirm dialog inside terms_set is the human checkpoint; the gate closes the skip path.
const gate = { termsConfirmed: false };

function trip(reason: string) {
  latch.tripped = true;
  latch.reason = reason;
}

function refused() {
  return `ABORTED — a fatal error already occurred, do not retry or improvise: ${latch.reason}. Wait for the user to fix it and relaunch.`;
}

type Outcome =
  | { fatal: false; rejected: false; output: string }
  | { fatal: false; rejected: true; output: string }
  | { fatal: true; output: string };

async function runCli(pi: ExtensionAPI, args: string[], signal?: AbortSignal): Promise<Outcome> {
  const result = await pi.exec(CLI[0], [...CLI.slice(1), ...args], { signal, timeout: TIMEOUT_MS });
  if (result.code === 0) return { fatal: false, rejected: false, output: result.stdout };
  if (result.code === 2) return { fatal: false, rejected: true, output: (result.stderr || result.stdout).trim() };
  trip(`CLI exited ${result.code} on: ${args.join(" ")}\n${(result.stderr || result.stdout).trim()}`);
  return { fatal: true, output: refused() };
}

function result(text: string, isError: boolean) {
  return { content: [{ type: "text" as const, text }], details: {}, isError };
}

function gateRefused(): string {
  return "Terms not confirmed yet — run terms_set first (step 2: propose keep-in-English words, the user confirms). Never skip or batch this step.";
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

/** Spawn the CLI directly (pi.exec buffers, so it cannot stream progress). */
async function spawnCli(args: string[], signal: AbortSignal | undefined, onLine: (line: string) => void, timeoutMs = TIMEOUT_MS): Promise<SpawnResult> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolvePromise) => {
    const proc = spawn(CLI[0], [...CLI.slice(1), ...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let stderrBuf = "";
    const kill = () => {
      if (!killed) {
        killed = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      }
    };
    if (signal?.aborted) kill();
    else signal?.addEventListener("abort", kill, { once: true });
    const timeoutId = setTimeout(kill, timeoutMs);
    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      stderrBuf += text;
      let idx: number;
      while ((idx = stderrBuf.indexOf("\n")) !== -1) {
        const line = stderrBuf.slice(0, idx).trim();
        stderrBuf = stderrBuf.slice(idx + 1);
        if (line) onLine(line);
      }
    });
    proc.on("close", (code) => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", kill);
      resolvePromise({ stdout, stderr, code: code ?? 0, killed });
    });
    proc.on("error", () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", kill);
      resolvePromise({ stdout, stderr, code: 1, killed });
    });
  });
}

// Progress lines accumulate into a single growing text block, so the tool row
// shows the full history like a terminal scrollback instead of one line at a time.
const PROGRESS_PREVIEW_LINES = 6;
class DoubaoProgress {
  lines: string[] = [];
  summary: string | null = null;
  push(line: string) {
    if (/^done: /.test(line)) this.summary = line;
    else this.lines.push(line);
  }
  render(theme: { fg: (role: string, t: string) => string }, expanded: boolean, isPartial: boolean) {
    const styled = this.lines.map((l) => theme.fg("toolOutput", l));
    if (isPartial && !expanded) {
      // Running, collapsed: terminal tail — you always see where it is now.
      return new Text(styled.slice(-PROGRESS_PREVIEW_LINES).join("\n"), 0, 0);
    }
    if (!isPartial && !expanded && (this.lines.length > PROGRESS_PREVIEW_LINES || this.summary)) {
      // Finished, collapsed: tail + summary, rest folds away until expand.
      const parts = styled.slice(-PROGRESS_PREVIEW_LINES);
      if (this.summary) parts.push(theme.fg("success", this.summary));
      const skipped = Math.max(0, this.lines.length - PROGRESS_PREVIEW_LINES);
      const hint = skipped > 0 ? `${theme.fg("muted", `... (${skipped} earlier lines, ctrl+o to expand)`)}\n` : "";
      return new Text(hint + parts.join("\n"), 0, 0);
    }
    const all = [...styled];
    if (this.summary) all.push(theme.fg("success", this.summary));
    return new Text(all.join("\n"), 0, 0);
  }
}

export default function translateExtension(pi: ExtensionAPI) {
  if (process.env.PI_TRANSLATE_MODE !== "1") return;

  type Params = { inputMd: string };
  const inputParams = () =>
    Type.Object({
      inputMd: Type.String({ description: "Path to the source article, relative to the project root (e.g. pending-translation/foo.md)" }),
    });

  /** Simple pass-through tools: one CLI call, contract = exit code + stdout. */
  const simpleTool = (
    name: string,
    description: string,
    params: { inputMd: Type.TString },
    argsOf: (params: Params) => string[],
  ) => {
    pi.registerTool({
      name,
      label: name,
      description,
      parameters: params,
      async execute(_toolCallId, params, signal) {
        if (latch.tripped) return result(refused(), true);
        try {
          const r = await runCli(pi, argsOf(params as Params), signal);
          // Exit 2 = validation problems; a normal, fixable error for the model.
          if (!r.fatal && r.rejected) return result(r.output, true);
          if (r.fatal) return result(r.output, true);
          return result(r.output, false);
        } catch (err) {
          trip(`tool ${name} crashed: ${err instanceof Error ? err.message : String(err)}`);
          return result(refused(), true);
        }
      },
    });
  };

  simpleTool(
    "split",
    "Step 1: chunk the Markdown source and split sentences. Persists to artifacts/state.json (and clears stale translations.json). Run this first for a new article.",
    { inputMd: Type.String({ description: "Path to the source article, relative to the project root" }) },
    (p) => ["split", p.inputMd],
  );

  simpleTool(
    "collect",
    "Step 5: assemble the bilingual output file (only after every block is finalized). Refuses partial input.",
    { inputMd: Type.String({ description: "Path to the source article, relative to the project root" }) },
    (p) => ["collect", p.inputMd, "translations.json"],
  );

  simpleTool(
    "verify",
    "Step 6: completeness check of the bilingual output. Problems come back as a JSON report — fix and re-run collect.",
    { inputMd: Type.String({ description: "Path to the source article, relative to the project root" }) },
    (p) => ["verify", p.inputMd, "translations.json"],
  );

  pi.registerTool({
    name: "terms_set",
    label: "terms_set",
    description:
      "Step 2: propose keep-in-English words to the user in a confirm dialog, then validate the list against the source (strict: words absent from the article are rejected — fix and resubmit). terms = the article list; persist = words the user asked to remember for future articles (appended to global terms.json). Do not invent terms; seed your proposal from global terms.json.",
    parameters: Type.Object({
      inputMd: Type.String({ description: "Path to the source article, relative to the project root" }),
      terms: Type.Array(Type.String(), { description: "Keep-in-English words/phrases for THIS article, exactly as proposed" }),
      persist: Type.Optional(Type.Array(Type.String(), { description: "Words the user explicitly asked to remember for future articles (appended to global terms.json)" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (latch.tripped) return result(refused(), true);
      const p = params as { inputMd: string; terms: string[]; persist?: string[] };
      try {
        // Human checkpoint (TUI only; headless -p runs have no UI and are user-launched).
        if (ctx.hasUI) {
          const listText = p.terms.map((t) => `- ${t}`).join("\n");
          const ok = await ctx.ui.confirm(
            "Terms list",
            `Keep these in English for this article?\n\n${listText}`,
          );
          if (!ok) {
            const suggestion = await ctx.ui.input("Adjustments?", "e.g. remove X, add Y, or 'keep MCP anyway'");
            return result(
              `User rejected the terms list${suggestion ? ` with feedback: ${suggestion}` : "."} Revise the list per the feedback and call terms_set again. Do not proceed to doubao until terms_set succeeds.`,
              true,
            );
          }
        }
        // The CLI reads terms from a file; pass the list via a temp file so the
        // model never writes into the repo.
        const fs = await import("node:fs");
        const os = await import("node:os");
        const path = await import("node:path");
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "terms-")), "terms.json");
        fs.writeFileSync(file, JSON.stringify(p.terms, null, 2));
        const r = await runCli(pi, ["terms", p.inputMd, file], signal);
        if (r.fatal || r.rejected) return result(r.output, true);
        if (p.persist?.length) {
          // User-confirmed additions to the global list; merge without duplicates.
          const globalPath = path.resolve("terms.json");
          const existing = fs.existsSync(globalPath)
            ? (JSON.parse(fs.readFileSync(globalPath, "utf8")) as string[])
            : [];
          fs.writeFileSync(globalPath, JSON.stringify([...new Set([...existing, ...p.persist])], null, 2) + "\n");
        }
        gate.termsConfirmed = true;
        return result(r.output, false);
      } catch (err) {
        trip(`tool terms_set crashed: ${err instanceof Error ? err.message : String(err)}`);
        return result(refused(), true);
      }
    },
  });

  pi.registerTool({
    name: "doubao",
    label: "doubao",
    description:
      "Step 3: fetch Doubao references for all translatable blocks (serial, resumable, minutes per sentence). Fatal if the service is down — report and abort; the user starts the service.",
    parameters: Type.Object({
      inputMd: Type.String({ description: "Path to the source article, relative to the project root" }),
    }),
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (result.details?.progress) context.state.progress = result.details.progress;
      const progress = (context.state.progress ??= new DoubaoProgress());
      // Session restores / stale details can yield a plain object without render().
      const p = progress instanceof DoubaoProgress ? progress : Object.assign(new DoubaoProgress(), progress);
      // Partial updates and error results carry text in content, not details.progress.
      if (!p.lines.length && !p.summary) {
        const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
        return new Text(theme.fg(result.isError ? "error" : "toolOutput", text), 0, 0);
      }
      return p.render(theme, expanded, isPartial);
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      if (latch.tripped) return result(refused(), true);
      if (!gate.termsConfirmed) return result(gateRefused(), true);
      try {
        onUpdate?.({ content: [{ type: "text", text: "Fetching Doubao references (serial; can take many minutes)…" }], details: {} });
        const progress = new DoubaoProgress();
        // pi.exec buffers output, so spawn directly to stream the CLI's per-sentence
        // progress to the UI; lines accumulate so earlier ones stay visible.
        const proc = await spawnCli(["doubao", (params as { inputMd: string }).inputMd, "-a"], signal, (line) => {
          progress.push(line);
          onUpdate?.({ content: [{ type: "text", text: progress.lines.join("\n") }], details: { progress } });
        });
        // A timeout kill (SIGTERM → exit 143) is resumable, not fatal: cached
        // sentences are skipped on the next run, so just tell the model to retry.
        if (proc.killed && proc.code === 143) {
          return result(
            `doubao timed out after ${TIMEOUT_MS / 60000} min and was stopped — this is NOT fatal. Fetched sentences are cached (they show as "cached, skipping"), so call doubao again with the same inputMd to resume where it left off. Repeat until it finishes.`,
            true,
          );
        }
        const resultText = proc.code === 0 ? proc.stdout : (proc.stderr || proc.stdout).trim();
        if (proc.code !== 0) trip(`CLI exited ${proc.code} on: doubao\n${resultText}`);
        return { content: [{ type: "text" as const, text: proc.code === 0 ? resultText : refused() }], details: { progress }, isError: proc.code !== 0 };
      } catch (err) {
        trip(`tool doubao crashed: ${err instanceof Error ? err.message : String(err)}`);
        return result(refused(), true);
      }
    },
  });

  pi.registerTool({
    name: "arbitrate_next",
    label: "arbitrate_next",
    description:
      "Step 4a: get the next batch (CLI picks the blocks; default 5, max 10). Returns compact payload: id, text, ack (echo unchanged), termHits (keep untranslated). Doubao refs are NOT inline — read artifacts/state.json blocks[] (match entry by code) refs.<id> with the read tool.",
    parameters: Type.Object({
      inputMd: Type.String({ description: "Path to the source article, relative to the project root" }),
      batch: Type.Optional(Type.Number({ description: "Batch size, 1-10. Default 5. Do not exceed 10." })),
    }),
    async execute(_toolCallId, params, signal) {
      if (latch.tripped) return result(refused(), true);
      if (!gate.termsConfirmed) return result(gateRefused(), true);
      try {
        const p = params as { inputMd: string; batch?: number };
        const args = ["arbitrate", "next", p.inputMd];
        if (p.batch !== undefined) args.push("--batch", String(p.batch));
        const r = await runCli(pi, args, signal);
        if (r.fatal || r.rejected) return result(r.output, true);
        return result(r.output, false);
      } catch (err) {
        trip(`tool arbitrate_next crashed: ${err instanceof Error ? err.message : String(err)}`);
        return result(refused(), true);
      }
    },
  });

  pi.registerTool({
    name: "arbitrate_submit",
    label: "arbitrate_submit",
    description:
      'Step 4b: submit one batch of translations for validation and merge into translations.json. payloadJson shape: {"<code>": {"<sentenceId>": {"text": "…", "ack": "…"}}}. Rejections (ack mismatch, term violations, placeholder mismatch) come back as a per-sentence problems list — fix exactly those and resubmit.',
    parameters: Type.Object({
      payloadJson: Type.String({ description: 'The batch payload as a JSON string: {"<code>": {"<sentenceId>": {"text", "ack"}}}' }),
    }),
    async execute(_toolCallId, params, signal) {
      if (latch.tripped) return result(refused(), true);
      try {
        let submission: unknown;
        try {
          submission = JSON.parse((params as { payloadJson: string }).payloadJson);
        } catch (err) {
          // Not fatal: nothing was merged, the model can fix the JSON and retry.
          return result(
            `Payload is not valid JSON: ${err instanceof Error ? err.message : err}. Fix payloadJson and resubmit — nothing was merged.`,
            true,
          );
        }
        const fs = await import("node:fs");
        const os = await import("node:os");
        const path = await import("node:path");
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arbitrate-")), "payload.json");
        fs.writeFileSync(file, JSON.stringify(submission, null, 2));
        const r = await runCli(pi, ["arbitrate", "submit", file], signal);
        if (r.fatal || r.rejected) return result(r.output, true);
        return result(r.output, false);
      } catch (err) {
        trip(`tool arbitrate_submit crashed: ${err instanceof Error ? err.message : String(err)}`);
        return result(refused(), true);
      }
    },
  });
}

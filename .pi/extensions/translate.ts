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
import { Type } from "typebox";

const CLI = ["npx", "tsx", "src/cli.ts"] as const;
const TIMEOUT_MS = 15 * 60 * 1000; // Doubao calls can take minutes per sentence

const latch = { tripped: false, reason: "" };

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
      "Step 2: write the user-confirmed keep-in-English word list to terms.json and validate it against the source. HARD STOP: the user must confirm the list before you call this. Do not invent terms.",
    parameters: Type.Object({
      inputMd: Type.String({ description: "Path to the source article, relative to the project root" }),
      terms: Type.Array(Type.String(), { description: "Keep-in-English words/phrases, exactly as the user confirmed" }),
    }),
    async execute(_toolCallId, params, signal) {
      if (latch.tripped) return result(refused(), true);
      try {
        // The CLI reads terms from a file; pass the list via a temp file so the
        // model never writes into the repo.
        const fs = await import("node:fs");
        const os = await import("node:os");
        const path = await import("node:path");
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "terms-")), "terms.json");
        fs.writeFileSync(file, JSON.stringify((params as { terms: string[] }).terms, null, 2));
        const r = await runCli(pi, ["terms", (params as { inputMd: string }).inputMd, file], signal);
        if (r.fatal || r.rejected) return result(r.output, true);
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
    async execute(_toolCallId, params, signal, onUpdate) {
      if (latch.tripped) return result(refused(), true);
      try {
        onUpdate?.({ content: [{ type: "text", text: "Fetching Doubao references (serial; can take many minutes)…" }], details: {} });
        const r = await runCli(pi, ["doubao", (params as { inputMd: string }).inputMd, "-a"], signal);
        if (r.fatal || r.rejected) return result(r.output, true);
        return result(r.output, false);
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
      "Step 4a: get the next batch (CLI picks the blocks; default 5, max 10). Returns compact payload: id, text, ack (echo unchanged), termHits (keep untranslated). Doubao refs are NOT inline — read artifacts/state.json blocks.<code>.refs.<id> with the read tool.",
    parameters: Type.Object({
      inputMd: Type.String({ description: "Path to the source article, relative to the project root" }),
      batch: Type.Optional(Type.Number({ description: "Batch size, 1-10. Default 5. Do not exceed 10." })),
    }),
    async execute(_toolCallId, params, signal) {
      if (latch.tripped) return result(refused(), true);
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

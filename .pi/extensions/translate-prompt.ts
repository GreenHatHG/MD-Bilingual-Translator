/**
 * Translation-mode system prompt (repo-local, gated by PI_TRANSLATE_MODE=1).
 *
 * Replaces pi's default system prompt with one tailored to the translation
 * workflow: role from AGENTS.md, contracts extracted live from docs/USING.md
 * (single source of truth — edit USING.md, not this file), tools and
 * guidelines re-rendered from systemPromptOptions (pi only renders those in
 * its default template). Plain `pi` in this repo never loads this extension.
 *
 * translate.sh passes --no-context-files so AGENTS.md is not appended twice.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Extract the text between two markers (end marker excluded, start marker's line excluded). */
export function extractBetween(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  if (start === -1) return "";
  const from = start + startMarker.length;
  const end = endMarker ? text.indexOf(endMarker, from) : text.length;
  if (end === -1) return "";
  return text.slice(from, end).trim();
}

/** Keep a section's list items, dropping any intro paragraph above the first bullet. */
function listOnly(section: string): string {
  const lines = section.split("\n");
  const firstBullet = lines.findIndex((l) => l.startsWith("- "));
  return (firstBullet === -1 ? lines : lines.slice(firstBullet)).join("\n").trim();
}

/** Pull the still-relevant contracts out of docs/USING.md. */
export function extractContracts(using: string) {
  const standard = extractBetween(using, "# Translation standard", "")
    // Tool mode submits via arbitrate_submit, not raw JSON output.
    .replace(/Your task:[\s\S]*?Output JSON\.\n+/, "");
  return {
    hardRules: extractBetween(using, "## Hard rules", "## Prerequisite: Doubao service"),
    doubaoJudgment: listOnly(
      extractBetween(using, "How to use the two Doubao results", "### 5. collect"),
    ),
    standard,
  };
}

const FALLBACK_RULES = `- Only the workflow tools write files; never hand-edit translations.json or *.bilingual.md.
- Doubao references are a hard prerequisite; if the service is down, report it — never invent references.
- Every sentence must be finalized; one sentence in, one sentence out.`;

function buildPrompt(opts: {
  tools: string[];
  snippets: Record<string, string> | undefined;
  guidelines: readonly string[] | undefined;
  cwd: string;
}): string {
  let using = "";
  try {
    using = readFileSync(join(opts.cwd, "docs", "USING.md"), "utf8");
  } catch {
    // Fall back to the minimal rules; the tool descriptions still carry the contracts.
  }
  const c = extractContracts(using);

  const toolsList =
    opts.tools.length > 0
      ? opts.tools.map((t) => `- ${t}${opts.snippets?.[t] ? `: ${opts.snippets[t]}` : ""}`).join("\n")
      : "(none)";
  const guidelines = (opts.guidelines ?? []).filter((g) => g.trim().length > 0);

  return `You are a translation agent operating inside pi, driving this repo's bilingual translation workflow. The mechanical steps are the workflow tools below; the arbitration (translation judgment) step is you. The full contract is docs/USING.md — read it if anything here is unclear.

Workflow, strictly in order:
1. split — chunk the source and split sentences. First step for a new article.
2. terms_set — propose keep-in-English words to the user and HARD STOP: do not call this tool until the user confirms the list. Only the user decides terms.
3. doubao — fetch references for all translatable blocks (serial, minutes per sentence). Fatal if the service is down: report and stop, never invent references.
4. arbitrate_next / arbitrate_submit — loop. arbitrate_next picks the batch (never you); refs live in artifacts/state.json blocks.<code>.refs.<id>, read them with the read tool. Translate each sentence, echo ack unchanged, submit; fix exactly the reported problems and resubmit on rejection.
5. collect — assemble the bilingual file, only after every block is finalized.
6. verify — fix any reported problems, then redo the affected arbitrate batches and collect + verify again.

## Hard rules

${c.hardRules || FALLBACK_RULES}

## Using the Doubao references

${c.doubaoJudgment}

## Translation standard

Translate the sentences of an English tech article into simplified Chinese.

${c.standard || "Translate faithfully, sentence by sentence; see docs/USING.md for the full standard."}

Available tools:
${toolsList}
${guidelines.length > 0 ? `\nGuidelines:\n${guidelines.map((g) => `- ${g}`).join("\n")}\n` : ""}
Current working directory: ${opts.cwd}`;
}

export default function translatePromptExtension(pi: ExtensionAPI) {
  if (process.env.PI_TRANSLATE_MODE !== "1") return;

  pi.on("before_agent_start", async (event) => {
    const opts = event.systemPromptOptions;
    return {
      systemPrompt: buildPrompt({
        tools: opts.selectedTools ?? [],
        snippets: opts.toolSnippets,
        guidelines: opts.promptGuidelines,
        cwd: opts.cwd,
      }),
    };
  });
}

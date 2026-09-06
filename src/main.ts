import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { loadConfig } from "./env.js";
import { splitIntoChunks, type Chunk } from "./markdown.js";
import { createDoubaoClient } from "./doubao.js";
import { createManifest } from "./manifest.js";
import { translateBlock } from "./pipeline.js";

async function main() {
  const cwd = process.cwd();
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error("用法: npm start -- <input.md> [output.md]");
    process.exit(1);
  }
  const inputPath = resolve(cwd, inputArg);
  const outputArg = process.argv[3];
  const outputName = outputArg
    ? basename(resolve(cwd, outputArg))
    : basename(inputPath).replace(/\.md$/i, "") + ".bilingual.md";
  const outputPath = resolve(dirname(inputPath), outputName);
  const tmpPath = outputPath + ".tmp";

  const config = loadConfig(cwd);
  const source = readFileSync(inputPath, "utf8");
  const chunks = splitIntoChunks(source);
  const doubao = createDoubaoClient(config.doubaoBaseUrl, config.doubaoRetries, config.doubaoTimeoutMs);
  const m = createManifest(cwd);
  m.manifest.inputFile = basename(inputPath);
  m.save();

  const translatable = chunks.filter((c) => c.kind !== "passthrough");
  console.log(`切块完成: ${chunks.length} 块，其中可译 ${translatable.length} 块`);

  const outParts: string[] = [];
  const report: string[] = [];
  let totalFallback = 0;

  for (const chunk of chunks) {
    if (chunk.kind === "passthrough") {
      outParts.push(chunk.raw);
      continue;
    }
    const label = `块 ${chunk.code}`;

    // 断点续跑：manifest 中已有译文的块直接复用，不重做任何调用
    const done = m.manifest.blocks[chunk.code];
    if (done?.done && done.translation) {
      console.log(`${label}: 已完成，跳过`);
      outParts.push(chunk.raw, "\n", done.translation);
      continue;
    }

    console.log(`${label} (${chunk.kind}) 翻译中...`);
    const result = await translateBlock(chunk, doubao, config, m, label);
    outParts.push(chunk.raw, "\n", result.translationBlock);
    totalFallback += result.fallback.length;
    if (result.fallback.length > 0) {
      report.push(
        `## ${label}\n` +
          result.fallback.map((f) => `- ${f.reason}：${f.sentence}`).join("\n"),
      );
    }
    m.finishBlock(chunk.code);
    console.log(
      `${label}: ${result.sentenceCount} 句，豆包译文成功 ${result.doubaoTranslateOk}，兜底 ${result.fallback.length}`,
    );
  }

  // 块间空行由 gap passthrough 提供，这里只保证文件末尾有换行
  if (!outParts.at(-1)?.endsWith("\n")) {
    outParts.push("\n");
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(tmpPath, outParts.join(""));
  renameSync(tmpPath, outputPath);
  console.log(`\n输出: ${outputPath}`);
  if (report.length > 0) {
    const reportPath = resolve(dirname(outputPath), "report.md");
    writeFileSync(reportPath, `# 翻译兜底报告\n\n` + report.join("\n\n") + "\n");
    console.log(`报告: ${reportPath}（兜底 ${totalFallback} 句）`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

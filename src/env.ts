import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** 解析后的运行配置 */
export interface Config {
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
  /** LLM 请求失败重试次数 */
  llmRetries: number;
  /** 豆包 HTTP 单次请求失败重试次数 */
  doubaoRetries: number;
  /** 豆包 HTTP 单次请求超时（毫秒）；长文上游可达数分钟，不宜调低 */
  doubaoTimeoutMs: number;
  /** doubao_server.js 服务地址（去掉尾部斜杠） */
  doubaoBaseUrl: string;
  /** LLM 单次请求超时（毫秒） */
  llmTimeoutMs: number;
}

/** 极简 .env 解析：KEY=VALUE，# 开头为注释，忽略空行 */
function parseDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // 去掉成对的包裹引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadConfig(cwd: string = process.cwd()): Config {
  const env = { ...parseDotEnv(resolve(cwd, ".env")), ...process.env };
  const apiKey = env.OPENAI_API_KEY;
  const model = env.OPENAI_MODEL;
  if (!apiKey) throw new Error("缺少 OPENAI_API_KEY（请在 .env 或环境变量中设置）");
  if (!model) throw new Error("缺少 OPENAI_MODEL（请在 .env 或环境变量中设置）");

  return {
    openaiApiKey: apiKey,
    openaiBaseUrl: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    openaiModel: model,
    llmRetries: Number(env.LLM_RETRIES ?? 2),
    doubaoRetries: Number(env.DOUBAO_RETRIES ?? 2),
    // 长文实测可达数分钟，默认给足 10 分钟；限流时服务端挂起排队，不报错
    doubaoTimeoutMs: Number(env.DOUBAO_TIMEOUT_MS ?? 600_000),
    doubaoBaseUrl: (env.DOUBAO_BASE_URL || "http://127.0.0.1:8765").replace(/\/+$/, ""),
    llmTimeoutMs: Number(env.LLM_TIMEOUT_MS ?? 300_000),
  };
}

import type { Config } from "./env.js";

export class LlmError extends Error {}

/**
 * 调用 OpenAI 兼容 chat completions 接口，返回助手文本。
 * 失败（网络 / HTTP 非 2xx / 响应结构异常）时重试，最终抛出 LlmError。
 */
export async function chat(
  config: Config,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= config.llmRetries; attempt++) {
    try {
      return await once(config, messages);
    } catch (err) {
      lastErr = err;
      if (attempt < config.llmRetries) {
        await sleep(1500 * (attempt + 1));
      }
    }
  }
  throw new LlmError(`LLM 调用失败（已重试 ${config.llmRetries} 次）: ${String(lastErr)}`);
}

async function once(
  config: Config,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs);
  try {
    const res = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify({ model: config.openaiModel, messages }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("响应缺少 choices[0].message.content");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 豆包 HTTP 客户端：接入本地 doubao_server.js（doubao_hook 项目）。
 * - POST /translate {text, to:"zh"} → {ok, translation}
 * - POST /explain   {text}          → {ok, explanation}
 * 失败（网络 / HTTP 非 2xx / ok:false）时重试，最终失败直接 throw —— 豆包参考
 * 是硬性前置（用户决策：a），绝不静默降级。
 * 注意：长文上游可达数分钟，服务端被限流时请求会挂起排队，超时需设足够长。
 */
import type { Config } from "./env.js";

export interface DoubaoResult {
  translation: string;
  explanation: string;
}

export class DoubaoError extends Error {}

export function createDoubao(config: Config) {
  const base = config.doubaoBaseUrl;

  async function call(label: string, path: string, body: Record<string, unknown>): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= config.doubaoRetries; attempt++) {
      try {
        return await once(base, path, body, config.doubaoTimeoutMs);
      } catch (err) {
        lastErr = err;
        if (attempt < config.doubaoRetries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
    throw new DoubaoError(`豆包 ${label} 最终失败: ${short(lastErr)}`);
  }

  return {
    /** 直译 + 完整解释，串行取回（用户决策：不并行），任一失败即 throw */
    async reference(text: string): Promise<DoubaoResult> {
      return {
        translation: await call("translate", "/translate", { text, to: "zh" }),
        explanation: await call("explain", "/explain", { text }),
      };
    },
    /** 健康检查：ok:true 表示豆包页面就绪 */
    async health(): Promise<boolean> {
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) });
        const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        return data?.ok === true;
      } catch {
        return false;
      }
    },
  };
}

async function once(
  base: string,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; translation?: string; explanation?: string; error?: string }
      | null;
    if (!res.ok || !data?.ok) {
      throw new Error(`HTTP ${res.status}${data?.error ? `: ${data.error}` : ""}`);
    }
    const text = data.translation ?? data.explanation;
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("响应缺少 translation/explanation 内容");
    }
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

function short(err: unknown): string {
  return String(err instanceof Error ? err.message : err).slice(0, 120);
}

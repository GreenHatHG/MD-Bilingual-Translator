/**
 * 豆包 HTTP 客户端：接入本地 doubao_server.js（doubao_hook 项目）。
 * - POST /translate {text, to:"zh"} → {ok, translation}
 * - POST /explain   {text}          → {ok, explanation}
 * 失败（网络 / HTTP 非 2xx / ok:false）时重试，最终失败返回 null（调用方按缺参考处理）。
 * 注意：长文上游可达数分钟，服务端被限流时请求会挂起排队，超时需设足够长。
 */
export interface DoubaoClient {
  translate(text: string): Promise<string | null>;
  explain(text: string): Promise<string | null>;
}

export function createDoubaoClient(baseUrl: string, retries: number, timeoutMs: number): DoubaoClient {
  const base = baseUrl.replace(/\/+$/, "");

  async function call(
    label: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<string | null> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await once(base, path, body, timeoutMs);
      } catch (err) {
        lastErr = err;
        console.warn(`  [豆包] ${label} 第 ${attempt + 1} 次失败: ${short(err)}`);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
    console.warn(`  [豆包] ${label} 最终失败，忽略该参考: ${short(lastErr)}`);
    return null;
  }

  return {
    translate: (text) => call("translate", "/translate", { text, to: "zh" }),
    explain: (text) => call("explain", "/explain", { text }),
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

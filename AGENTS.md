# AGENTS.md — agent 调用契约

本仓库把 Markdown 双语翻译拆成机械步骤（代码）+ 定稿步骤（你，agent）。
你负责：调用子命令、撮合译文、修复校验问题。你不负责：直接写/改输出文件。

## 硬性规则

- **永远不要直接创建或编辑 `*.bilingual.md`**。输出文件只由 `collect` 写。
- **豆包参考是硬性前置**：服务不可用时命令会报错退出。不要降级为自己直译——
  先启动服务（见下），失败就如实报告，不要编造参考。
- **每句必须定稿**：`collect` 缺任何一句就整体拒绝。不允许跳句、并句、增句。
- **占位符 ⟦n⟧ 原样保留**在译文对应位置，不翻译、不增删。
- 所有子命令：stdout 是 JSON（给程序/你解析），stderr 是人读日志。
- 退出码：0 成功；1 用法/输入错误；2 verify 发现问题。

## 前置：豆包服务

```bash
node /Users/jooooody/Projects/doubao_hook/start_doubao.sh          # 豆包带调试端口启动
node /Users/jooooody/Projects/doubao_hook/lib/doubao_server.js     # 监听 127.0.0.1:8765
curl -s localhost:8765/health                                      # ok:true 即就绪
```

单句豆包调用可达数分钟，客户端超时默认 10 分钟（`DOUBAO_TIMEOUT_MS` 可调）。
调用是串行的，不要尝试并行化。

## 工作流（按顺序）

### 1. split — 切块 + 拆句

```bash
npx tsx src/cli.ts split input.md
```

```json
{ "inputFile": "x.md", "blocks": [ { "code": "002", "kind": "para",
  "sentenceCount": 2, "sentences": [ { "id": 1, "text": "Hello world. " } ] } ] }
```

- `code` 无后缀 = 可译块；`p` 后缀 = 直通块（不翻译）；`b` = 空行（忽略）。
- 句子 id 从 1 起，块内连续。`text` 是掩码还原后的完整原文。
- 结果已落盘 `artifacts/state.json`，后续步骤按 `code` 引用。

### 2. doubao — 逐块取参考（贵，逐句落盘，可断点续跑）

```bash
npx tsx src/cli.ts doubao input.md 002
```

```json
{ "code": "002", "cached": false,
  "refs": { "1": { "translation": "你好，世界。", "explanation": "……markdown 讲解" },
            "2": { "translation": "…", "explanation": "…" } } }
```

- 串行调 /translate + /explain，每句成功即落盘；中断重跑只补缺句。
- 全部已取过时返回 `cached: true`，无网络调用。
- 服务不可用 / 单句最终失败 → exit 1，已取的句子不丢。

### 3. 你定稿 — 撮合译文

对每块，输入三样：句子原文、豆包直译、豆包完整解释。规则见
`TRANSLATION_STANDARD.md`（必须先读，它是唯一标准）。要点：

- 解释里若含豆包自己斟酌的译文，通常优于直译，作定稿底稿；
  但无论以谁为底稿，都要重写到母语作者水准，忠实性优先。
- 写出 JSON 文件（如 `translations.json`）：

```json
{ "002": { "1": "你好，世界。", "2": "这是一个测试。" },
  "004": { "1": "## 一个标题" } }
```

- key 是块 `code`（字符串），value 的 key 是句子 id（字符串）。

### 4. collect — 拼装双语文件

```bash
npx tsx src/cli.ts collect input.md translations.json
```

```json
{ "ok": true, "output": "/path/to/input.bilingual.md" }
```

- 缺任何一句 → exit 1 并列出 `[{code, sentenceId}]`，不写任何文件。补齐后重跑。
- 译文里的 ⟦n⟧ 占位符由代码还原为原始内容，你只管按标准保留它们。

### 5. verify — 完整性校验

```bash
npx tsx src/cli.ts verify input.md
```

```json
{ "ok": true, "output": "/path/to/input.bilingual.md", "problems": [] }
```

- exit 0 = 通过；exit 2 = `problems` 非空，逐条修复后回到第 3 步（只改对应句子）
  再跑 collect + verify。
- 检查项：直通块字节级原样在位、可译块原文在位、每句占位符对账。

## 调试

- `chunk <input.md>`：只切块不落盘，用于快速看块结构。
- 中断续跑：直接重跑同一步骤，已落盘的部分自动复用。
- 全部重来：删除 `artifacts/` 目录。

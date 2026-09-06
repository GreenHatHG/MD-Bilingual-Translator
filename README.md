# MD-Bilingual-Translator

把英文博客 Markdown 翻译成"原文块 + 换行 + 译文块"的双语对照文档。

## 架构

```
input.md
  │
[代码] remark 切块：段落/标题/引用/列表可译；代码块、frontmatter、
  │    HTML、表格、脚注/链接定义 → 直通原样保留
  │
[代码] 按行拆句：行内 ICU（Intl.Segmenter）分句，零 LLM；
  │    行内代码 / 图片 / 裸 URL / 有序列表序号先掩码为 ⟦n⟧ 防误切
  │
[代码] 逐句串行调豆包 HTTP /translate + /explain（重试 2 次，失败记 null）
  │
[LLM]  每块一次 OpenAI 兼容接口调用：原块 + 编号句子 + 豆包参考
  │    + TRANSLATION_STANDARD.md → JSON [{id, translation}]
  │
[代码] 校验：返回 id 集合必须覆盖拆句 id 集合
  │    兜底阶梯：LLM 译文 → 豆包译文 → 原文 + <!-- TODO -->
  │
[代码] 按原文行结构拼装译文块，追加在原块之后，原子写入 output
```

关键设计：**LLM 不产生任何文件写入，原文区永远由代码从源文件拼装**，因此不存在
"LLM 改坏原文 / 漏块" 的风险；唯一校验点是 LLM 返回的句子 id 对账，缺句由兜底阶梯补齐。

## 切块模型

### 为什么需要直通块（Passthrough）

这个工具做双语翻译：**可译块**（段落/标题/引用/列表）送去翻译，输出时写成
「原文 + 换行 + 译文」；但文档里还有很多**不该翻译也不能动的内容**——
frontmatter、代码块、表格、HTML、分隔线、链接定义等。这些内容就叫
**直通块（passthrough）**：跳过翻译流程，原样（「直通」）进输出文件。

### p 和 b 两种后缀

直通块又分成两种角色，用 code 后缀区分：

| 后缀 | 含义 | 例子 | 作用 |
|---|---|---|---|
| `p`（passthrough） | 块本身是一段实际内容 | `---\ntitle: x\n---`、```` ```js … ``` ```` | 文档的「正文」之一，只是不翻译 |
| `b`（blank line） | 块与块之间的空行/换行 | `"\n\n"`、`"\n"` | 纯空白，不含内容，只负责把块隔开 |

编号 `000`、`001`、`002`… 是所有块（可译、p、b）共享的全局序号，
同时作为 manifest 里的块 ID 用于断点续跑。

### 一次完整的切块过程

```
输入 doc.md                       切块结果
──────────────────────           ─────────────────────────────────────
---                        ┐    000p  "---\ntitle: x\n---"   ← 头部块本身
title: x                   │    001b  "\n\n"                 ← 头部和段落间的空行
---                        ┘    002   "Hello world"         ← 可译段落（无后缀）
                                   003b  "\n"                   ← 文件末尾的换行
Hello world
```

### 为什么空行要单独成块

看 `main.ts` 里输出是怎么拼的：

```
直通块：   outParts.push(raw)                    ← 原样写入
可译块：   outParts.push(raw, "\n", 译文)        ← 原文 + 换行 + 译文
```

可译块自己只补一个 `\n` 用来接译文，**块的间距完全交给 b 块提供**。
如果空行不是独立的 b 块、而是粘在某个块的 raw 末尾，拼双语输出时就会出现
「译文和下一段之间少一个空行」或「原文尾部空行被复制导致译文位置错乱」的问题。

把空行抽成独立 b 块后有个关键性质（`test/markdown.test.ts` 中验证）：
**把所有块的 raw 顺序拼接，就能字节级还原归一化（CRLF→LF）后的原文**。
这样无论最后怎么重排、插入译文，原文的版式结构都不会丢。

## 使用

```bash
npm install
cp .env.example .env        # 填入 OPENAI_API_KEY / OPENAI_MODEL
npm start -- path/to/input.md [output.md]
```

输出默认写到输入同目录的 `<名字>.bilingual.md`，兜底明细写 `report.md`，
过程状态存 `artifacts/manifest.json`。

## 断点续跑

中断后直接重跑同一命令：`manifest.json` 里标记 `done` 的块直接复用已有译文，
只重做未完成的块。**注意**：豆包失败记录也会复用，不会自动重试历史失败；
想全部重来就删除 `artifacts/` 目录。

## 豆包 HTTP 服务

豆包参考通过本地 HTTP 服务接入（doubao_hook 项目的 `doubao_server.js`，接口契约见其
`API.md`），不再走 CLI。服务默认监听 `http://127.0.0.1:8765`，在 `.env` 中配置：

```bash
# .env
DOUBAO_BASE_URL=http://127.0.0.1:8765
```

```bash
# 启动服务（前置：豆包客户端以 --remote-debugging-port=9222 启动，即 ./start_doubao.sh）
node /Users/jooooody/Projects/doubao_hook/doubao_server.js
curl -s localhost:8765/health   # ok:true 表示豆包页面就绪
```

用到的端点：`POST /translate {text, to:"zh"}`、`POST /explain {text}`。
长文上游可达数分钟、限流时请求在服务端挂起排队，客户端超时默认 10 分钟
（`DOUBAO_TIMEOUT_MS` 可调）；服务不可用时自动重试并降级为无豆包参考，不阻塞。

## 测试

```bash
node test/mock-llm.mjs &          # 模拟 OpenAI 接口（:8765）
OPENAI_API_KEY=x OPENAI_BASE_URL=http://localhost:8765/v1 OPENAI_MODEL=mock \
  npx tsx src/main.ts test/sample.md
```

## 目录

| 路径 | 职责 |
|---|---|
| `src/main.ts` | CLI 入口：切块 → 逐块调度 → 拼装输出 |
| `src/markdown.ts` | remark AST 切块，直通分类，gap 空行保留 |
| `src/sentence.ts` | 按行拆句 + ICU 分句 + 占位符掩码/还原 |
| `src/doubao.ts` | 豆包 HTTP 客户端（/translate、/explain；重试、超时、失败置 null） |
| `src/llm.ts` | OpenAI 兼容 chat completions 客户端（重试、超时） |
| `src/prompt.ts` | 每块 user prompt 组装 |
| `src/pipeline.ts` | 单块管线：拆句 → 豆包 → LLM → id 对账 → 行重组 |
| `src/manifest.ts` | artifacts/manifest.json 断点状态 |
| `src/env.ts` | .env 解析与配置 |
| `TRANSLATION_STANDARD.md` | 翻译标准（注入 LLM system prompt） |

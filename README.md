# MD-Bilingual-Translator

把英文博客 Markdown 翻译成"原文块 + 空行 + 译文块"的双语对照文档。

本项目**不是一条全自动管线**：机械步骤（切块、拆句、豆包调用、拼装、校验）
拆成五个独立 CLI 子命令，由 agent 逐步调用。豆包提供翻译 + 解释两个参考，
agent 按 `TRANSLATION_STANDARD.md` 撮合定稿，最后由代码校验成品完整性。

## 架构

```
input.md
  │
[代码] split：remark 切块（段落/标题/引用/列表可译；代码块、frontmatter、
  │    HTML、表格直通）→ 按行 ICU 拆句，行内代码/图片/裸 URL 掩码为 ⟦n⟧
  │    防误切，结果落盘 artifacts/state.json
  │
[代码] doubao：逐句串行调豆包 /translate + /explain（硬性前置，失败即退），
  │    每句落盘，中断重跑不重取
  │
[agent] 定稿：读句子原文 + 豆包直译 + 完整解释 + 翻译标准，写出译文 JSON
  │
[代码] collect：缺句即拒绝；按原文行结构拼装，原文区永远由代码从源文件
  │    拼装，原子写入 output —— agent 从不直接写输出文件
  │
[代码] verify：直通块字节级比对、原文块在位、句子占位符对账
```

核心安全设计：**agent 不产生任何文件写入**。原文区永远由代码从源文件拼装，
agent 唯一的输入是逐句译文，collect 负责对账（缺句直接拒绝，不猜不补）。

## 块模型（为什么长这样）

- **可译块**（无后缀，`kind` = para/heading/quote/list）：进翻译流程。
- **直通块**（code 带 `p` 后缀）：frontmatter、代码块、表格等，原样进输出。
- **空行块**（code 带 `b` 后缀）：块间距，单独成块保证拼双语时空行不乱。

关键性质（测试覆盖）：把所有块的 raw 顺序拼接，就能字节级还原归一化后的原文。
所以无论怎么插入译文，原文版式都不会丢。

## 使用

```bash
npm install
cp .env.example .env        # 默认连 http://127.0.0.1:8765，一般不用改
```

日常翻译交给 agent 做（它自己会按 `AGENTS.md` 的流程调下面这些命令）；
手动跑一遍长这样：

```bash
npx tsx src/cli.ts split   input.md
npx tsx src/cli.ts doubao  input.md 002        # 取块 002 的豆包参考
npx tsx src/cli.ts collect input.md translations.json
npx tsx src/cli.ts verify  input.md
```

输出写到输入同目录的 `<名字>.bilingual.md`。

## 豆包服务（前置）

豆包参考通过本地 HTTP 服务接入（doubao_hook 项目的 `doubao_server.js`）：

```bash
node /Users/jooooody/Projects/doubao_hook/start_doubao.sh   # 豆包带调试端口启动
node /Users/jooooody/Projects/doubao_hook/lib/doubao_server.js
curl -s localhost:8765/health   # ok:true 表示就绪
```

- 服务不可用时命令**明确报错退出，不降级**——豆包参考是硬性前置。
- 长文上游可达数分钟；`DOUBAO_RETRIES` / `DOUBAO_TIMEOUT_MS` 可调（见 `.env.example`）。
- 断点续跑：豆包参考逐句落盘 `artifacts/state.json`，中断重跑只补缺的句子；
  想全部重来就删除 `artifacts/` 目录。

## 测试

```bash
npm test        # markdown 切块 + sentence 拆句，18 个用例
npm run build   # tsc --noEmit
```

## 目录

| 路径 | 职责 |
|---|---|
| `src/cli.ts` | 五个子命令：chunk / split / doubao / collect / verify |
| `src/markdown.ts` | remark AST 切块，直通分类，gap 空行保留 |
| `src/sentence.ts` | 按行拆句 + ICU 分句 + 占位符掩码/还原 |
| `src/doubao.ts` | 豆包 HTTP 客户端（重试，最终失败 throw，不降级） |
| `src/state.ts` | artifacts/state.json 断点状态 |
| `src/env.ts` | .env 解析与配置 |
| `AGENTS.md` | agent 调用契约（命令签名、JSON 格式、硬性规则） |
| `TRANSLATION_STANDARD.md` | 翻译标准（agent 定稿时遵循） |

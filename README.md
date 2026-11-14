# MD-Bilingual-Translator

把英文博客 Markdown 翻译成"原文块 + 空行 + 译文块"的双语对照文档。

本项目**不再是一条全自动管线**：机械步骤（切块、拆句、豆包调用、拼装、校验）
拆成五个独立 CLI 子命令，由 agent（如 pi）逐步调用并撮合定稿。
豆包提供翻译 + 解释两个参考，agent 按 `TRANSLATION_STANDARD.md` 自行定稿。

## 架构

```
input.md
  │
[代码] split：remark 切块（段落/标题/引用/列表可译；代码块、frontmatter、
  │    HTML、表格、脚注/链接定义直通）→ 按行 ICU 拆句，行内代码/图片/裸 URL
  │    /有序列表序号掩码为 ⟦n⟧ 防误切，结果落盘 artifacts/state.json
  │
[代码] doubao：逐句串行调豆包 /translate + /explain（豆包参考是硬性前置，
  │    失败即报错退出，不降级），每句落盘，中断重跑不重取
  │
[agent] 定稿：读句子原文 + 豆包直译 + 完整解释 + TRANSLATION_STANDARD.md，
  │    写出 {blockCode: {sentenceId: 译文}} JSON
  │
[代码] collect：缺句即拒绝；按原文行结构拼装译文块，原文区永远由代码从源
  │    文件拼装，原子写入 output —— agent 从不直接写输出文件
  │
[代码] verify：直通块字节级比对、原文块在位、句子占位符对账，JSON 报告
```

关键设计：**agent 不产生任何文件写入**，原文区永远由代码从源文件拼装；
唯一由 agent 提供的是逐句译文，collect 负责对账（缺句直接拒绝）。

切块模型（可译块 / 直通块 p / 空行 b / 全局编号）的详细说明见
`test/markdown.test.ts` 与 git 历史版 README；核心性质：把所有块的 raw
顺序拼接，就能字节级还原归一化后的原文。

## 使用（agent 工作流）

```bash
npx tsx src/cli.ts split   input.md            # 切块 + 拆句，输出 JSON
npx tsx src/cli.ts doubao  input.md 002        # 取块 002 的豆包参考（串行，落盘）
# … agent 读 refs + TRANSLATION_STANDARD.md，定稿译文，写 translations.json …
npx tsx src/cli.ts collect input.md translations.json   # 拼装双语文件
npx tsx src/cli.ts verify  input.md             # 校验，exit 0 = 通过 / 2 = 有问题
```

- 所有子命令 stdout 输出 JSON，人读日志走 stderr。
- `doubao` 前置：豆包客户端以调试端口启动（doubao_hook 项目 `./start_doubao.sh`），
  然后 `node lib/doubao_server.js`（默认 `http://127.0.0.1:8765`，
  `.env` 里 `DOUBAO_BASE_URL` 可改）。服务不可用时明确报错退出，绝不降级。
- 长文豆包上游可达数分钟；重试次数/超时用 `DOUBAO_RETRIES` / `DOUBAO_TIMEOUT_MS` 调。
- 断点续跑：豆包参考逐句落盘 `artifacts/state.json`，中断重跑只补缺的句子；
  想全部重来就删除 `artifacts/` 目录。
- 输出默认写到输入同目录 `<名字>.bilingual.md`。

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
| `src/doubao.ts` | 豆包 HTTP 客户端（失败重试，最终失败 throw，不降级） |
| `src/state.ts` | artifacts/state.json 断点状态 |
| `src/env.ts` | .env 解析与配置 |
| `TRANSLATION_STANDARD.md` | 翻译标准（agent 定稿时遵循，不再注入 LLM system prompt） |

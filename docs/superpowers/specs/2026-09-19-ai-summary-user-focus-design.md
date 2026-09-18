# AI 总结「用户关注方向」自定义 — 设计文档

- 日期：2026-09-19
- 状态：已与用户逐节确认（入口=总结时弹窗；模板强度=骨架固定+可追加专属章节；方案=纯弹窗注入）
- 关联：`src/main/prompts/summary.md`、`src/main/ipc.js`、`src/main/core/summarize-doc.js`、`src/main/core/settings-store.js`、`src/preload/index.js`、`src/renderer/src/views/LibraryView.vue`

## 1. 背景与问题

现有 AI 总结（资料库 →「AI总结」按钮）使用固定四层模板：快速概览 / 结构化深度总结（本节要点+关键原话）/ 全时间线覆盖 / 总结与行动项。模板保证了输出格式、术语和时间戳链接规范，但**无法匹配用户的特定识别需求**——例如用户观看"电影配乐盘点"视频后想要"列出提到的电影和配乐"，通用模板只会产出主题分节总结，清单信息被埋在正文里。

用户明确要求：允许自定义总结方向，但**不得让用户破坏模板**——文档格式与术语规范必须保住。即"可控的用户自定义"。

## 2. 目标与非目标

**目标**

1. 用户在每次总结时可以填写一段"关注方向"自由文本（可留空，留空 = 现有通用模板，行为完全不变）。
2. 方向影响总结的内容侧重；当方向要求清单/表格类产出时，可在深度总结之后追加一个专属章节。
3. 四层骨架、格式要求（时间戳链接、简体中文、截图/代码块保留）始终不变。
4. 记住上次填写的内容，下次弹窗预填（清空也会被记住）。
5. 超长文档的分块总结与最终合成两条路径都携带方向。

**非目标（YAGNI）**

- 不做内置快捷方向标签（可作后续迭代）。
- 不做方向的历史记录列表/管理。
- 不允许用户编辑模板本身。
- 方向不写入输出文件名，输出仍为 `AI总结_<视频名>.md`（覆盖旧总结）。

## 3. 决策记录

| 决策点 | 结论 | 备选与否决理由 |
|---|---|---|
| 入口与作用范围 | 总结时弹窗输入，单次生效，记住上次输入 | 否决设置页全局配置（所有视频共享一个方向不灵活）；否决两者结合（UI 与状态更重） |
| 模板强度 | 骨架固定 + 允许按方向追加一个专属章节 | 否决"仅引导侧重"（清单类需求会被埋进分节）；否决"允许重构中间层"（违背模板保留约束） |
| 实现方案 | 弹窗 + 提示词变量注入（方案一） | 否决快捷标签版（先落地最简）；否决模板文件级自定义（易改坏格式） |

## 4. 设计

### 4.1 数据流

```
LibraryView「AI总结」(.md)
  → 弹窗（textarea 预填 settings.lastSummaryFocus）
  →「开始总结」→ window.desktop.summarizeDoc(filePath, focus)
  → preload: invoke("library:summarize", { filePath, focus })
  → ipc.js:
      focus = sanitizeFocus(raw)            // trim、压缩空白、截断 500 字
      settingsStore.save({...load(), lastSummaryFocus: focus})   // 原样记住（含清空）
      base    = loadPromptSection("summary.md", "System prompt", { title, content, userFocusBlock })
      focusBl = focus ? loadPromptSection("summary.md", "User focus block", { userFocus: focus }) : ""
      prompt  = ... 见 4.3 组装规则
  → requestAiCompletion → 写出 AI总结_<name>.md（不变）
```

### 4.2 UI（LibraryView.vue）

- 点「AI总结」且当前文件为 .md 时，先弹出内联模态（复用 TranscriptView 的模态样式先例；打开时按现有机制调用 `view:set-visible` 隐藏内嵌浏览器，关闭时恢复）。
- 模态内容：
  - 标题：「总结关注方向（可选）」
  - textarea：3 行、maxlength 500，placeholder：`如：列出视频中提到的电影和配乐；提取分步骤操作清单；只提取术语和定义`
  - 底部小字：「留空使用通用模板；总结的固定结构与格式不受影响」
  - 按钮：「取消」（Esc）、「开始总结」（主按钮，Ctrl+Enter）
- 确认后走现有 `summarizeStatus` 流程（总结中… / ✓ 已生成 / ⚠️ 失败）。

### 4.3 提示词组装（核心）

**`summary.md` 变更两处：**

1. `## System prompt` 主段落**仅在「标题：{title}」这一行之前新增一个占位行 `{userFocusBlock}`**（其余一字不改）。
   > 设计微调说明：此前口头方案是"主段落完全不动、focus 块整体追加在 prompt 末尾"；落文档时改为占位行注入，使方向指令位于格式要求之后、长文档内容之前——指令位置更合理。占位行由唯一的调用方 ipc.js 始终传值（空 focus 传空串），不会泄漏占位符。
2. 新增独立小节 `## User focus block`（内容为一个 fenced code block，供 `loadPromptSection` 按 heading 读取）：

```
**用户重点关注方向（本次总结的附加要求，不得改变上述结构定义与格式要求）**

用户指定的方向：{userFocus}

- 「结构化深度总结」的分节与「本节要点」优先覆盖与该方向相关的内容。
- 若该方向要求清单、表格、对照等可枚举的产出（如"列出所有提到的X"），在「结构化深度总结」之后追加一个专属章节（### 标题自拟、紧扣方向），逐项列出，保留 [MM:SS](url) 时间戳链接。
- 与该方向无关的内容仍需简要覆盖，保证全时间线完整，但篇幅从简。
- 文档其余部分的结构、层级、术语与格式规范保持不变。
```

**分块路径（content > 100k 字符）：**

- 每一块的 prompt 同样注入 `userFocusBlock`。
- 最终合成调用的提示词追加一句（由纯函数生成）：
  `用户重点关注方向：{focus}。各分块总结中为该方向追加的专属章节，在合成时必须保留并合并去重。`

### 4.4 纯函数与各文件改动清单

| 文件 | 改动 |
|---|---|
| `src/main/core/summarize-doc.js` | 新增 `sanitizeFocus(value)` 与 `buildSynthesisFocusInstruction(focus)`（空返回 ""）|
| `src/main/prompts/summary.md` | System prompt 增 `{userFocusBlock}` 占位行；新增 `## User focus block` 小节 |
| `src/main/ipc.js` | `library:summarize` 接收 focus、清洗、持久化、组装 focusBlock、分块与合成两路径注入 |
| `src/main/core/settings-store.js` | `normalize` 增加 `lastSummaryFocus: trim(input.lastSummaryFocus).slice(0,500)` |
| `src/preload/index.js` | `summarizeDoc: (filePath, focus = "") => invoke("library:summarize", { filePath, focus })` |
| `src/renderer/src/views/LibraryView.vue` | 弹窗 UI 与状态；`summarizeDoc(path, focus)` 调用 |

`sanitizeFocus` 语义明确化：`String(value ?? "").trim().slice(0, 500)`，不做其他改写（保留用户原始表述）。

### 4.5 边界与错误处理

- 旧 settings.json 无 `lastSummaryFocus` → `normalize` 默认 `""`，无迁移逻辑。
- focus 仅做长度与首尾清洗；空串走通用模板（输出与当前版本结构一致）。
- 弹窗取消：不发请求、不改设置。
- AI 调用失败路径（NO_AI_KEY / 超时 / 响应过大）沿用现有处理，不因 focus 引入新错误分支。
- `{userFocusBlock}` 占位符泄漏防护：ipc.js 是唯一调用方且恒传该变量；User focus block 小节仅在 focus 非空时加载。

### 4.6 测试（node:test，与 tests/ 现有风格一致）

1. `sanitizeFocus`：null/undefined → ""；首尾空白去除；超 500 字截断；中间换行保留。
2. `buildSynthesisFocusInstruction`：空 → ""；非空 → 包含方向原文与"保留并合并"指令。
3. settings `normalize`：缺字段默认 ""；超长截断；非字符串容错。
4. prompt 注入断言：`loadPromptSection("summary.md", "User focus block", { userFocus: "X" })` 结果包含 `X` 原文与「专属章节」字样；`System prompt` 段落含 `{userFocusBlock}` 占位行且位于「标题：」行之前。占位符无残留与最终位置由验收标准 1/2 手动覆盖。

### 4.7 验收标准（手动）

1. 留空直接总结 → 产出文档结构与现在完全一致。
2. 输入"列出视频中提到的电影和配乐"对《神曲就该配好片》字幕文档总结 → 快速概览/深度总结/行动项骨架俱在，且出现逐项电影+配乐清单章节（带时间戳）。
3. 多 P 长文档分块总结 → 合成结果保留专属章节。
4. 再次打开弹窗 → 预填上次方向；清空后总结 → 下次弹窗为空。
5. 输入 >500 字 → 实际生效 500 字，弹窗 maxlength 已限制。

## 5. 后续迭代候选（本次不做）

- 内置快捷方向标签（教程步骤提取 / 清单盘点 / 术语提取 / 只看结论）。
- 方向历史下拉。
- 导出队列批量总结时应用方向的策略。

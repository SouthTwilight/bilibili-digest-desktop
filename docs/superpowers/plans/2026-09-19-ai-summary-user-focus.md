# AI 总结「用户关注方向」实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 资料库 AI 总结支持用户在弹窗中填写"关注方向"，注入提示词影响内容侧重并允许追加专属章节；留空行为与现状完全一致。

**架构：** LibraryView 弹窗收集方向 → preload 透传 → ipc `library:summarize` 清洗（`sanitizeFocus`，500 字截断）并记住到 `settings.lastSummaryFocus` → 非空时从 `summary.md#User focus block` 渲染指令块，经 `{userFocusBlock}` 占位行注入主模板（位于「标题：」之前）；分块路径每块注入、合成提示词追加保留指令。模板四层骨架与格式要求零改动。

**技术栈：** Electron + electron-vite、Vue 3 (`<script setup>`)、node:test。规格：`docs/superpowers/specs/2026-09-19-ai-summary-user-focus-design.md`

**注意：** 任务 3 改模板后、任务 4 改调用方前，运行中的应用会泄漏 `{userFocusBlock}` 占位符（测试不受影响）——两个任务必须同一次发布前落地。

---

### 任务 1：settings 记住上次方向（lastSummaryFocus）

**文件：**
- 修改：`src/main/core/settings-store.js`（`normalize` 函数，约 76-89 行的返回对象）
- 测试：`tests/settings.test.mjs`（文件末尾追加）

- [ ] **步骤 1：编写失败的测试**

在 `tests/settings.test.mjs` 末尾追加：

```js
test("lastSummaryFocus: 默认空串、去首尾空白、非字符串容错、500 字截断", () => {
  assert.equal(normalize({}).lastSummaryFocus, "");
  assert.equal(normalize({ lastSummaryFocus: "  列出电影和配乐  " }).lastSummaryFocus, "列出电影和配乐");
  assert.equal(normalize({ lastSummaryFocus: 42 }).lastSummaryFocus, "");
  assert.equal(normalize({ lastSummaryFocus: "x".repeat(600) }).lastSummaryFocus.length, 500);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test`
预期：FAIL，`lastSummaryFocus` 为 `undefined`（assert.equal 得到 undefined ≠ ""）

- [ ] **步骤 3：编写最少实现代码**

在 `src/main/core/settings-store.js` 的 `normalize` 返回对象中，`saveDir` 一行之后插入：

```js
    // Free-form "focus" text for the library AI-summary dialog; remembered
    // verbatim (including empty) so the dialog prefills the last direction.
    lastSummaryFocus: trimKey(input.lastSummaryFocus).slice(0, 500),
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test`
预期：全部 PASS（现有测试无 deepEqual 整对象断言，新增字段不破坏）

- [ ] **步骤 5：Commit**

```bash
git add src/main/core/settings-store.js tests/settings.test.mjs
git commit -m "feat: settings 新增 lastSummaryFocus 记住上次 AI 总结关注方向"
```

---

### 任务 2：focus 清洗与合成指令纯函数

**文件：**
- 修改：`src/main/core/summarize-doc.js`（文件末尾追加）
- 测试：`tests/summary-focus.test.mjs`（新建）

- [ ] **步骤 1：编写失败的测试**

新建 `tests/summary-focus.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitDocIntoChunks,
  sanitizeFocus,
  buildSynthesisFocusInstruction,
} from "../src/main/core/summarize-doc.js";

test("sanitizeFocus: 空值容错、去首尾、保留中间换行、500 字截断", () => {
  assert.equal(sanitizeFocus(undefined), "");
  assert.equal(sanitizeFocus(null), "");
  assert.equal(sanitizeFocus(123), "123");
  assert.equal(sanitizeFocus("  列出电影和配乐  "), "列出电影和配乐");
  assert.ok(sanitizeFocus("多行\n方向\n保留换行").includes("\n"));
  assert.equal(sanitizeFocus("x".repeat(600)).length, 500);
});

test("buildSynthesisFocusInstruction: 空向向返回空串，非空返回保留合并指令", () => {
  assert.equal(buildSynthesisFocusInstruction(""), "");
  assert.equal(buildSynthesisFocusInstruction("   "), "");
  const text = buildSynthesisFocusInstruction("列出电影和配乐");
  assert.match(text, /列出电影和配乐/);
  assert.match(text, /专属章节/);
  assert.match(text, /保留并合并/);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/summary-focus.test.mjs`
预期：FAIL，`sanitizeFocus is not a function`

- [ ] **步骤 3：编写最少实现代码**

`src/main/core/summarize-doc.js` 末尾追加：

```js
// ---- User focus (AI summary direction) -----------------------------------

// The focus text rides into the prompt verbatim; only trim and cap it so a
// stray paste cannot blow up the request or the stored settings.
export function sanitizeFocus(value) {
  return String(value ?? "").trim().slice(0, 500);
}

// Extra instruction appended to the multi-chunk synthesis prompt so the
// per-chunk focus sections survive the final merge.
export function buildSynthesisFocusInstruction(focus) {
  const clean = sanitizeFocus(focus);
  if (!clean) return "";
  return (
    `用户重点关注方向：${clean}。` +
    "各分块总结中为该方向追加的专属章节，在合成时必须保留并合并去重。"
  );
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test tests/summary-focus.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/main/core/summarize-doc.js tests/summary-focus.test.mjs
git commit -m "feat: summarize-doc 新增 focus 清洗与分块合成保留指令纯函数"
```

---

### 任务 3：summary.md 模板新增注入块 + 加载测试

**文件：**
- 修改：`src/main/prompts/summary.md`
- 测试：`tests/summary-focus.test.mjs`（追加）

- [ ] **步骤 1：编写失败的测试**

`tests/summary-focus.test.mjs` 顶部 import 区追加一行：

```js
import { loadPromptSection } from "../src/main/core/ai.js";
```

文件末尾追加：

```js
test("System prompt 含 {userFocusBlock} 占位行且位于标题行之前", () => {
  const prompt = loadPromptSection("summary.md", "System prompt", {
    title: "T",
    content: "C",
    userFocusBlock: "[FOCUS]",
  });
  assert.ok(prompt.includes("[FOCUS]"));
  assert.ok(prompt.includes("标题：T"));
  assert.ok(prompt.indexOf("[FOCUS]") < prompt.indexOf("标题：T"));
  assert.ok(prompt.includes("资料内容："));
});

test("User focus block 渲染方向原文与专属章节/时间戳要求", () => {
  const block = loadPromptSection("summary.md", "User focus block", {
    userFocus: "列出电影和配乐",
  });
  assert.match(block, /列出电影和配乐/);
  assert.match(block, /专属章节/);
  assert.match(block, /时间戳/);
});

test("User focus block 变量替换无残留", () => {
  const block = loadPromptSection("summary.md", "User focus block", { userFocus: "X" });
  assert.ok(!block.includes("{userFocus}"));
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/summary-focus.test.mjs`
预期：第一条 FAIL（占位行不存在）、第二条 FAIL（`Prompt section not found: summary.md#User focus block`）、第三条 FAIL

- [ ] **步骤 3：修改模板**

`src/main/prompts/summary.md` 两处修改：

**3a.** System prompt 代码块内，把结尾部分：

```
标题：{title}

资料内容：

{content}
```

改为：

```
{userFocusBlock}

标题：{title}

资料内容：

{content}
```

**3b.** 在 `## Variables` 小节之前新增一个小节（独立 fenced 代码块）：

````
## User focus block

```
**用户重点关注方向（本次总结的附加要求，不得改变上述结构定义与格式要求）**

用户指定的方向：{userFocus}

- 「结构化深度总结」的分节与「本节要点」优先覆盖与该方向相关的内容。
- 若该方向要求清单、表格、对照等可枚举的产出（如"列出所有提到的X"），在「结构化深度总结」之后追加一个专属章节（### 标题自拟、紧扣方向），逐项列出，保留 [MM:SS](url) 时间戳链接。
- 与该方向无关的内容仍需简要覆盖，保证全时间线完整，但篇幅从简。
- 文档其余部分的结构、层级、术语与格式规范保持不变。
```
````

并在 `## Variables` 列表末尾追加两行：

```markdown
- `{userFocusBlock}` — 渲染后的 User focus block 内容；无方向时为空串。调用方必须始终传该变量（空串安全），避免占位符泄漏。
- `{userFocus}` — 清洗后的用户关注方向文本（见 User focus block 小节）。
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test tests/summary-focus.test.mjs`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/main/prompts/summary.md tests/summary-focus.test.mjs
git commit -m "feat: summary 模板新增用户关注方向注入块（四层骨架零改动）"
```

---

### 任务 4：ipc + preload 链路注入

**文件：**
- 修改：`src/main/ipc.js`（第 7 行 import 与 `library:summarize` handler，约 383-462 行）
- 修改：`src/preload/index.js:19`

- [ ] **步骤 1：修改 import**

`src/main/ipc.js` 第 7 行：

```js
import { splitDocIntoChunks } from "./core/summarize-doc.js";
```

改为：

```js
import {
  splitDocIntoChunks,
  sanitizeFocus,
  buildSynthesisFocusInstruction,
} from "./core/summarize-doc.js";
```

- [ ] **步骤 2：改造 handler**

`library:summarize` handler 内，将 `const settings = settingsStore.load();`（约 394 行）至合成调用结束（约 446 行）替换为：

```js
      const settings = settingsStore.load();
      // User-typed summary direction: sanitize, remember verbatim (empty
      // included) so the dialog prefills the last direction, and render the
      // optional prompt block. The placeholder must always be supplied.
      const userFocus = sanitizeFocus(focus);
      settingsStore.save({ ...settings, lastSummaryFocus: userFocus });
      const userFocusBlock = userFocus
        ? loadPromptSection("summary.md", "User focus block", { userFocus })
        : "";
      // Whole-video multi-P exports can exceed the model's context window.
      // Split at section boundaries, summarize each chunk with the same
      // four-layer prompt, then synthesize — no silent truncation.
      const chunks = splitDocIntoChunks(content, 100_000);
      let text;
      if (chunks.length <= 1) {
        pushProgress({ phase: "summary", title: "正在生成 AI 总结", subtitle: "长文档需要一两分钟" });
        const systemPrompt = loadPromptSection("summary.md", "System prompt", {
          title: videoName,
          content,
          userFocusBlock,
        });
        text = await requestAiCompletion({
          settings,
          maxTokens: 8192,
          messages: [{ role: "user", content: systemPrompt }],
        });
      } else {
        const partSummaries = [];
        for (let i = 0; i < chunks.length; i += 1) {
          pushProgress({
            phase: "summary",
            title: "正在生成 AI 总结",
            subtitle: `长文档已分 ${chunks.length} 块，正在总结第 ${i + 1}/${chunks.length} 块`,
          });
          const systemPrompt = loadPromptSection("summary.md", "System prompt", {
            title: `${videoName}（第 ${i + 1}/${chunks.length} 块）`,
            content: chunks[i],
            userFocusBlock,
          });
          partSummaries.push(
            await requestAiCompletion({
              settings,
              maxTokens: 8192,
              messages: [{ role: "user", content: systemPrompt }],
            }),
          );
        }
        pushProgress({ phase: "summary", title: "正在汇总各块总结", subtitle: "最后一步" });
        const focusInstruction = buildSynthesisFocusInstruction(userFocus);
        text = await requestAiCompletion({
          settings,
          maxTokens: 8192,
          messages: [
            {
              role: "user",
              content:
                `以下是一份长文档（约 ${content.length} 字符）按顺序分块总结的结果。请把它们综合成一份完整的总结文档，` +
                "遵循与分块总结相同的结构（快速概览 / 结构化深度总结 / 总结与行动项）：合并各块中重复的主题，" +
                "按内容自然脉络重新组织分节，保留所有时间戳链接和关键原话，不要遗漏任何一块的要点。" +
                focusInstruction +
                "\n\n" +
                partSummaries.map((s, i) => `--- 第 ${i + 1} 块总结 ---\n${s}`).join("\n\n"),
            },
          ],
        });
      }
```

其余部分（outFile 写出、错误处理）不动。同时 handler 签名保持 `async (_event, { filePath, focus })`（已是解构，仅需在参数里加上 `focus`）。

- [ ] **步骤 3：修改 preload**

`src/preload/index.js:19`：

```js
  summarizeDoc: (filePath) => ipcRenderer.invoke("library:summarize", { filePath }),
```

改为：

```js
  summarizeDoc: (filePath, focus = "") =>
    ipcRenderer.invoke("library:summarize", { filePath, focus }),
```

- [ ] **步骤 4：运行全部测试**

运行：`npm test`
预期：全部 PASS（ipc 无新增单测，注入逻辑已被任务 2/3 的纯函数与模板测试覆盖）

- [ ] **步骤 5：Commit**

```bash
git add src/main/ipc.js src/preload/index.js
git commit -m "feat: AI总结链路注入用户关注方向（单次/分块/合成三路径）"
```

---

### 任务 5：LibraryView 弹窗 UI

**文件：**
- 修改：`src/renderer/src/views/LibraryView.vue`

- [ ] **步骤 1：替换 script 中 summarize 相关逻辑**

将 `const summarizing = ref(false);` 起至 `summarizeDoc` 函数结束（约 43-71 行）替换为：

```js
const summarizing = ref(false);
const summarizeStatus = ref("");
const focusModal = ref(false);
const focusText = ref("");

function flashStatus(text, ms = 2000) {
  summarizeStatus.value = text;
  setTimeout(() => (summarizeStatus.value = ""), ms);
}

async function openSummarizeDialog() {
  if (summarizing.value || !preview.value) return;
  // Only markdown documents make sense to summarize.
  if (preview.value.kind !== "md" && !preview.value.name.endsWith(".md")) {
    flashStatus("仅支持 Markdown 文件");
    return;
  }
  try {
    const settings = await window.desktop.getSettings();
    focusText.value = settings.lastSummaryFocus || "";
  } catch {
    focusText.value = "";
  }
  // App-level modals render in the window page, which the browser view covers.
  window.desktop.setViewVisible(false);
  focusModal.value = true;
}

function closeSummarizeDialog() {
  focusModal.value = false;
  window.desktop.setViewVisible(true);
}

async function runSummarize() {
  if (summarizing.value || !preview.value) return;
  closeSummarizeDialog();
  summarizing.value = true;
  summarizeStatus.value = "总结中…";
  try {
    const result = await window.desktop.summarizeDoc(preview.value.path, focusText.value);
    if (result.success) {
      summarizeStatus.value = "✓ 已生成 AI 总结";
      await refresh();
      // Auto-open the summary for immediate feedback.
      openWithDefaultApp(result.file);
    } else {
      summarizeStatus.value = `⚠️ ${result.error || "总结失败"}`;
    }
  } finally {
    summarizing.value = false;
    setTimeout(() => (summarizeStatus.value = ""), 3500);
  }
}
```

- [ ] **步骤 2：改模板按钮并追加弹窗**

「AI总结」按钮（约 193 行）改为：

```html
        <button class="btn ghost small" @click="openSummarizeDialog" :disabled="summarizing">AI总结</button>
```

在根节点 `</div>`（`library-layout` 结束标签）之前追加：

```html
    <div v-if="focusModal" class="explain-overlay" @click.self="closeSummarizeDialog">
      <div class="focus-dialog">
        <h3>总结关注方向（可选）</h3>
        <textarea
          v-model="focusText"
          class="focus-input"
          rows="3"
          maxlength="500"
          placeholder="如：列出视频中提到的电影和配乐；提取分步骤操作清单；只提取术语和定义"
          @keydown.esc.stop.prevent="closeSummarizeDialog"
          @keydown.ctrl.enter.prevent="runSummarize"
          @keydown.meta.enter.prevent="runSummarize"
        ></textarea>
        <p class="focus-hint">留空使用通用模板；总结的固定结构与格式不受影响。</p>
        <div class="focus-actions">
          <button class="btn ghost small" @click="closeSummarizeDialog">取消</button>
          <button class="btn small" :disabled="summarizing" @click="runSummarize">开始总结</button>
        </div>
      </div>
    </div>
```

- [ ] **步骤 3：文件末尾追加 scoped 样式**（复用全局 `.explain-overlay` 与 `.btn`；`--surface` 等变量为全局 CSS 变量）

```html
<style scoped>
.focus-dialog {
  width: min(480px, 92vw);
  background: var(--surface);
  border-radius: var(--radius);
  padding: 18px 20px;
  box-shadow: 0 12px 40px rgba(24, 25, 28, 0.25);
}
.focus-dialog h3 {
  margin: 0 0 10px;
  font-size: 15px;
  color: var(--ink);
}
.focus-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
  resize: vertical;
  color: var(--ink);
  background: var(--surface-soft);
}
.focus-input:focus {
  outline: 2px solid var(--blue);
  border-color: transparent;
}
.focus-hint {
  margin: 8px 0 14px;
  font-size: 12px;
  color: var(--muted);
}
.focus-actions {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
}
</style>
```

- [ ] **步骤 4：运行全部测试**

运行：`npm test`
预期：全部 PASS（UI 不在单测范围）

- [ ] **步骤 5：Commit**

```bash
git add src/renderer/src/views/LibraryView.vue
git commit -m "feat: 资料库AI总结弹窗——可填关注方向，留空走通用模板"
```

---

### 任务 6：全量验证与手动验收

- [ ] **步骤 1：全量测试**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 2：手动验收**（`npm run dev`，对照规格 4.7）

1. 留空直接总结 → 产出文档结构与现状一致，无 `{userFocusBlock}` 字样泄漏。
2. 填"列出视频中提到的电影和配乐"总结任一视频文档 → 骨架俱在 + 专属清单章节（带时间戳）。
3. 再次点开弹窗 → 预填上次方向；清空并总结 → 再开弹窗为空。
4. 弹窗中 Esc/点遮罩/取消 → 不发请求、浏览器视图恢复显示。
5. textarea 输入超 500 字被 maxlength 拦截。

- [ ] **步骤 3：收尾 commit（如验收有微调）**

```bash
git add -A
git commit -m "feat: AI总结用户关注方向——验收微调"
```

---

## 自检记录

- **规格覆盖**：4.1 数据流→任务1/2/4/5；4.2 UI→任务5；4.3 提示词→任务3/4；4.4 文件清单→全部任务；4.5 边界→任务1（normalize 默认）、任务4（恒传占位）、任务5（取消不请求）；4.6 测试→任务1/2/3；4.7 验收→任务6。无遗漏。
- **占位符扫描**：所有代码步骤含完整代码，无"待定/适当处理"。
- **类型一致性**：`sanitizeFocus`/`buildSynthesisFocusInstruction`（任务2定义、任务4使用）、`lastSummaryFocus`（任务1定义、任务4持久化、任务5读取）、`userFocusBlock`（任务3定义、任务4传值）名称一致。

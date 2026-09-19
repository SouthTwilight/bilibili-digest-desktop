# 导出执行反馈 + 全局按钮按压动效 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 导出动作点击即有反馈（按钮 loading + 即时 toast），完成/失败主动通知（前台应用内 toast、托盘/最小化系统通知，均可跳任务页），全应用按钮具备按压动效。

**架构：** `export-queue.js` 新增 `buildFinishedNotice(task)` 纯函数；`src/main/index.js` 的 onTaskUpdate 回调追加完成分流（可见→`export:finished` 事件；否则 Electron `Notification`，点击发 `export:navigate-tasks`）；preload 暴露两个新事件；App.vue 挂全局 Toast 卡片（「查看」切到任务页）；TranscriptView 三个导出入口加 `exporting` 互斥与先弹 toast；styles.css 全局 `:active` 动效。

**技术栈：** Electron（BrowserWindow/Notification）、Vue 3、node:test。规格：`docs/superpowers/specs/2026-09-19-export-feedback-design.md`

---

### 任务 1：buildFinishedNotice 纯函数（TDD）

**文件：**
- 修改：`src/main/core/export-queue.js`（`createExportQueue` 定义之前，文件顶部 import 区之后）
- 测试：`tests/export-notice.test.mjs`（新建）

- [ ] **步骤 1：编写失败的测试**

新建 `tests/export-notice.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFinishedNotice } from "../src/main/core/export-queue.js";

const singleTask = {
  status: "done",
  type: "single",
  results: [{ title: "A", status: "done", file: "D:/x/A.md" }],
};

test("running/canceled/空任务不产生完成通知", () => {
  assert.equal(buildFinishedNotice({ status: "running" }), null);
  assert.equal(buildFinishedNotice({ status: "canceled" }), null);
  assert.equal(buildFinishedNotice(null), null);
});

test("单视频全部成功", () => {
  const n = buildFinishedNotice(singleTask);
  assert.equal(n.ok, true);
  assert.equal(n.title, "字幕导出完成");
  assert.equal(n.file, "D:/x/A.md");
});

test("合集全部成功标题带数量", () => {
  const n = buildFinishedNotice({
    status: "done",
    type: "collection",
    results: [
      { status: "done", file: "a" },
      { status: "done", file: "b" },
    ],
  });
  assert.equal(n.ok, true);
  assert.equal(n.title, "合集导出完成（2 个视频）");
});

test("合集部分失败：ok=false 且标题含成功/失败计数", () => {
  const n = buildFinishedNotice({
    status: "done",
    type: "collection",
    results: [
      { status: "done", file: "a" },
      { status: "done", file: "b" },
      { status: "done", file: "c" },
      { status: "failed", error: "x" },
      { status: "failed", error: "y" },
    ],
  });
  assert.equal(n.ok, false);
  assert.match(n.title, /成功 3，失败 2/);
  assert.equal(n.file, "a");
});

test("全部失败：file 为 null", () => {
  const n = buildFinishedNotice({
    status: "done",
    type: "collection",
    results: [{ status: "failed", error: "x" }],
  });
  assert.equal(n.ok, false);
  assert.equal(n.file, null);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/export-notice.test.mjs`
预期：FAIL，`buildFinishedNotice is not a function`

- [ ] **步骤 3：编写最少实现代码**

在 `src/main/core/export-queue.js` 中、`export function createExportQueue` 之前插入：

```js
// Turn a serialized task (the onTaskUpdate payload shape) into a completion
// notice for the main-process router (in-app toast vs OS notification).
// Running and user-canceled tasks produce no notice.
export function buildFinishedNotice(task) {
  if (!task || task.status !== "done") return null;
  const results = Array.isArray(task.results) ? task.results : [];
  const succeeded = results.filter((item) => item.status === "done");
  const failed = results.length - succeeded.length;
  const title =
    failed > 0
      ? `导出完成：成功 ${succeeded.length}，失败 ${failed}`
      : task.type === "collection"
        ? `合集导出完成（${results.length} 个视频）`
        : "字幕导出完成";
  return { ok: failed === 0, title, file: succeeded[0]?.file || null };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test tests/export-notice.test.mjs`
预期：5 项 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/main/core/export-queue.js tests/export-notice.test.mjs
git commit -m "feat: export-queue 新增完成通知纯函数 buildFinishedNotice（任务1/7）"
```

---

### 任务 2：主进程完成分流

**文件：**
- 修改：`src/main/index.js:1`（electron import）与 `src/main/index.js:315-320`（onTaskUpdate 回调）

- [ ] **步骤 1：扩展 electron import**

第 1 行：

```js
import { app, BrowserWindow, WebContentsView, shell, session, ipcMain, Tray, Menu, dialog } from "electron";
```

改为：

```js
import { app, BrowserWindow, WebContentsView, shell, session, ipcMain, Tray, Menu, dialog, Notification } from "electron";
```

- [ ] **步骤 2：追加 buildFinishedNotice import**

第 7 行 `import { createExportQueue } from "./core/export-queue.js";` 改为：

```js
import { createExportQueue, buildFinishedNotice } from "./core/export-queue.js";
```

- [ ] **步骤 3：替换 onTaskUpdate 回调**

将：

```js
    onTaskUpdate: (task) =>
      mainWindow?.webContents.send("export:task-update", task),
```

改为：

```js
    onTaskUpdate: (task) => {
      mainWindow?.webContents.send("export:task-update", task);
      // Completion notice: in-app toast when the window is fronted, a system
      // notification (click = restore + jump to tasks) when trayed/minimized.
      const notice = buildFinishedNotice(task);
      if (!notice) return;
      if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) {
        mainWindow.webContents.send("export:finished", notice);
        return;
      }
      try {
        const notification = new Notification({ title: "Bilibili Digest", body: notice.title });
        notification.on("click", () => {
          mainWindow?.show();
          mainWindow?.focus();
          mainWindow?.webContents.send("export:navigate-tasks");
        });
        notification.show();
      } catch (error) {
        console.warn("[export] system notification failed:", error.message);
      }
    },
```

- [ ] **步骤 4：运行全部测试**

运行：`npm test`
预期：全部 PASS（主进程改动无直接单测，逻辑由任务 1 纯函数覆盖）

- [ ] **步骤 5：Commit**

```bash
git add src/main/index.js
git commit -m "feat: 导出完成通知主进程分流——前台应用内事件/托盘系统通知（任务2/7）"
```

---

### 任务 3：preload 暴露两个新事件

**文件：**
- 修改：`src/preload/index.js`（`onExportTaskUpdate` 之后，约 54 行处）

- [ ] **步骤 1：追加事件桥**

在 `onExportTaskUpdate` 条目之后插入（沿用同文件既有事件模式）：

```js
  onExportFinished: (callback) =>
    ipcRenderer.on("export:finished", (_event, notice) => callback(notice)),
  onNavigateTasks: (callback) =>
    ipcRenderer.on("export:navigate-tasks", () => callback()),
```

- [ ] **步骤 2：运行全部测试**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 3：Commit**

```bash
git add src/preload/index.js
git commit -m "feat: preload 暴露 onExportFinished/onNavigateTasks 事件（任务3/7）"
```

---

### 任务 4：App.vue 全局 Toast 卡片

**文件：**
- 修改：`src/renderer/src/App.vue`

- [ ] **步骤 1：script 增加通知状态（放在 `const active = ref("settings");` 附近的状态区）**

```js
const finishedNotice = ref(null);
let finishedTimer = null;
function showFinishedNotice(notice) {
  finishedNotice.value = notice;
  clearTimeout(finishedTimer);
  finishedTimer = setTimeout(() => (finishedNotice.value = null), 6000);
}
function dismissFinishedNotice() {
  clearTimeout(finishedTimer);
  finishedNotice.value = null;
}
function goTasksFromNotice() {
  active.value = "tasks";
  dismissFinishedNotice();
}
```

- [ ] **步骤 2：onMounted 增加两个订阅（追加到既有 `off.push(...)` 序列末尾）**

```js
  off.push(
    window.desktop.onExportFinished((notice) => showFinishedNotice(notice)),
  );
  off.push(
    window.desktop.onNavigateTasks(() => {
      active.value = "tasks";
    }),
  );
```

- [ ] **步骤 3：模板根元素末尾追加 Toast 卡片（根级 `</div>` 之前，与 sidebar 同级）**

```html
    <div v-if="finishedNotice" class="finished-toast" :class="{ failed: !finishedNotice.ok }">
      <span class="finished-toast-title">{{ finishedNotice.title }}</span>
      <button class="btn ghost small" @click="goTasksFromNotice">查看</button>
      <button class="finished-toast-close" @click="dismissFinishedNotice">×</button>
    </div>
```

- [ ] **步骤 4：文件末尾追加样式（若已有 `<style scoped>` 则并入其中）**

```css
.finished-toast {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 120;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-left: 4px solid #2ecc71;
  border-radius: 10px;
  padding: 12px 14px;
  box-shadow: 0 10px 30px rgba(24, 25, 28, 0.2);
  font-size: 13px;
  color: var(--ink);
}
.finished-toast.failed {
  border-left-color: #e74c3c;
}
.finished-toast-title {
  margin-right: 4px;
}
.finished-toast-close {
  border: none;
  background: none;
  cursor: pointer;
  color: var(--muted);
  font-size: 16px;
  line-height: 1;
}
.finished-toast-close:active {
  transform: scale(0.85);
}
```

- [ ] **步骤 5：运行全部测试 + 构建**

运行：`npm test && npm run build`
预期：测试全 PASS，构建成功

- [ ] **步骤 6：Commit**

```bash
git add src/renderer/src/App.vue
git commit -m "feat: App 级导出完成 Toast 卡片——查看跳任务页（任务4/7）"
```

---

### 任务 5：TranscriptView 三个导出入口的即时反馈

**文件：**
- 修改：`src/renderer/src/views/TranscriptView.vue`（`exportFormat` 状态区 + 三个 handler + 模板按钮）

- [ ] **步骤 1：增加 exporting 状态**

在 `const collectionModal = ref(null);` 之后插入：

```js
const exporting = ref(false);
```

- [ ] **步骤 2：替换 exportSingleNow**

```js
async function exportSingleNow() {
  if (!currentVideo.value || exporting.value) return;
  exporting.value = true;
  // Feedback fires immediately — the collection probe inside the IPC handler
  // can take seconds and must not leave the click feeling dead.
  showToast("已加入导出队列，见「任务」页");
  try {
    const source = transcript.value?.source === "bilibili-subtitle" ? "subtitle" : "asr";
    const result = await window.desktop.exportSingle(currentVideo.value.bvid, currentVideo.value.page, exportFormat.value, source, lastLoadTrack);
    if (result && result.success === false) {
      showToast(`⚠️ ${result.error || "导出失败"}`);
      return;
    }
    error.value = "";
  } catch (e) {
    showToast(`⚠️ ${e.message || "导出失败"}`);
  } finally {
    exporting.value = false;
  }
}
```

- [ ] **步骤 3：替换 exportAllPagesNow**

```js
async function exportAllPagesNow() {
  if (!currentVideo.value || exporting.value) return;
  exporting.value = true;
  showToast("已加入导出队列（全部P合并为一份文档），见「任务」页");
  try {
    const source = transcript.value?.source === "bilibili-subtitle" ? "subtitle" : "asr";
    const result = await window.desktop.exportSingle(currentVideo.value.bvid, currentVideo.value.page, exportFormat.value, source, lastLoadTrack, true);
    if (result && result.success === false) {
      showToast(`⚠️ ${result.error || "导出失败"}`);
      return;
    }
    error.value = "";
  } catch (e) {
    showToast(`⚠️ ${e.message || "导出失败"}`);
  } finally {
    exporting.value = false;
  }
}
```

- [ ] **步骤 4：替换 confirmCollectionExport 的入队段（`if (!items.length) return;` 之后）**

```js
  if (!items.length) return;
  exporting.value = true;
  try {
    const result = await window.desktop.exportCollectionConfirm(modal.collectionTitle, exportFormat.value, items);
    collectionModal.value = null;
    if (result && result.success === false) {
      showToast(`⚠️ ${result.error || "导出失败"}`);
      return;
    }
    showToast(`已加入导出队列（${items.length} 个视频），见「任务」页`);
  } catch (e) {
    collectionModal.value = null;
    showToast(`⚠️ ${e.message || "导出失败"}`);
  } finally {
    exporting.value = false;
  }
```

（说明：合集入口自身有弹窗即视觉反馈，toast 保持 await 之后弹，避免被遮罩盖住；失败时关弹窗让 toast 可见——失败属罕见路径，重开弹窗成本可接受。）

- [ ] **步骤 5：三个按钮加 disabled**

模板中「导出当前字幕」「导出全部P」两个按钮与合集弹窗「开始导出（N 个）」按钮，均追加 `:disabled="exporting"`。

- [ ] **步骤 6：运行全部测试 + 构建**

运行：`npm test && npm run build`
预期：全 PASS，构建成功

- [ ] **步骤 7：Commit**

```bash
git add src/renderer/src/views/TranscriptView.vue
git commit -m "feat: 三个导出入口即时反馈——loading互斥+toast先行+失败分支（任务5/7）"
```

---

### 任务 6：全局按钮按压动效

**文件：**
- 修改：`src/renderer/src/styles.css`（`.btn:hover` 约 205 行之后追加）

- [ ] **步骤 1：追加按压动效规则**

在 `.btn:hover { background: var(--pink-strong); }` 之后插入：

```css
.btn {
  transition: transform 0.08s ease, filter 0.08s ease, background 0.12s ease;
}
.btn:active {
  transform: scale(0.93);
  filter: brightness(0.88);
}
.note-del {
  transition: transform 0.08s ease, filter 0.08s ease, color 0.12s ease;
}
.note-del:active {
  transform: scale(0.85);
  filter: brightness(0.88);
}
```

- [ ] **步骤 2：运行全部测试 + 构建**

运行：`npm test && npm run build`
预期：全 PASS，构建成功

- [ ] **步骤 3：Commit**

```bash
git add src/renderer/src/styles.css
git commit -m "feat: 全局按钮按压动效——缩小+变暗 80ms 回弹（任务6/7）"
```

---

### 任务 7：全量验证与收尾

- [ ] **步骤 1：全量测试**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 2：手动验收**（`npm run dev`，对照规格 4.8 六条）

1. 点「导出当前字幕」：按下瞬间按钮形变 + 立即 toast + 按钮短暂 disabled。
2. 导出期间切页：完成时右下角全局 toast，「查看」跳任务页。
3. 最小化到托盘后完成：系统通知弹出，点击恢复窗口并落在任务页。
4. 失败场景（断网/无字幕）：toast 显示 ⚠️ 文案。
5. 任务页「改下 ASR」重试完成：同样收到完成通知。
6. 全应用按钮（含任务/笔记小按钮）按压有缩小变暗回弹。

- [ ] **步骤 3：收尾**

按 finishing-a-development-branch 流程：本地合并回 main、删除功能分支。

---

## 自检记录

- **规格覆盖**：4.1 点击层→任务5；4.2 完成层分流→任务1/2；4.3 全局 Toast→任务3/4；4.4 按压动效→任务6；4.5 文件清单→全部任务（7 文件+1 测试逐一对应）；4.6 边界→任务1（canceled null）、任务2（try/catch 降级）、任务5（exporting 互斥）、retry 复用 onTaskUpdate 天然覆盖；4.7 测试→任务1；4.8 验收→任务7。无遗漏。
- **占位符扫描**：全部步骤含完整代码/命令，无待定项。
- **类型一致性**：`buildFinishedNotice`（任务1定义、任务2使用）、`onExportFinished`/`onNavigateTasks`（任务3定义、任务4使用）、`exporting`（任务5内闭环）、事件名 `export:finished`/`export:navigate-tasks`（任务2发送、任务3桥接、任务4订阅）三处一致。

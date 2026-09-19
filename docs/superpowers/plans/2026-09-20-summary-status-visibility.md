# AI 总结状态全局可见 + 取消自动打开文件 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** AI 总结/摘要分析的进行中状态在任何页面右下角可见（含分块进度）、由主进程统一发结束信号；总结完成只发通知（前台 Toast 带「打开」/托盘系统通知），移除自动打开文件。

**架构：** App 级订阅既有 `digest:progress` 写入 `store.progress` 并渲染右下角状态卡（单一数据源，OverviewView 停止本地消费）；`index.js` 抽取共享 `pushNoticeToUser(notice, {foregroundEvent, trayClickEvent})` 供导出与总结完成通知复用；`library:summarize` 成功/失败经 `buildSummaryNotice` 发 `summary:finished`，两 AI handler `finally` 发空进度清屏。

**技术栈：** Electron（Notification/BrowserWindow）、Vue 3、node:test。规格：`docs/superpowers/specs/2026-09-20-summary-status-visibility-design.md`

---

### 任务 1：buildSummaryNotice 纯函数（TDD）

**文件：**
- 修改：`src/main/core/summarize-doc.js`（buildSynthesisFocusInstruction 之后）
- 测试：`tests/summary-focus.test.mjs`（import 行与文件末尾追加）

- [ ] **步骤 1：编写失败的测试**

`tests/summary-focus.test.mjs` 的 summarize-doc import 块改为：

```js
import {
  splitDocIntoChunks,
  sanitizeFocus,
  buildSynthesisFocusInstruction,
  buildSummaryNotice,
} from "../src/main/core/summarize-doc.js";
```

文件末尾追加：

```js
test("buildSummaryNotice: 成功带文件与名称", () => {
  const n = buildSummaryNotice({ success: true, videoName: "某视频", file: "D:/x/AI总结_某视频.md" });
  assert.equal(n.kind, "summary");
  assert.equal(n.ok, true);
  assert.equal(n.title, "AI 总结完成：某视频");
  assert.equal(n.file, "D:/x/AI总结_某视频.md");
});

test("buildSummaryNotice: 失败带原因、无原因兜底、成功无 file 兜底", () => {
  const a = buildSummaryNotice({ success: false, error: "API key 被拒绝" });
  assert.equal(a.ok, false);
  assert.match(a.title, /API 总结失败：API key 被拒绝/);
  assert.equal(a.file, null);
  const b = buildSummaryNotice({ success: false });
  assert.match(b.title, /未知错误/);
  const c = buildSummaryNotice({ success: true, videoName: "x" });
  assert.equal(c.file, null);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/summary-focus.test.mjs`
预期：FAIL，`buildSummaryNotice is not a function`

- [ ] **步骤 3：编写最少实现代码**

`src/main/core/summarize-doc.js` 末尾（buildSynthesisFocusInstruction 之后）追加：

```js
// Notice payload for the library AI-summary completion (main-process router
// decides in-app toast vs OS notification; "打开" rides on `file`).
export function buildSummaryNotice({ success, videoName, file, error }) {
  return success
    ? { kind: "summary", ok: true, title: `AI 总结完成：${videoName}`, file: file || null }
    : { kind: "summary", ok: false, title: `AI 总结失败：${error || "未知错误"}`, file: null };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test tests/summary-focus.test.mjs`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/main/core/summarize-doc.js tests/summary-focus.test.mjs
git commit -m "feat: summarize-doc 新增 buildSummaryNotice 完成通知纯函数（任务1/7）"
```

---

### 任务 2：index.js 抽取 pushNoticeToUser 并注入

**文件：**
- 修改：`src/main/index.js`（模块级函数区、createExportQueue 的 onTaskUpdate、registerIpcHandlers 调用点约 354 行）
- 修改：`src/main/core/export-queue.js`（buildFinishedNotice 返回值加 kind）

- [ ] **步骤 1：buildFinishedNotice 加 kind 字段**

`src/main/core/export-queue.js` 的 buildFinishedNotice 返回行改为：

```js
  return { kind: "export", ok: failed === 0, title, file: succeeded[0]?.file || null };
```

- [ ] **步骤 2：新增模块级函数**

`src/main/index.js` 在 `let sidebarWidth = ...` 声明区之后插入：

```js
// Completion notices share one router: in-app event when the window is
// fronted, OS notification (click = restore window) when trayed/minimized.
// trayClickEvent re-delivers the notice (or navigation intent) after restore.
function pushNoticeToUser(notice, { foregroundEvent, trayClickEvent }) {
  if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.webContents.send(foregroundEvent, notice);
    return;
  }
  try {
    const notification = new Notification({ title: "Bilibili Digest", body: notice.title });
    notification.on("click", () => {
      mainWindow?.show();
      mainWindow?.focus();
      mainWindow?.webContents.send(trayClickEvent, notice);
    });
    notification.show();
  } catch (error) {
    console.warn("[notice] system notification failed:", error.message);
  }
}
```

- [ ] **步骤 3：导出分流改调共享函数**

createExportQueue 的 onTaskUpdate（任务"导出完成通知主进程分流"引入的内联块）替换为：

```js
    onTaskUpdate: (task) => {
      mainWindow?.webContents.send("export:task-update", task);
      const notice = buildFinishedNotice(task);
      if (notice) {
        pushNoticeToUser(notice, { foregroundEvent: "export:finished", trayClickEvent: "export:navigate-tasks" });
      }
    },
```

- [ ] **步骤 4：注入 registerIpcHandlers**

调用点（约 354 行）追加一项依赖：

```js
  registerIpcHandlers({
    settingsStore,
    digestCache,
    notesStore,
    exportQueue,
    getBrowserView: () => browserView,
    setBrowserViewVisible,
    resizeSidebar,
    notifyUser: pushNoticeToUser,
  });
```

- [ ] **步骤 5：运行全部测试**

运行：`npm test`
预期：全部 PASS（export-notice 测试无 deepEqual，新增 kind 字段不破坏）

- [ ] **步骤 6：Commit**

```bash
git add src/main/index.js src/main/core/export-queue.js
git commit -m "refactor: 抽取 pushNoticeToUser 完成通知共享分流，导出 notice 增加 kind（任务2/7）"
```

---

### 任务 3：ipc.js 总结完成通知 + 进度结束信号

**文件：**
- 修改：`src/main/ipc.js`（registerIpcHandlers 签名第 25 行、summarize-doc import、`digest:analyze` handler 约 126-180 行、`library:summarize` handler）

- [ ] **步骤 1：签名与 import**

第 25 行签名追加 `notifyUser`：

```js
export function registerIpcHandlers({ settingsStore, digestCache, notesStore, exportQueue, getBrowserView, setBrowserViewVisible, resizeSidebar, notifyUser }) {
```

summarize-doc import 块追加 `buildSummaryNotice`：

```js
import {
  splitDocIntoChunks,
  sanitizeFocus,
  buildSynthesisFocusInstruction,
  buildSummaryNotice,
} from "./core/summarize-doc.js";
```

- [ ] **步骤 2：digest:analyze 加 finally 清空**

handler 的 try/catch 结束后（`} catch (error) { ... }` 与 `});` 之间）插入：

```js
    } finally {
      pushProgress({ phase: "analysis", title: "", subtitle: "" });
    }
```

- [ ] **步骤 3：library:summarize 发通知 + finally 清空**

成功路径：`writeFileSync(outFile, ...)` 之后、`return { success: true, file: outFile };` 之前插入：

```js
      notifyUser?.(
        buildSummaryNotice({ success: true, videoName, file: outFile }),
        { foregroundEvent: "summary:finished", trayClickEvent: "summary:finished" },
      );
```

catch 分支：`return { success: false, error: error.message };` 之前插入：

```js
      notifyUser?.(
        buildSummaryNotice({ success: false, error: error.message }),
        { foregroundEvent: "summary:finished", trayClickEvent: "summary:finished" },
      );
```

catch 块结束后追加 finally：

```js
    } finally {
      pushProgress({ phase: "summary", title: "", subtitle: "" });
    }
```

- [ ] **步骤 4：运行全部测试**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add src/main/ipc.js
git commit -m "feat: AI总结完成通知接入共享分流，analyze/summarize 进度结束信号（任务3/7）"
```

---

### 任务 4：preload 暴露 onSummaryFinished

**文件：**
- 修改：`src/preload/index.js`（onNavigateTasks 之后）

- [ ] **步骤 1：追加事件桥**

```js
  onSummaryFinished: (callback) =>
    ipcRenderer.on("summary:finished", (_event, notice) => callback(notice)),
```

- [ ] **步骤 2：运行全部测试并 Commit**

运行：`npm test`，预期全 PASS。

```bash
git add src/preload/index.js
git commit -m "feat: preload 暴露 onSummaryFinished（任务4/7）"
```

---

### 任务 5：App.vue 状态卡 + 订阅 + Toast 动作分叉

**文件：**
- 修改：`src/renderer/src/App.vue`

- [ ] **步骤 1：import 扩展**

第 1 行 vue import 追加 `computed`；store import 行追加 `progress`：

```js
import { onMounted, onUnmounted, ref, computed } from "vue";
```
```js
import { currentVideo, videoDetails, transcript, progress } from "./store.js";
```

- [ ] **步骤 2：notice 动作分叉**

`goTasksFromNotice` 替换为：

```js
const noticeActionLabel = computed(() =>
  finishedNotice.value?.kind === "summary" ? "打开" : "查看",
);
function runNoticeAction() {
  const notice = finishedNotice.value;
  if (!notice) return;
  if (notice.kind === "summary") {
    if (notice.file) window.desktop.openWithDefaultApp(notice.file);
  } else {
    active.value = "tasks";
  }
  dismissFinishedNotice();
}
```

- [ ] **步骤 3：onMounted 追加两个订阅**

```js
  off.push(
    window.desktop.onDigestProgress((p) => {
      progress.title = p.title || "";
      progress.subtitle = p.subtitle || "";
      progress.visible = !!(p.title || p.subtitle);
    }),
  );
  off.push(
    window.desktop.onSummaryFinished((notice) => showFinishedNotice(notice)),
  );
```

- [ ] **步骤 4：模板——Toast 按钮分叉 + 状态卡**

finished-toast 的按钮改为（失败且无文件的总结不显示按钮）：

```html
    <div v-if="finishedNotice" class="finished-toast" :class="{ failed: !finishedNotice.ok }">
      <span class="finished-toast-title">{{ finishedNotice.title }}</span>
      <button
        v-if="!(finishedNotice.kind === 'summary' && !finishedNotice.file)"
        class="btn ghost small"
        @click="runNoticeAction"
      >{{ noticeActionLabel }}</button>
      <button class="finished-toast-close" @click="dismissFinishedNotice">×</button>
    </div>

    <div v-if="progress.visible" class="running-card">
      <span class="running-dot"></span>
      <div class="running-text">
        <b>{{ progress.title }}</b>
        <span v-if="progress.subtitle">{{ progress.subtitle }}</span>
      </div>
    </div>
```

- [ ] **步骤 5：样式——finished-toast 上移 + 状态卡**

`.finished-toast` 的 `bottom: 20px;` 改为 `bottom: 84px;`；scoped style 末尾追加：

```css
.running-card {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 119;
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 14px;
  box-shadow: 0 10px 30px rgba(24, 25, 28, 0.2);
  font-size: 12.5px;
  color: var(--ink);
}
.running-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--pink);
  animation: running-pulse 1.2s ease-in-out infinite;
  flex: none;
}
@keyframes running-pulse {
  0%, 100% { opacity: 0.35; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1.15); }
}
.running-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.running-text span {
  color: var(--muted);
  font-size: 12px;
}
```

- [ ] **步骤 6：运行全部测试 + 构建并 Commit**

运行：`npm test && npm run build`，预期全 PASS、构建成功。

```bash
git add src/renderer/src/App.vue
git commit -m "feat: 全局进行中状态卡+总结完成Toast打开动作（任务5/7）"
```

---

### 任务 6：LibraryView 删自动打开 + OverviewView 移除本地进度

**文件：**
- 修改：`src/renderer/src/views/LibraryView.vue`（runSummarize 内）
- 修改：`src/renderer/src/views/OverviewView.vue`

- [ ] **步骤 1：LibraryView 删除自动打开**

runSummarize 成功分支中删除这两行：

```js
      // Auto-open the summary for immediate feedback.
      openWithDefaultApp(result.file);
```

（保留 `await refresh();` 与状态文案。）

- [ ] **步骤 2：OverviewView 移除 progress 消费**

五处删除：① import 行去掉 `progress`（保留其余）；② watch 块内 `progress.visible = false;`；③ generate() 开头 `progress.visible = false;`；④ generate() finally 内 `progress.visible = false;`；⑤ script 底部整段 `window.desktop?.onDigestProgress?.((p) => {...});` 订阅；⑥ 模板中 `progress-note` 整块：

```html
    <div v-if="progress.visible" class="progress-note">
      {{ progress.title }}
      <span v-if="progress.subtitle"> · {{ progress.subtitle }}</span>
    </div>
```

- [ ] **步骤 3：运行全部测试 + 构建并 Commit**

运行：`npm test && npm run build`，预期全 PASS、构建成功。

```bash
git add src/renderer/src/views/LibraryView.vue src/renderer/src/views/OverviewView.vue
git commit -m "feat: 移除AI总结自动打开文件；摘要页进度消费收归全局（任务6/7）"
```

---

### 任务 7：全量验证与收尾

- [ ] **步骤 1：全量测试**

运行：`npm test`
预期：全部 PASS

- [ ] **步骤 2：手动验收**（`npm run dev`，对照规格 4.10 六条）

1. 发起 AI 总结→切设置页：右下角状态卡可见；长文档显示分块 N/M。
2. 完成后文件不自动弹出；Toast「AI 总结完成：…」，点「打开」才打开。
3. 托盘状态下完成：系统通知→点击恢复窗口→Toast 呈现。
4. 失败场景：红边 Toast、无按钮。
5. 摘要页生成分析：状态卡全局可见、完成消失；摘要页无本地进度行。
6. 导出完成通知不回归（查看跳任务页）。

- [ ] **步骤 3：收尾**

按 finishing-a-development-branch 流程本地合并回 main、删除功能分支。

---

## 自检记录

- **规格覆盖**：4.1 状态卡→任务5；4.2 结束信号→任务3；4.3 分流复用与 notice/kind→任务1/2/3；4.4 Toast 分叉→任务5；4.5 两个 View 瘦身→任务6；4.6 preload→任务4；4.7 清单→逐任务对应；4.8 边界→任务2（warn 降级）、任务5（无文件不显示按钮）、历史 notice 兼容（缺 kind 按 export 分支）；4.9 测试→任务1；4.10→任务7。无遗漏。
- **占位符扫描**：全部步骤含完整代码，无待定项。
- **类型一致性**：`pushNoticeToUser(notice, {foregroundEvent, trayClickEvent})`（任务2定义、任务3调用）；`buildSummaryNotice`（任务1定义、任务3调用）；`notifyUser` 注入名（任务2传、任务3签名收）；事件名 `summary:finished`（任务3发、任务4桥、任务5订）三处一致；`kind: "export"|"summary"`（任务2/1定义、任务5消费）一致。

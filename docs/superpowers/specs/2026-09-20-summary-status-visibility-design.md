# AI 总结执行状态全局可见 + 取消自动打开文件 — 设计文档

- 日期：2026-09-20
- 状态：已与用户确认（状态展示形式=右下角进行中状态卡，按推荐方案；完成只通知不自动打开）
- 关联锚点：`src/main/ipc.js`（`digest:analyze` 约 156 行 / `library:summarize` 约 389 行，均只发起 pushProgress 无收尾清空）、`src/renderer/src/store.js`（progress 响应式）、`src/renderer/src/views/OverviewView.vue`（digest:progress 唯一消费者 + 本地 progress-note）、`src/main/index.js`（导出完成分流逻辑，待抽取复用）、`src/renderer/src/views/LibraryView.vue`（runSummarize 中的 openWithDefaultApp）

## 1. 背景与问题

资料库 AI 总结的执行状态**只存在于 LibraryView 的本地 ref**，而 App.vue 以 `v-if` 挂载各页面——切页即卸载组件：

1. 切到设置页/字幕页再回来，"总结中…"状态消失，无从判断执行情况。
2. 「任务」页没有 AI 总结任务，跨页完全没有可见的执行状态。
3. 主进程 IPC 并不随组件卸载而中断：完成后**已卸载组件闭包里的 `openWithDefaultApp` 仍会执行**，用户在其他页面时文件"自己弹出来"。
4. 同根因的既有隐患：`digest:progress` 事件全应用只有摘要页（OverviewView）消费；摘要分析的进度同样跨页不可见，且主进程从不发"结束"信号，进度条清空完全依赖摘要页自身卸载/完成时机。

既有可复用资产：主进程 `pushProgress`→`digest:progress` 全局事件通道（AI 总结已在发分块进度文案）；`store.progress` 响应式；上一功能刚落地的完成通知分流（前台 App toast / 托盘系统通知）与 App 级 Toast 卡片。

## 2. 目标与非目标

**目标**

1. AI 总结与摘要分析的**进行中状态在任何页面可见**：App 级右下角"进行中状态卡"（呼吸圆点 + 标题 + 副标题），单一数据源 `store.progress`。
2. 进度生命周期的**结束信号由主进程统一发送**（analyze/summarize 两 handler 的 finally 清空），根治进度卡滞留。
3. AI 总结完成/失败只**发通知**（复用智能分流）：前台→App Toast（带「打开」按钮，用户主动点击才打开文件）；托盘/最小化→系统通知（点击唤回窗口后弹同一 Toast）。
4. 移除完成后的自动打开文件行为。

**非目标（YAGNI）**

- 不把 AI 总结任务化并入「任务」页（卡片化方案已被否决）。
- 不做并发总结的队列化/互斥强化（现象为进度文案互相覆盖、通知逐条，可接受）。
- 不改动摘要页的分析流程本身。

## 3. 决策记录

| 决策点 | 结论 | 说明 |
|---|---|---|
| 进行中状态形式 | App 级右下角状态卡 | 提问未获答复，按推荐执行：复用 digest:progress 与右下角视觉体系，改动最小；任务页卡片化改动过大、顶部条与现有 toast 体系不一致 |
| 完成行为 | 仅通知 + 用户主动「打开」 | 用户明确要求；自动打开移除 |
| 进度渲染归属 | 移除 OverviewView 本地 progress-note，全局卡唯一渲染 | 单一数据源；OverviewView 对 progress 的一切本地写入一并移除，store.progress 只由 App 级订阅主进程事件驱动 |
| 分流复用 | 从导出分流处抽 `pushNoticeToUser` 共享函数 | 导出与总结共用，行为参数（前台事件名/托盘点击事件名）不同 |

## 4. 设计

### 4.1 全局进行中状态卡（App.vue）

- App.vue 从 `store.js` 引入既有 `progress`，模板追加（右下角，完成 Toast 下方错开）：

```html
<div v-if="progress.visible" class="running-card">
  <span class="running-dot"></span>
  <div class="running-text">
    <b>{{ progress.title }}</b>
    <span v-if="progress.subtitle">{{ progress.subtitle }}</span>
  </div>
</div>
```

- 样式：`position: fixed; right: 20px; bottom: 20px`，卡片风格与 finished-toast 一致（surface 底、圆角、阴影）；`.running-dot` 为 8px 圆点 + CSS `@keyframes` 呼吸（透明度/缩放）动画；**finished-toast 的 bottom 从 20px 调整为 84px**，两者同屏不重叠。
- App 级新增订阅 `onDigestProgress`（与 OverviewView 现在做的相同：写 `progress.title/subtitle/visible`）——成为唯一消费者。

### 4.2 进度结束信号（ipc.js）

- `digest:analyze` 与 `library:summarize` 两 handler 各在 `finally` 中：

```js
pushProgress({ phase: "<analysis|summary>", title: "", subtitle: "" });
```

（renderer 侧 `visible = !!(title || subtitle)`，空标题即隐藏——沿用既有判定，无需新协议。）

### 4.3 完成通知复用分流（index.js + ipc.js）

**index.js 抽取共享函数**（导出 onTaskUpdate 内的分流逻辑原样搬出）：

```js
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

- 导出侧改为调用 `pushNoticeToUser(notice, { foregroundEvent: "export:finished", trayClickEvent: "export:navigate-tasks" })`——**行为与现状完全一致**（trayClickEvent 不带 payload，保持现有导航语义）。
- `pushNoticeToUser` 通过 `registerIpcHandlers` 依赖注入传入 ipc.js（与 `setBrowserViewVisible` 同模式）。

**notice 增加 `kind` 字段**：`buildFinishedNotice`（导出）返回值追加 `kind: "export"`；新增 `buildSummaryNotice`（summarize-doc.js）返回 `{ kind: "summary", ok, title, file }`：

```js
export function buildSummaryNotice({ success, videoName, file, error }) {
  return success
    ? { kind: "summary", ok: true, title: `AI 总结完成：${videoName}`, file: file || null }
    : { kind: "summary", ok: false, title: `AI 总结失败：${error || "未知错误"}`, file: null };
}
```

**library:summarize 发送时机**：成功（writeFileSync 之后）与失败（catch 分支）各发一次 `pushNoticeToUser(buildSummaryNotice(...), { foregroundEvent: "summary:finished", trayClickEvent: "summary:finished" })`——托盘点击后窗口恢复并重发同一事件，Toast 呈现，「打开」由用户决定。

### 4.4 App Toast 动作分叉（App.vue）

`finishedNotice` 渲染逻辑扩展：按钮文案与行为按 `kind`——

- `export`：「查看」→ `active.value = "tasks"`（现状）；
- `summary` 且 `file` 存在：「打开」→ `window.desktop.openWithDefaultApp(notice.file)`；
- `summary` 失败（无 file）：不显示按钮。

订阅端：`onSummaryFinished((notice) => showFinishedNotice(notice))`；导出侧已有订阅兼容无 `kind` 的历史 notice（缺省按 export 处理）。

### 4.5 LibraryView 与 OverviewView 瘦身

- LibraryView `runSummarize`：删除 `openWithDefaultApp(result.file);` 及其注释行；其余（本地状态文案、refresh）保留。
- OverviewView：移除 `progress` 导入、`onDigestProgress` 订阅块（script 底部）、三处 `progress.visible = false` 写入（watch/generate 开头/finally）与 `progress-note` 模板块——`store.progress` 从此只由 App 级订阅驱动，避免双订阅双写入。

### 4.6 preload

追加：

```js
onSummaryFinished: (callback) =>
  ipcRenderer.on("summary:finished", (_event, notice) => callback(notice)),
```

### 4.7 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/main/index.js` | 抽取 `pushNoticeToUser`；导出分流改调它；注入 ipc handlers |
| `src/main/ipc.js` | 接收 `notifyUser` 依赖；summarize 成功/失败发通知；analyze/summarize finally 清空进度 |
| `src/main/core/summarize-doc.js` | 新增 `buildSummaryNotice` 纯函数 |
| `src/preload/index.js` | `onSummaryFinished` |
| `src/renderer/src/App.vue` | 进行中状态卡（含样式与 finished-toast 位移）；onDigestProgress/onSummaryFinished 订阅；Toast 按钮按 kind 分叉 |
| `src/renderer/src/views/LibraryView.vue` | 删除自动打开 |
| `src/renderer/src/views/OverviewView.vue` | 移除 progress 本地消费与 progress-note |
| `tests/summary-focus.test.mjs` | 追加 buildSummaryNotice 单测 |

### 4.8 边界与错误处理

- 并发总结：进度文案会互相覆盖（后发者可见），完成通知逐条——不做队列化。
- 托盘点击系统通知：重发 `summary:finished`，窗口恢复后 Toast 呈现；若用户已在任务页也无副作用。
- `pushNoticeToUser` 的系统通知构造失败：console.warn 降级（沿用导出侧现状）。
- App 订阅 `digest:progress` 后，OverviewView 旧的本地清空逻辑全部移除，避免与主进程结束信号竞争。
- 历史导出 notice（无 kind）按 export 处理，向后兼容。

### 4.9 测试（node:test）

`buildSummaryNotice`（追加至 tests/summary-focus.test.mjs）：

1. 成功：`{ kind: "summary", ok: true, title: "AI 总结完成：某视频", file: "D:/x/AI总结_某视频.md" }`。
2. 失败：`ok: false`、title 含传入原因；无原因时含「未知错误」；file 为 null。
3. 成功但 file 缺省：file 为 null（不崩溃）。

分流与 UI 接线无单测，进手动验收。

### 4.10 手动验收

1. 资料库发起 AI 总结→切到设置页：右下角出现"正在生成 AI 总结"状态卡；长文档可见"分块 N/M"副标题。
2. 完成后：**文件不再自动弹出**；前台收到右下角 Toast「AI 总结完成：…」，点「打开」才打开文件。
3. 最小化到托盘后完成：系统通知弹出，点击恢复窗口并出现同款 Toast。
4. 失败（如改错 API key）：Toast 红边「AI 总结失败：…」，无「打开」按钮。
5. 摘要页「生成 AI 总结」：进行中状态卡全局可见（切页仍在），完成后消失；摘要页不再显示本地进度行。
6. 导出完成通知行为不回归（查看仍跳任务页）。

## 5. 后续迭代候选（本期不做）

- 进行中状态卡点击跳转来源页。
- 并发任务进度聚合（多个任务时状态卡列出条目）。

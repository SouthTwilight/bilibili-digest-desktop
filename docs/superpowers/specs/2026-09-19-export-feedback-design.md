# 导出执行反馈 + 全局按钮按压动效 — 设计文档

- 日期：2026-09-19
- 状态：已与用户逐节确认（范围=即时反馈+完成通知；完成层=主进程智能分流；附加=全局按钮按压动效）
- 关联代码锚点：`src/main/index.js:315`（createExportQueue 的 onTaskUpdate）、`src/main/core/export-queue.js`（notify/status 生命周期）、`src/renderer/src/App.vue`（active tab）、`src/renderer/src/views/TranscriptView.vue`（三个导出 handler 与本地 toast）、`src/preload/index.js:53`（onExportTaskUpdate 事件模式）、`src/renderer/src/styles.css`（.btn）

## 1. 背景与问题

用户点击「导出当前字幕 / 导出全部P / 导出合集」后**感知不到任何执行迹象**，只能自己去导出库翻文件。排查发现反馈链路存在三个断点，以及一个全局缺陷：

1. **点击瞬间无反馈**：handler 先 `await` 合集探测（`export:single` 内 `getCollectionInfo` 网络往返，合集确认还有逐视频 `Promise.all` 探测），这几秒按钮无 loading、无提示——点了像没点。
2. **入队提示时序错位**：本地 toast「已加入导出队列」在网络等待**之后**才弹，且 2.6s 即逝、不检查返回结果。
3. **完成无通知**：任务真正完成/失败只有「任务」页自己知道（该页本身有进度条与逐项状态，保持不动），用户在其他页面/托盘状态下收不到任何信号。
4. **全局无按压动效**：全应用按钮只有 hover 变色；styles.css 中唯一的 `:active` 是侧边栏拖拽手柄。用户要求所有按钮具备基础按压动效（点击缩小变暗→松开恢复）。

## 2. 目标与非目标

**目标**

1. 点击导出按钮**立即**有感知：按钮 loading + 即时 toast，不等网络探测。
2. 导出任务完成/失败时主动通知：窗口可见→应用内全局 toast（可跳任务页）；最小化/托盘→系统通知（点击唤回窗口并跳任务页）。
3. 所有 `.btn` 与 `.note-del` 按钮具备按压动效（缩小+变暗，80ms 双向过渡）。
4. ASR 重试完成的任务同样收到完成通知。

**非目标（YAGNI）**

- 不做侧边栏「任务」项的进行中数量角标（列入后续候选）。
- 不做多任务完成通知的合并（并发上限 4，逐条通知不构成轰炸）。
- 不改动「任务」页本身与导出队列的执行逻辑（只在既有 onTaskUpdate 钩子上加分流）。
- 行类可点击元素（导出库文件行、侧边栏 tab）不加按压动效。

## 3. 决策记录

| 决策点 | 结论 | 说明 |
|---|---|---|
| 反馈范围 | 即时反馈 + 完成通知 | 用户选定；解决"不知开没开始"与"不知完没完"两个痛点 |
| 完成通知形式 | **智能分流**：可见→应用内 toast；最小化/托盘→系统通知 | 该问题用户未作答复，按最佳判断执行：符合既定 UI 口味（主流软件行为，如浏览器下载）与 1.0.4「导出队列托盘驻留」场景；用户可随时推翻 |
| 按压动效范围 | 全局 `.btn` / `.note-del`（CSS 一处生效） | 用户明确"所有按钮都应该有基础的动效" |
| 完成钩子位置 | `src/main/index.js` 的 onTaskUpdate 回调内分流 | 队列每次状态变化都走 notify→onTaskUpdate；在此过滤 `status === "done"` 即可覆盖常规完成与 ASR 重试完成，零侵入队列内部 |

## 4. 设计

### 4.1 点击层（TranscriptView 三个导出入口）

- 新增 `exporting` ref；三个入口（`exportSingleNow` / `exportAllPagesNow` / 合集弹窗「开始导出」）统一改为：
  1. 入口即 `exporting = true`（对应按钮 `:disabled="exporting"`）并**先弹 toast**「已加入导出队列…」（保持现有文案），不再被网络往返卡住；
  2. `await` IPC 后检查返回：`success === false` → toast 替换为 `⚠️ 错误文案`；异常 catch → 同样替换；
  3. `finally` 恢复 `exporting = false`。
- 本地 toast 机制沿用（2600ms），仅调整触发时序与失败分支。

### 4.2 完成层（主进程分流）

**纯函数 `buildFinishedNotice(task)`**（放 `export-queue.js` 导出，输入为 serializeTask 后的任务对象）：

- `task.status !== "done"` → 返回 `null`（取消的任务不发通知）。
- 否则返回 `{ ok, title, file }`：
  - 全部成功：`ok: true`；单视频任务 `title: "字幕导出完成"`，合集任务 `title: "合集导出完成（N 个视频）"`；
  - 部分失败：`ok: false`；`title: "导出完成：成功 X，失败 Y"`；
  - `file`：首个成功条目的文件路径（无则 null，供后续「打开位置」扩展，本期仅展示标题）。

**分流逻辑**（`src/main/index.js` 的 onTaskUpdate 回调追加）：

```js
const notice = buildFinishedNotice(task);
if (notice) {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && win.isVisible() && !win.isMinimized()) {
    win.webContents.send("export:finished", notice);
  } else {
    const n = new Notification({ title: "Bilibili Digest", body: notice.title });
    n.on("click", () => {
      win?.show(); win?.focus();
      win?.webContents.send("export:navigate-tasks");
    });
    n.show();
  }
}
```

- 既有 `export:task-update` 推送（任务页订阅）保持不变，分流逻辑是**追加**而非替换。
- 系统通知仅托盘/最小化时出现；点击 = 唤回窗口 + 直达任务页。

### 4.3 全局 Toast（App.vue）

- App.vue 新增完成通知状态与模板（fixed 右下角卡片）：
  - 订阅 `onExportFinished`：置入 notice，**6 秒**自动消失（比入队 toast 长，完成是终态信息）；
  - 订阅 `onNavigateTasks`：`active.value = "tasks"`（系统通知点击的落地动作）；
  - 卡片按 `notice.ok` 分色（成功/失败），含「查看」按钮（跳任务页并清除卡片）与关闭 ×。
- preload 按既有 `onExportTaskUpdate` 模式新增 `onExportFinished` / `onNavigateTasks`（`ipcRenderer.on` + 返回退订函数）。

### 4.4 全局按压动效（styles.css）

```css
.btn {
  /* 既有样式不动，新增过渡 */
  transition: transform 0.08s ease, filter 0.08s ease, background 0.12s ease;
}
.btn:active {
  transform: scale(0.93);
  filter: brightness(0.88);
}
.note-del:active {
  transform: scale(0.85);
  filter: brightness(0.88);
}
```

- 覆盖所有 `.btn` 变体（实心/ghost/small——导出、刷新、AI总结、设置页等全部按钮）与 `.note-del` 小图标按钮（任务取消/重试、笔记删除等）。
- disabled 按钮不触发；行类元素不加。

### 4.5 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/main/core/export-queue.js` | 新增导出纯函数 `buildFinishedNotice(task)` |
| `src/main/index.js` | onTaskUpdate 回调追加完成分流（app 事件 / 系统通知） |
| `src/preload/index.js` | 新增 `onExportFinished` / `onNavigateTasks` |
| `src/renderer/src/App.vue` | 全局 Toast 卡片 + 两个事件订阅 + 跳任务页 |
| `src/renderer/src/views/TranscriptView.vue` | 三个导出入口 loading + 即时 toast + 失败分支 |
| `src/renderer/src/styles.css` | 按压动效 |
| `tests/export-notice.test.mjs`（新建） | buildFinishedNotice 单测 |

### 4.6 边界与错误处理

- 取消的任务（`canceled`）不发完成通知——用户自己按的取消。
- `retryAsr` 完成：队列把任务重新置 running→done，onTaskUpdate 自然再次触发分流，无需特殊处理。
- 窗口在收集完成瞬间不可见但用户随后恢复窗口：系统通知已发过，不补发应用内 toast（Windows 通知中心留有记录）。
- `Notification` 在极旧 Windows 环境不可用时静默降级（try/catch 包裹，仅记录 console.warn）。
- 三个导出入口的 `exporting` 互斥（同一时间只允许一个入队动作进行），防连点产生重复任务。

### 4.7 测试（node:test）

`buildFinishedNotice` 单测（输入按 serializeTask 形状构造）：

1. `status: "canceled"` → null；`status: "running"` → null。
2. 单视频全成功 → `{ ok: true, title: "字幕导出完成", file: <首个成功文件> }`。
3. 合集部分失败（3 成功 2 失败）→ `ok: false`、title 含「成功 3，失败 2」。
4. 全部失败 → `ok: false`、file 为 null。

分流与 UI 层无单测，进手动验收。

### 4.8 手动验收

1. 点「导出当前字幕」：按下瞬间按钮形变 + 立即出现入队 toast（不再有数秒静默）；按钮短暂 disabled。
2. 导出期间切到别的页面：完成时右下角弹出全局 toast（成功样式），点「查看」跳任务页。
3. 最小化到托盘后导出完成：弹出系统通知，点击后窗口恢复并落在任务页。
4. 断网或无字幕导出失败：toast 显示 ⚠️ 错误文案。
5. 任务页点「改下 ASR」重试完成后同样收到完成通知。
6. 全应用任意按钮按压有缩小变暗→回弹；任务取消/笔记删除小按钮同样有。

## 5. 后续迭代候选（本期不做）

- 侧边栏「任务」项进行中数量角标。
- 多任务短窗口接连完成的通知合并。
- 全局 toast 的「打开文件位置」快捷动作（notice.file 已备好字段）。

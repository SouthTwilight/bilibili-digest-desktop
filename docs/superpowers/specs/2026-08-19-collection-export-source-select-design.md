# 合集导出：快速列表 + 显式来源选择 + 失败后 ASR 重试

## 背景

当前「导出整个合集」会预检查每个视频是否有 B 站字幕，速度慢。用户希望去掉预检查，改为在弹窗中直接为每个视频选择 B 站字幕或 ASR；任务执行后若 B 站字幕获取失败，可在任务记录中改用 ASR 重试。

## 需求

- 打开合集导出弹窗只获取合集视频列表，不逐个检查字幕状态。
- 每个视频可单独选择来源：B站字幕（默认）或 ASR。
- 支持全选/全不选，以及“批量设为 B站字幕 / 批量设为 ASR”（只作用于已勾选视频）。
- 任务执行时按用户选择的来源执行；选择 B站字幕但获取失败则该项失败，不自动回退 ASR。
- 任务记录中：
  - 失败项可单独“改下 ASR”重试。
  - 可整批“全部改用 ASR 重试”。
  - 重试在原任务内进行，不新建任务；任务状态重新变为进行中，结束后再变为已完成。

## 设计

### IPC

- `export:collection-preview`：只返回 `{ collectionTitle, videos }`，不再调用 `bilibiliVideoHasSubtitle`。
- 新增 `export:retry-asr`：入参 `{ taskId, itemIndexes? }`，由导出队列在原任务内重试失败项。

### 导出队列

- 每个导出项带 `sourceMode: "subtitle" | "asr"`，`useAsr` 由 `sourceMode === "asr"` 推导。
- 执行时优先命中对应来源的本地缓存，没有缓存再按来源获取。
- 新增 `retryAsr(taskId, itemIndexes?)`：
  - 将失败项重置为 pending，清空 error/file。
  - 将来源改为 ASR。
  - 任务状态设为 running，重新进入 ASR 串行队列。
- `serializeTask` 的结果中增加 `bvid` 和 `page`，供前端定位失败项。

### 前端

- 合集导出弹窗：
  - 每行：勾选 + 标题 + 来源选择（B站字幕/ASR）。
  - 默认全选、来源 B站字幕。
  - 顶部：全选/全不选、批量设 B站字幕、批量设 ASR。
- 任务页：
  - 失败项显示“改下 ASR”按钮。
  - 任务卡片存在失败项时显示“全部改用 ASR 重试”按钮。

## 测试

- 导出队列重试：失败后调用 `retryAsr`，验证任务回到 running、失败项变为 pending 且来源为 asr。
- 现有导出队列测试保持通过。
- `npm run build` 通过。

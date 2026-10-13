# 合集增量更新 设计文档

日期：2026-10-13
状态：待用户审查

## 背景与目标

「GitHub一周热点汇总」等合集在 B 站持续更新，但应用只能全量导出合集：再次导出时预览弹窗列出全部视频且默认全选，用户需自行回忆并手动取消勾选已导出的视频，无法便捷地"把新视频补进来"。

目标：为合集导出提供增量更新能力——自动识别"哪些已导出、哪些是新视频"，新视频默认勾选，一键完成补齐。

用户已确认的决策：

- 两个入口都做：现有合集导出弹窗增强 + 库视图合集行「检查更新」按钮
- 自动提醒做**启动时检测**（一次性，不定时轮询）
- 纯"UP主分组"目录不做检测（那是"关注更新"，另一个话题）

## 现状要点（代码事实）

- `export:collection-confirm`（`src/main/ipc.js:380`）本就接受任意 items 子集入队——增量导出的执行侧已具备
- 合集预览 `export:collection-preview` 从 B 站 API 实时拉最新完整列表（`collectionVideosFromView`），逐视频勾选/全选能力在前端弹窗已存在（`TranscriptView.vue:71` 起）
- 库目录名规范为 `视频名_BV号`（`videoFolderName`），BV 号为纯字母数字、不受 sanitize 影响，可作为可靠的"已导出"判定依据
- 库目录存在两种形态（远端 401fb8f 引入的三级结构）：合集/视频、UP主/视频

## 组件设计

### 1. 已导出判定原语（`src/main/core/library.js` 新增）

`exportedBvids(saveDir, collectionTitle) -> Set<string>`：

- 扫描 `{saveDir}/{collectionTitle}/` 下的一级子目录名，提取 `_BV...` 后缀（正则 `/(BV[A-Za-z0-9]+)$/`）
- 未在本合集目录命中的场景由调用方决定是否全库兜底（见 §2）
- 纯函数、无网络调用，可单测

### 2. 比对原语与预览接口增强（`export:collection-preview`）

- 新增 `markExported(saveDir, collectionTitle, videos) -> videos`（library.js）：先按本合集目录的 `exportedBvids` 比对；合集目录未命中的 BV 再对 saveDir 全库一级/二级目录兜底扫一遍（应对合集在 B 站改名的边缘情况，成本是一次目录遍历），为每个 video 标注 `exported: boolean`
- `export:collection-preview` handler 在返回前调用它——预览与启动检测（§5）共用同一判定，避免两处逻辑漂移

### 3. 入口一：现有导出弹窗增强（`TranscriptView.vue`）

- 已导出视频：灰色「已导出」徽标 + 默认 `selected: false`
- 新视频：默认勾选
- 顶部统计条：「合集共 N 个视频，M 个未导出」；M 为 0 时提示"已是最新"
- 全选/反选/批量设置字幕来源能力保留——手动勾选已导出视频即重导，覆盖"内部新增分P想更新"的场景

### 4. 入口二：库视图合集行「检查更新」

- 把合集导出弹窗抽为独立组件 `CollectionExportDialog.vue`，TranscriptView 与 LibraryView 共用
- LibraryView 合集行加「检查更新」按钮：取该合集下任一视频目录名的 BV → 调 `export:collection-preview` → 打开共用弹窗（新视频默认勾选）→ 确认走现有 `collection-confirm` 入队
- 无新视频时弹窗顶部明示"已是最新"，确认按钮仍可用（全选重导的能力保留）

### 5. 启动时检测角标

- 主进程 `app.ready` 后异步执行（不阻塞启动、失败静默）：
  - 对库内每个一级目录：取任一子视频目录 BV → `fetchBilibiliView` → 有 `ugc_season` 的才是真合集（UP主分组跳过）
  - `collectionVideosFromView` 最新列表 经 `markExported`（§2 同一原语）标注 → 差集即新视频数
  - 结果经 `webContents.send("collection:update-available", { collectionDir, count })` 推给渲染端
- LibraryView 收到事件在对应合集行显示「N 个新视频」角标；点击即触发入口二的检查更新流程
- 单合集 API 失败跳过不重试；检测在每次启动时执行一次

## 边界与已知限制（本期接受）

| 情况 | 处理 |
|---|---|
| 已导出视频内部新增分P | 仍标"已导出"；用户手动勾选重导 |
| 合集在 B 站改标题 | BV 兜底比对使检测仍准确；但重导的文件按新标题落**新目录**，旧目录保留（targetFile 纯函数，本期不改） |
| UP主分组目录 | 不检测、不显示角标（非合集） |
| 库目录为空/无合集 | 启动检测直接空跑，无副作用 |
| 同一次启动内合集再次更新 | 角标不自动刷新，等下次启动或手动「检查更新」 |

## 测试（`node --test tests/*.test.mjs`）

- `exportedBvids`：正常提取、无 BV 目录忽略、空目录返回空集
- preview 增强：mock 集合判定（或抽纯函数 `markExported(videos, exportedSet)`）验证标记逻辑，含全库兜底分支
- 现有 `export.test.mjs`/`library` 相关用例回归不破
- 弹窗与角标为 UI 改动，按项目惯例手动冒烟（`npm run dev` 走两个入口各一次）

## 实施顺序

1. `exportedBvids` + 单测
2. `export:collection-preview` 标记逻辑（含全库兜底）+ 单测
3. TranscriptView 弹窗增强（徽标/默认勾选/统计条）
4. 弹窗抽组件 + LibraryView「检查更新」入口
5. 启动检测 + 角标 + 点击进更新
6. 全量回归 + 手动冒烟

## 非目标

- 不做定时轮询检测
- 不做"关注/UP主更新"检测
- 不做分P级 diff 与重导自动化
- 不改动 targetFile 目录复用逻辑（合集改名场景的重导落新目录，接受）

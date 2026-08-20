# 设计：全屏播放时隐藏侧边栏与顶栏

日期：2026-08-20
状态：已获用户批准（方案 A）

## 背景与目标

应用布局为：主窗口自身页面渲染左侧 Vue 侧边栏 + 44px 顶部导航栏，B 站页面渲染在独立的 `WebContentsView`（原生层，位于窗口页面之上），边界由主进程 `layoutBrowserView()` 按侧边栏宽度计算。

当前代码没有任何全屏处理。用户点击 B 站播放器的「全屏」按钮时，视频只在右侧区域内全屏，侧边栏仍占据左侧约 400–820px，破坏沉浸感。

**目标**：用户进入 HTML5 全屏播放时，隐藏侧边栏与顶栏，B 站页面铺满整个窗口；退出全屏后无损恢复原布局（含用户拖动设置的侧边栏宽度）。

**非目标（明确不做）**：
- 「网页全屏」模式不处理——该模式下侧边栏保持可见（用户确认为期望行为：网页全屏是「放大视频但保留工具」的中间态）
- 不把窗口设为系统级原生全屏（不改变任务栏、多显示器行为）
- 不向 B 站页面注入任何脚本或样式

## 关键技术事实

- Electron（本项目用 37.x）的子 `WebContentsView` 触发 HTML5 全屏时**不会自动铺满窗口**，必须在主进程监听该 webContents 的 `enter-html-full-screen` / `leave-html-full-screen` 事件并手动调整边界。这是 Electron 官方推荐模式。
- 两个事件由 Chromium 在所有进出全屏的路径上触发（点击按钮、Esc 键等），无需自行监听按键。
- `WebContentsView` 是原生层，铺满窗口后天然遮住窗口页面渲染的一切内容；渲染进程侧的 CSS 隐藏是防闪烁/防穿透的双保险。

## 方案（已批准：方案 A——主进程事件驱动的布局接管）

进入全屏时主进程把视图边界改为铺满窗口，并通知渲染进程隐藏自身 chrome；退出时按内存中的 `sidebarWidth` 原样恢复。不改变窗口原生状态。

**否决的备选**：
- 方案 B（渲染进程 CSS 为主，宽度置 0）：全屏事件只发生在 B 站视图的 webContents 上，窗口页面拿不到，仍需主进程转发；且与拖动调宽的 clamp（≥400px）逻辑纠缠。
- 方案 C（同时 `setFullScreen(true)` 原生窗口全屏）：改变用户未要求的窗口状态，多显示器下还原有坑，两套全屏状态机同步的边缘情况多。

## 改动清单

### 1. `src/main/index.js`（核心）

- 新增模块级状态 `htmlFullscreen`（boolean，初始 false）。
- `layoutBrowserView()` 增加分支：`htmlFullscreen` 为 true 时边界直接取 `{x: 0, y: 0, width: 全宽, height: 全高}`。由此，全屏期间的窗口 resize、侧边栏拖动 IPC 都不会破坏铺满状态。
- 监听 B 站 webContents（`contents`）的 `enter-html-full-screen` / `leave-html-full-screen`：
  - 置位/复位 `htmlFullscreen` → 调用 `layoutBrowserView()` → 调用 `pushLayout()`。
  - 退出全屏时额外调用 `applyBrowserZoom()`（全屏期间窗口可能被 resize，退出后需按正常视图宽度重算缩放）。
- `pushLayout` 载荷由 `{ sidebarWidth }` 扩展为 `{ sidebarWidth, fullscreen: htmlFullscreen }`。
- `applyBrowserZoom()` 开头增加守卫：`htmlFullscreen` 为 true 时直接返回——全屏宽度不等于平时视图宽度，重算会导致画面缩放跳变；进入全屏时保持进入前的缩放不变。

### 2. `src/preload/index.js`

零改动。`onLayout` 已透传整个 `layout` 载荷对象。

### 3. `src/renderer/src/App.vue`

- 新增 `const htmlFullscreen = ref(false)`。
- `onLayout` 回调中同步：`htmlFullscreen.value = !!layout.fullscreen`。
- 根元素 `.app-shell` 绑定 `:class="{ 'html-fullscreen': htmlFullscreen }"`。

### 4. `src/renderer/src/styles.css`

新增规则：`.app-shell.html-fullscreen .sidebar, .app-shell.html-fullscreen .topbar, .app-shell.html-fullscreen .sidebar-resizer { display: none; }`。

## 数据流

```
用户点击 B 站播放器「全屏」
  → B 站页面请求 HTML5 全屏
  → 主进程 enter-html-full-screen 事件
  → htmlFullscreen = true → 视图边界铺满窗口（原生层盖住一切）
  → pushLayout({ sidebarWidth, fullscreen: true })
  → 渲染进程加 .html-fullscreen class，隐藏侧边栏/顶栏/分隔条

Esc 或再次点击全屏按钮退出
  → leave-html-full-screen 事件
  → htmlFullscreen = false → layoutBrowserView() 恢复（sidebarWidth 全程保留在内存，无损）
  → applyBrowserZoom() 按正常视图宽度重算
  → pushLayout({ sidebarWidth, fullscreen: false }) → 渲染进程移除 class
```

## 边缘情况

| 场景 | 行为 |
|---|---|
| 全屏中拖动窗口大小 | `resize` → `layoutBrowserView()` 走全屏分支，保持铺满；zoom 被守卫跳过 |
| 全屏中拖动侧边栏分隔条 | 分隔条已隐藏，实际不可触发；即使 IPC 到达也只是改 `sidebarWidth`，退出后生效 |
| 事件重复触发 | 幂等：标志赋值 + 重设边界，无副作用 |
| 退出全屏后缩放 | 退出时显式 `applyBrowserZoom()`（`afterNavigation` 不一定触发） |
| 导出任务运行中进入全屏 | 无交互：导出在主进程队列运行，任务状态等退出全屏后查看 |

## 测试与验证

- 自动化：`npm test`（现有 node --test 回归，本改动不触碰被测逻辑）；`npm run build` 验证构建。
- 布局逻辑（Electron API 闭包）不在现有单测覆盖范围，本次不新增自动化测试（与代码库现状一致）。
- 手动验证清单：
  1. 视频页点「全屏」→ 侧边栏/顶栏消失，视频铺满窗口
  2. Esc 退出 → 侧边栏/顶栏恢复，宽度与进入前一致
  3. 全屏中拖动窗口大小 → 始终铺满
  4. 全屏中退出 → 缩放正常（页面不横向滚动、不异常放大）
  5. 「网页全屏」→ 侧边栏保持可见（回归确认）
  6. 全屏进入/退出反复多次 → 无残留状态

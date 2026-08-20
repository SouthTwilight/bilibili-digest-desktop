# 全屏播放隐藏侧边栏与顶栏 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用户点击 B 站播放器「全屏」时隐藏侧边栏与顶栏，B 站视图铺满整个窗口；退出全屏后无损恢复原布局。

**架构：** 主进程监听 B 站 `WebContentsView` 的 `enter-html-full-screen` / `leave-html-full-screen` 事件，切换 `htmlFullscreen` 标志；布局计算抽为纯函数 `computeViewBounds`（全屏返回整窗边界，正常返回侧边栏右侧边界）。渲染进程通过现有 `layout:update` 通道的 `fullscreen` 字段同步隐藏/显示自身 chrome。设计文档：`docs/superpowers/specs/2026-08-20-fullscreen-hide-sidebar-design.md`。

**技术栈：** Electron 37（主进程 + preload + Vue 3 渲染进程）、node --test。

**明确不做：** 「网页全屏」不处理（侧边栏保持可见）；不做原生窗口 `setFullScreen`；不注入 B 站页面。

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/main/core/layout.js` | 创建 | 布局纯函数：常量、`clampSidebarWidth`、`computeViewBounds` |
| `tests/layout.test.mjs` | 创建 | 上述纯函数的单测 |
| `src/main/index.js` | 修改 | 接线：`htmlFullscreen` 状态、全屏事件监听、zoom 守卫、`pushLayout` 载荷扩展，改用 layout.js |
| `src/renderer/src/App.vue` | 修改 | `htmlFullscreen` ref + `.html-fullscreen` class 绑定 |
| `src/renderer/src/styles.css` | 修改 | `.html-fullscreen` 状态下隐藏侧边栏/顶栏/分隔条 |
| `README.md` | 修改 | 功能一览加一行全屏沉浸说明 |

工作目录：`G:\project\bilibili_digest_desktop`（Windows，Git Bash）。所有命令在此目录执行。

---

### 任务 1：布局纯函数模块（TDD）

**文件：**
- 测试：`tests/layout.test.mjs`
- 创建：`src/main/core/layout.js`

- [ ] **步骤 1：编写失败的测试**

创建 `tests/layout.test.mjs`（遵循 `tests/settings.test.mjs` 的 `node:test` + `assert/strict` 风格）：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  clampSidebarWidth,
  computeViewBounds,
} from "../src/main/core/layout.js";

test("layout constants match the documented sidebar range", () => {
  assert.equal(SIDEBAR_MIN_WIDTH, 400);
  assert.equal(SIDEBAR_MAX_WIDTH, 820);
});

test("clampSidebarWidth clamps to min/max and rounds", () => {
  assert.equal(clampSidebarWidth(100), 400);
  assert.equal(clampSidebarWidth(9999), 820);
  assert.equal(clampSidebarWidth(512.6), 513);
  assert.equal(clampSidebarWidth(480), 480);
});

test("normal layout: view sits right of the sidebar, below the toolbar", () => {
  assert.deepEqual(
    computeViewBounds({ fullscreen: false, windowWidth: 1440, windowHeight: 900, sidebarWidth: 480 }),
    { x: 488, y: 44, width: 952, height: 856 },
  );
});

test("html fullscreen: view covers the whole window regardless of sidebar", () => {
  assert.deepEqual(
    computeViewBounds({ fullscreen: true, windowWidth: 1440, windowHeight: 900, sidebarWidth: 820 }),
    { x: 0, y: 0, width: 1440, height: 900 },
  );
});

test("degenerate window sizes never produce negative bounds", () => {
  const bounds = computeViewBounds({ fullscreen: false, windowWidth: 100, windowHeight: 20, sidebarWidth: 480 });
  assert.equal(bounds.x, 488);
  assert.equal(bounds.width, 0);
  assert.equal(bounds.height, 0);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test`
预期：FAIL——`Cannot find module '...src/main/core/layout.js'`（其余既有测试仍通过）。

- [ ] **步骤 3：编写最少实现代码**

创建 `src/main/core/layout.js`（常量与钳制语义从 `src/main/index.js:18-21`、`src/main/index.js:61` 原样迁移）：

```js
// Layout math for the main window, extracted from index.js so the fullscreen
// takeover and sidebar clamping can be unit-tested without Electron. The
// Bilibili WebContentsView is positioned by computeViewBounds(); the window's
// own page (sidebar + toolbar) renders in the remaining space.
export const SIDEBAR_DEFAULT_WIDTH = 480;
export const SIDEBAR_MIN_WIDTH = 400;
export const SIDEBAR_MAX_WIDTH = 820;
export const SIDEBAR_RESIZER_WIDTH = 8;
export const TOOLBAR_HEIGHT = 44;

export function clampSidebarWidth(width) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

// Browser-view bounds inside the window. In HTML fullscreen the view takes
// over the whole window (sidebar + toolbar hide); otherwise it fills the space
// right of the sidebar and below the toolbar, leaving the 8px resizer strip
// uncovered — the view's native layer would otherwise swallow its mouse
// events.
export function computeViewBounds({ fullscreen, windowWidth, windowHeight, sidebarWidth }) {
  if (fullscreen) {
    return { x: 0, y: 0, width: Math.max(0, windowWidth), height: Math.max(0, windowHeight) };
  }
  return {
    x: sidebarWidth + SIDEBAR_RESIZER_WIDTH,
    y: TOOLBAR_HEIGHT,
    width: Math.max(0, windowWidth - sidebarWidth - SIDEBAR_RESIZER_WIDTH),
    height: Math.max(0, windowHeight - TOOLBAR_HEIGHT),
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test`
预期：PASS——`tests/layout.test.mjs` 5 个用例全过，既有测试无回归。

- [ ] **步骤 5：Commit**

```bash
git add src/main/core/layout.js tests/layout.test.mjs
git commit -m "feat: 抽取布局纯函数 computeViewBounds/clampSidebarWidth 并纳入单测"
```

---

### 任务 2：主进程全屏接线

**文件：**
- 修改：`src/main/index.js`（常量块 18-21 行、`layoutBrowserView` 29-39 行、`applyBrowserZoom` 46-58 行、`resizeSidebar` 60-64 行、`pushLayoutLocal` 95-98 行、`contents` 事件区约 152-166 行）

- [ ] **步骤 1：改用 layout.js 并接入全屏分支**

对 `src/main/index.js` 做以下修改（其余内容不动）：

1. 顶部 import 区（`isAllowedUrl` 之后）加入：

```js
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_RESIZER_WIDTH,
  clampSidebarWidth,
  computeViewBounds,
} from "./core/layout.js";
```

2. 删除原 13-21 行的布局常量定义（`SIDEBAR_DEFAULT_WIDTH`/`SIDEBAR_MIN_WIDTH`/`SIDEBAR_MAX_WIDTH`/`SIDEBAR_RESIZER_WIDTH`/`TOOLBAR_HEIGHT`），保留其上方的注释块并改写为指向 layout.js：

```js
// Sidebar hosts the Vue app (the window's own page); the browser view fills
// the remaining space and is the ONLY place Bilibili pages render. Layout
// constants and bounds math live in core/layout.js.
```

3. 模块级状态区（`let sidebarWidth = ...` 一行）改为：

```js
let mainWindow = null;
let browserView = null;
let sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
let htmlFullscreen = false;
let pushLayout = () => {};
```

4. `layoutBrowserView()` 整体替换为：

```js
function layoutBrowserView() {
  if (!mainWindow || !browserView) return;
  const { width, height } = mainWindow.getContentBounds();
  browserView.setBounds(
    computeViewBounds({
      fullscreen: htmlFullscreen,
      windowWidth: width,
      windowHeight: height,
      sidebarWidth,
    }),
  );
}
```

5. `applyBrowserZoom()` 在 `if (!mainWindow || !browserView) return;` 之后加守卫：

```js
  // Fullscreen width ≠ normal view width; re-computing mid-fullscreen would
  // visibly shift the zoom. leave-html-full-screen re-applies it on restore.
  if (htmlFullscreen) return;
```

6. `resizeSidebar()` 整体替换为：

```js
function resizeSidebar(width) {
  sidebarWidth = clampSidebarWidth(width);
  layoutBrowserView();
  pushLayout();
}
```

7. `pushLayoutLocal` 扩展载荷：

```js
  const pushLayoutLocal = () =>
    mainWindow?.webContents.send("layout:update", { sidebarWidth, fullscreen: htmlFullscreen });
```

8. 在 `contents.on("did-navigate", notifyVideoChange)` 与 `contents.on("did-navigate-in-page", notifyVideoChange)` 两行之后加入：

```js
  // Player 全屏 (HTML fullscreen) takes over the whole window: the view goes
  // edge-to-edge and the sidebar/toolbar hide for immersive watching. Exiting
  // restores the previous layout losslessly — sidebarWidth is never touched.
  contents.on("enter-html-full-screen", () => {
    htmlFullscreen = true;
    layoutBrowserView();
    pushLayout();
  });
  contents.on("leave-html-full-screen", () => {
    htmlFullscreen = false;
    layoutBrowserView();
    applyBrowserZoom();
    pushLayout();
  });
```

- [ ] **步骤 2：构建验证**

运行：`npm run build`
预期：成功，无报错（electron-vite build + copy-assets）。

- [ ] **步骤 3：回归测试**

运行：`npm test`
预期：全部 PASS。

- [ ] **步骤 4：Commit**

```bash
git add src/main/index.js
git commit -m "feat: HTML全屏时B站视图铺满窗口——监听enter/leave-html-full-screen接管布局，zoom防跳变"
```

---

### 任务 3：渲染进程隐藏侧边栏与顶栏

**文件：**
- 修改：`src/renderer/src/App.vue`（script 区 `active` 定义后、`onLayout` 回调；template 根元素 105 行）
- 修改：`src/renderer/src/styles.css`（「sidebar drag resizer」注释块之前追加规则）

- [ ] **步骤 1：App.vue 增加 htmlFullscreen 状态与 class 绑定**

script 区：`const active = ref("settings");` 之后加：

```js
const htmlFullscreen = ref(false);
```

`onLayout` 回调改为：

```js
  off.push(window.desktop.onLayout(({ sidebarWidth, fullscreen }) => {
    document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
    htmlFullscreen.value = !!fullscreen;
  }));
```

template 根元素改为：

```html
  <div class="app-shell" :class="{ 'html-fullscreen': htmlFullscreen }">
```

- [ ] **步骤 2：styles.css 增加隐藏规则**

在 `/* ---- sidebar drag resizer ---- */` 注释之前追加：

```css
/* HTML fullscreen: the browser view (native layer) already covers the window;
   hiding our own chrome prevents any flash-through while entering/exiting. */
.app-shell.html-fullscreen .topbar,
.app-shell.html-fullscreen .sidebar,
.app-shell.html-fullscreen .sidebar-resizer { display: none; }

```

- [ ] **步骤 3：构建验证**

运行：`npm run build`
预期：成功。

- [ ] **步骤 4：Commit**

```bash
git add src/renderer/src/App.vue src/renderer/src/styles.css
git commit -m "feat: 全屏时隐藏侧边栏与顶栏（layout:update 载荷新增 fullscreen 字段）"
```

---

### 任务 4：文档与整体验证

**文件：**
- 修改：`README.md`（「浏览与字幕」功能列表）

- [ ] **步骤 1：README 功能一览加一行**

在「### 浏览与字幕」列表「内嵌 B 站浏览」条目之后加：

```markdown
- **全屏沉浸**：点 B 站播放器「全屏」，侧边栏与顶栏自动隐藏、画面铺满窗口；Esc 退出后原布局无损恢复（「网页全屏」不影响侧边栏）
```

- [ ] **步骤 2：整体回归**

运行：`npm test && npm run build`
预期：测试全过、构建成功。

- [ ] **步骤 3：Commit**

```bash
git add README.md
git commit -m "docs: README 功能一览补充全屏沉浸说明"
```

- [ ] **步骤 4：手动验证清单（交由用户在 GUI 中确认）**

1. 视频页点「全屏」→ 侧边栏/顶栏消失，视频铺满窗口
2. Esc 退出 → 侧边栏/顶栏恢复，宽度与进入前一致
3. 全屏中拖动窗口大小 → 始终铺满、无缩放跳变
4. 退出全屏后页面缩放正常（不横向滚动、不异常放大）
5. 「网页全屏」→ 侧边栏保持可见（回归确认）
6. 反复进出全屏多次 → 无残留状态

---

## 自检记录

- 规格覆盖度：spec 的 4 个文件改动（main/preload/App.vue/styles.css）分别由任务 2/3 覆盖（preload 零改动，无需任务）；边缘情况表中的 resize/拖动/幂等/zoom 重算均落在任务 2 的代码里；测试章节由任务 1 覆盖。
- 占位符扫描：所有代码步骤含完整代码，无「待定/TODO/类似任务N」。
- 类型一致性：`computeViewBounds` 参数名 `{ fullscreen, windowWidth, windowHeight, sidebarWidth }` 在任务 1 定义、任务 2 消费一致；`clampSidebarWidth` 与原 `resizeSidebar` 钳制语义逐字一致；`layout:update` 载荷 `{ sidebarWidth, fullscreen }` 与任务 3 App.vue 解构一致。

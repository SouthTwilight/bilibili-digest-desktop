# Bilibili Digest 桌面版重构设计规格

日期：2026-08-18
状态：待用户审阅
源项目：`G:\project\bilibili-digest`（Chrome 扩展 v1.2.2+）

## 1. 背景与目标

Chrome 扩展版存在四个核心痛点，桌面版逐一解决：

| # | 扩展版痛点 | 桌面版方案 |
|---|---|---|
| 1 | 需懂开发者模式加载插件 | NSIS 安装包，装完即用 |
| 2 | 导出逻辑绑定侧边栏页面，切页打断合集导出 | 导出任务队列在主进程，与浏览视图解耦，多任务并行 |
| 3 | 每次导出弹保存对话框 | 设置默认保存目录，直接落盘零弹窗 |
| 4 | 导出文件无法直接浏览 | 侧边栏导出库：合集=文件夹展开，点击文件即预览 |

## 2. 技术栈

- **Electron（主进程 Node.js）**：窗口管理、内嵌浏览器视图、后台服务、文件系统。
- **Vue 3 + Vite**：侧边栏与设置页 UI（renderer）。
- **electron-builder**：Windows NSIS 安装包。
- 不引入 Python。ASR/AI 均为 HTTP 调用，Node 直接胜任；现有扩展 JS 逻辑近乎原样移植。

## 3. 架构

```
主窗口（BrowserWindow）
├─ 侧边栏 renderer（Vue 3，固定宽度可拖拽调整）
│   摘要/章节 │ 字幕（原文/中文/双语）│ 笔记 │ 导出库文件树 │ 任务队列面板 │ 设置
└─ 浏览区 WebContentsView（占余下宽度）
    只放行 *.bilibili.com；session 持久化 partition "persist:bilibili"
    UA 设为常规 Chrome；页面注入脚本提供"AI 总结"按钮与笔记快捷键
```

主进程模块（`src/main/`）：

| 模块 | 职责 | 移植来源 |
|---|---|---|
| `bilibili.js` | view/playurl/字幕/合集 API、音轨下载、CID 解析 | background.js 相关函数 |
| `asr-bailian.js` | 百炼 OSS 上传+异步轮询转写 | `transcribeWithBailian` 原样 |
| `asr-doubao.js` | 豆包极速版 base64 直传 | `transcribeWithDoubao` 原样 |
| `ai.js` | GLM/DeepSeek chat/completions、超时/重试 | `requestAiCompletion` 原样 |
| `settings.js` | Provider 注册表、Key 管理、迁移 | 扩展 settings.js 原样复用 |
| `prompts/` | 提示词 md 文件 | 扩展 prompts/ 原样复用 |
| `export-queue.js` | 导出任务队列（见 §5） | 新写 |
| `export-render.js` | md/html 导出模板 | sidepanel.js build*Export 参数化版 |
| `notes.js` | 笔记存储 | chrome.storage → 本地 JSON |
| `digest-cache.js` | 摘要缓存（30 天过期） | chrome.storage → userData JSON |
| `ipc.js` | renderer/preload/页面脚本 ⇄ 主进程契约 | 新写 |

## 4. IPC 契约（主要通道）

- `settings:get/set`：读写设置（providers、asrProvider、keys、saveDir）。
- `video:current`：页面脚本上报当前视频 BV/P/标题。
- `digest:start/cancel`、`digest:progress`、`digest:result`：摘要生成流。
- `transcript:get`、`transcript:translate`：字幕与翻译。
- `notes:list/save/delete/play`。
- `export:single {videoId, format}`、`export:collection {videoId, selection}`、`export:tasks`（任务列表查询）、`export:task-progress`（推送）。
- `library:list`（扫描保存目录构建文件树）、`library:read {path}`（预览内容）、`library:reveal {path}`（系统资源管理器定位）。

## 5. 导出任务队列（核心新能力）

- 任务模型：`{ id, type: single|collection, collectionTitle?, items: [{bvid,title,hasSubtitle,useAsr}], status: queued|running|done|failed, progress: {done,total}, createdAt }`。
- **与浏览视图完全解耦**：切换视频/合集/页面不影响运行中任务；关窗最小化到托盘继续。
- 并发策略：每 ASR 提供商默认串行（豆包有并发配额，`quota exceeded concurrency` 教训）；B站字幕类任务并发 3；总并发上限可配置，默认 4。
- 落盘：直接写 `settings.saveDir`；文件名 `视频名_YYYY-MM-DD_HH-mm.{md,html}` / `合集名_视频名_YYYY-MM-DD_HH-mm.{md,html}`（沿用已验证的中文安全清理规则）。
- 失败隔离：单个视频失败不中止整个合集任务，任务结束汇总成功/失败清单。
- 合集导出沿用预览勾选交互：先查字幕状态 → 用户勾选（无字幕项可选 ASR 补充）→ 入队。

## 6. 数据存储（`app.getPath("userData")`）

- `settings.json`：所有设置与 Key（本机明文，与扩展 chrome.storage.local 同级安全边界；不上传）。
- `digest-cache/{bvid}@p{n}.json`：摘要+字幕缓存，30 天过期。
- `notes.json`：笔记。
- 导出目录由用户设置（默认 `文档/BilibiliDigest`），导出库通过扫描该目录实时构建。

## 7. UI 规格（Vue 3）

- **侧边栏标签页**：摘要（章节时间线+关键观点）、字幕（原文/中文/双语切换）、笔记、导出库、任务。
- **导出库**：树形视图——合集=文件夹（可展开折叠）→ 视频文件；点击文件右侧预览面板渲染 Markdown（内置渲染器）或 HTML（iframe srcdoc）；"在文件夹中显示"按钮调 `shell.showItemInFolder`。
- **任务面板**：运行中/排队任务卡片（合集名、进度条 i/N、当前视频名），可取消。
- **设置页**：文本模型（GLM 5.2 默认/DeepSeek Flash，各存 Key）、ASR（百炼/豆包+App ID）、**默认保存目录**（系统目录选择对话框）、任务并发数。
- **页面注入**：浏览区视频页注入"AI 总结"胶囊按钮（等 B 站水合完成后再插入——沿用扩展版的 3 秒结算窗口教训）与 `n` 键笔记。

## 8. 功能对等清单（V1 全量）

字幕获取（B站字幕/百炼/豆包 ASR）✅；AI 摘要（GLM/DeepSeek）✅；翻译三模式 ✅；笔记（快捷键/时间戳跳转回浏览器视图）✅；选中解释 ✅；单视频导出 ✅；合集导出（预览/勾选/ASR 补充）✅；多模型设置与迁移 ✅；新增：默认保存目录、导出库、任务队列。

## 9. 错误处理

- AI/ASR 请求：沿用扩展版的 50s 空闲/120s 硬超时、2MiB 上限、错误码体系（NO_AI_KEY/AI_IDLE_TIMEOUT 等）。
- 豆包并发配额（`quota exceeded concurrency`）：队列自动重试（指数退避，最多 3 次），仍失败则任务标记失败并提示增购并发。
- B站 API 风控（如 code -352）：明确提示"登录态失效或触发风控，请在浏览区重新登录/稍后再试"。
- 文件写入失败（目录被删/占用）：任务失败并在设置里高亮保存目录问题。

## 10. 测试策略

- **单元（node:test）**：settings 迁移、导出文件名、字幕归一化（百炼/豆包/B站三源）、导出索引扫描、任务队列状态机（含失败隔离与 ASR 串行）。
- **E2E（Playwright `_electron`）**：启动应用 → 浏览区加载B站 → 登录态持久化 → 摘要生成（mock AI）→ 合集导出入队 → 切页任务不断 → 导出库可见文件。
- **手动验收清单**：四痛点逐条复验。

## 11. 打包分发

electron-builder → NSIS 安装包（x64），应用图标沿用扩展图标；`asar` 打包源码；首启引导：选择保存目录 → 浏览区扫码登录。

## 12. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | 工程骨架：Electron+Vue3+Vite、窗口/浏览区/侧边栏框架、设置页与持久化 | 能浏览B站并登录，设置可保存 |
| M2 | 服务层移植：字幕三源、AI 请求、摘要缓存 | 侧边栏能出摘要与字幕 |
| M3 | UI 对等：翻译三模式、笔记、选中解释 | 与扩展功能对等 |
| M4 | 导出队列+导出库+任务面板 | 四痛点全部解决 |
| M5 | 打包与首启引导 | 安装包可用 |

## 13. 风险与对策

- **B站对内嵌浏览器风控**：UA 设常规 Chrome、登录走真实页面扫码、请求尽量复用浏览区 session cookie；若仍被拦，降级为主进程带 cookie 的 HTTP 请求（扩展版已验证可行）。
- **豆包/百炼计费与并发**：预览页明示预计音频时长；ASR 串行+退避。
- **Electron 体积**（~100MB）：接受；对比收益（零安装门槛）可换。
- **WebView 与扩展 DOM 注入差异**：注入时机沿用"结算窗口"方案；B站改版风险与扩展版同等。

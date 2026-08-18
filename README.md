# Bilibili Digest 桌面版

把 B 站视频变成**可阅读、可跳转、可总结、可保存**的中文学习资料。桌面版是 [Chrome 扩展版](https://github.com/SouthTwilight/bilibili-digest) 的重构：内嵌 B 站浏览器 + 侧边栏工具栏，免安装扩展、免绑定 Chrome。

## 功能一览

- **内嵌 B 站浏览**：登录一次长期保留，页面零注入零干扰
- **字幕获取**：优先 B 站字幕（免费），无字幕视频可一键语音识别（阿里百炼 Fun-ASR / 豆包极速版，按量计费）
- **AI 总结**：GLM 5.2 / DeepSeek Flash 双模型可切换，章节时间线 + 关键观点，点击时间戳跳转视频
- **翻译**：原文 / 中文 / 双语三模式，按段缓存不重复计费
- **选中解释**：字幕里选中任意文字，结合上下文解释
- **笔记**：侧边栏「记下当前时刻」，当前字幕 AI 润色成句，带时间戳回跳
- **导出**：Markdown / HTML 学习资料（含 AI 章节），单视频或整个合集
  - **导出队列在主进程运行**——切换页面、切合集、最小化都不打断
  - 直接写入默认保存目录，**零保存弹窗**
  - 合集导出前预览每个视频的字幕来源，无字幕的按需勾选 ASR 补充
- **导出库**：侧边栏树形浏览保存目录（合集=文件夹），点击预览 md/html/笔记，一键在资源管理器定位
- **数据组织**：`保存目录/合集名/视频名_BV号/` 一视频一文件夹，笔记、导出、总结同处

## 安装与使用

从 [Releases](../../releases) 下载 `Bilibili Digest Setup x.x.x.exe` 安装。首次启动引导选择保存目录，然后在右侧页面扫码登录 B 站，最后到「设置」页填入：

- **文本模型 Key**：智谱开放平台（GLM）或 DeepSeek 的按量付费 Key（Coding Plan 类订阅 Key 不可用）
- **语音识别 Key**（可选）：阿里百炼 API Key，或火山引擎语音技术应用维度的 Access Token + App ID（成对填写）

## 开发

```bash
npm install          # 已内置 npmmirror 镜像（.npmrc）
npm test             # 单元测试（node:test）
npm run dev          # 开发模式（HMR）
npm run package      # 构建并打包 NSIS 安装程序到 dist/
```

## 技术栈与架构

Electron（主进程 Node）+ Vue 3 + Vite（侧边栏）+ electron-builder（NSIS）。

```
主窗口
├─ 顶部工具条（后退/前进/刷新/首页/地址）      ── Vue 渲染进程
├─ 侧边栏：摘要│字幕│笔记│导出库│任务│设置      ── Vue 渲染进程
└─ B站浏览区（WebContentsView，仅放行 bilibili 域，登录态持久化）

主进程 src/main/core/
├─ bilibili.js        view/字幕/合集/音轨 API，wbi 请求签名（防软风控）
├─ transcript-service 字幕优先/ASR 回落的来源编排
├─ asr-bailian.js     百炼：OSS 上传 + 异步轮询
├─ asr-doubao.js      豆包极速版：音轨 base64 直传
├─ ai.js              GLM/DeepSeek chat/completions（超时/限额保护）
├─ translation.js     批量翻译 + 按 ID 对齐校验
├─ export-queue.js    双车道导出队列（字幕并发/ASR 串行/失败隔离）
├─ export-render.js   md/html 学习资料渲染
├─ library.js         保存目录扫描（合集/视频/文件树）
├─ digest-cache.js    每视频分槽字幕缓存（subtitle/asr 独立，来源切换零成本）
├─ notes.js           目录式笔记存储
└─ settings-store.js  多模型注册表 + 迁移
```

## 已知注意事项

- 豆包语音识别有并发配额，导出队列对 ASR 任务严格串行并在限流时提示
- B 站个别接口对高频调用限流（返回空字幕列表），主进程已做 wbi 签名 + 页面上下文降级重试
- 语音识别按量计费（百炼 ≈0.79 元/小时，豆包 ≈4.5 元/小时），有 B 站字幕的视频始终零成本

## License

MIT

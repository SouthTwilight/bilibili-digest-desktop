# Bilibili Digest 桌面版

把 B 站视频变成**可阅读、可跳转、可总结、可保存**的中文学习资料。桌面版是 [Chrome 扩展版](https://github.com/jasonmarkppp/bilibili-digest) 的重构：内嵌 B 站浏览器 + 侧边栏工具栏，免安装扩展、免绑定 Chrome。

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

## API Key 获取与费用说明

本应用涉及两类 Key：

- **文本模型 Key**（AI 总结 / 翻译 / 笔记 / 选中解释）：GLM 或 DeepSeek 二选一
- **语音识别 Key**（可选，仅无 B 站字幕的视频需要）：阿里百炼 Fun-ASR，或火山引擎豆包录音识别

> 有 B 站字幕的视频始终不调用语音识别，因此不会产生 ASR 费用。

### 阿里百炼（语音识别，可选）

**获取步骤**

1. 注册 / 登录阿里云账号，开通「百炼大模型服务平台」（Model Studio）。
2. 在百炼控制台左侧或右上角进入「API-KEY」页面，创建一个 API Key（形如 `sk-...`）。
3. 复制该 Key，粘贴到本应用「设置 → 语音识别 Key → 阿里百炼」。

> ⚠️ **已知坑**：阿里百炼 API Key 需要在「模型页」新建/切换到目标**业务空间**后创建；使用**默认业务空间**创建的 API Key 可能会导致权限不足，即使账户余额充足也会报 `Access to model denied` 或权限不足错误。请确认 API Key 所属业务空间与要调用的模型一致。

**费用消耗**

- 按量计费：`fun-asr` 录音文件识别按音频时长计费，参考价约 **0.79 元 / 小时**。
- 有 B 站字幕的视频不需要 ASR，始终零成本。
- 新用户 / 新开通时可能有免费额度，具体以阿里云百炼控制台实时价格和活动为准。

官方文档：[阿里云百炼 - 获取 API Key](https://bailian.console.aliyun.com/)、[模型调用计费](https://help.aliyun.com/zh/model-studio/model-pricing)

### 火山引擎（语音识别，可选）

**获取步骤**

1. 注册 / 登录火山引擎账号，开通「语音技术」服务。
2. 进入语音技术控制台，创建一个应用，获取 **App ID**（旧版控制台为 App Key）。
3. 按控制台版本选择填写方式：
   - **新版控制台**：生成单个 **API Key**，填入本应用「语音识别 Key → 火山引擎 / 豆包」。
   - **旧版控制台**：使用 **Access Token + App ID** 成对填写。
4. 确认应用已开通「录音文件识别极速版」相关资源（本项目使用 `volc.bigasr.auc_turbo`，开通会赠送一定免费额度）。

**费用消耗**

- 按量计费：豆包录音识别极速版参考价约 **4.5 元 / 小时**。
- 语音识别有并发配额，导出队列会对 ASR 任务严格串行；并发不足时会提示稍后重试。
- 具体价格以火山引擎控制台「计费说明」和开通页面为准。

官方文档：[豆包语音 - 调用流程](https://console.volcengine.com/speech)、[豆包语音 - 计费说明](https://docs.volcengine.com/docs/6561/1359370?lang=zh)

### DeepSeek（文本模型）

**获取步骤**

1. 打开 [DeepSeek 开放平台](https://platform.deepseek.com) 注册并登录。
2. 在「API Keys」页面创建一个 API Key（形如 `sk-...`）。
3. 在「费用 / 充值」页面按需充值（按量预付费）。
4. 将 Key 填入本应用「设置 → 文本模型 Key → DeepSeek」。

**费用消耗**

- 按 token 计费，输入和输出分别计价。
- 本项目使用 `deepseek-v4-flash`（DeepSeek Flash）模型，通常比满血推理模型更便宜、响应更快。
- Coding Plan 等订阅类 Key **不可用**，必须是开放平台的按量付费 API Key。

官方文档：[DeepSeek 模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)

### GLM / 智谱（文本模型）

**获取步骤**

1. 打开 [智谱开放平台](https://open.bigmodel.cn) 注册并登录，完成实名认证。
2. 在控制台「API Keys」页面创建一个 API Key（旧版形如 `id.secret`，新版为 `Bearer` 风格）。
3. 按需充值（按量付费）。
4. 将 Key 填入本应用「设置 → 文本模型 Key → GLM」。

**费用消耗**

- 按 token 计费，不同 GLM 模型价格不同。
- 本项目使用 `glm-5.2`，具体单价以智谱开放平台控制台实时价格为准。
- Coding Plan 类订阅 Key **不可用**，必须是 API 按量付费 Key。

官方文档：[智谱开放平台](https://open.bigmodel.cn)、[Z.AI Pricing](https://docs.z.ai/guides/overview/pricing)

### 费用速览

| 用途 | 服务 | Key 获取位置 | 计费方式 | 参考价格 |
| --- | --- | --- | --- | --- |
| 文本模型 | DeepSeek | platform.deepseek.com | 按 token | `deepseek-v4-flash` 以官方定价为准 |
| 文本模型 | GLM | open.bigmodel.cn | 按 token | `glm-5.2` 以官方定价为准 |
| 语音识别 | 阿里百炼 | 阿里云百炼控制台 | 按音频时长 | ≈0.79 元 / 小时 |
| 语音识别 | 火山引擎豆包 | 火山引擎语音技术控制台 | 按音频时长 / 并发配额 | ≈4.5 元 / 小时 |

> 以上价格为撰写时参考，实际费用以各平台控制台实时报价、免费额度和活动为准。

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
└─ B站浏览区（WebContentsView，仅放行 B 站相关域（bilibili.com / biligame.com SSO），登录态持久化）

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

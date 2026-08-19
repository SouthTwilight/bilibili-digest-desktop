#!/usr/bin/env node
// Local Bilibili subtitle chain debug server.
//
// Usage:
//   node scripts/debug-subtitle-server.mjs
//   open http://127.0.0.1:8790
//
// It reuses the same core chain as the app (wbi signing, subtitle selection,
// JSON download and normalization) through a plain Node fetch, so you can
// manually inspect every layer without launching Electron.

import { createServer } from "node:http";
import { initBilibiliHttpFetch } from "../src/main/core/http.js";
import { debugFetchSubtitleChain } from "../src/main/core/bilibili.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 8790);

// The debug page can pass an optional Cookie header (e.g. SESSDATA=...). It is
// stored per server process and applied to the next debug request.
let debugCookie = "";

initBilibiliHttpFetch(async (url, options = {}) => {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Referer: "https://www.bilibili.com/",
    ...(debugCookie ? { Cookie: debugCookie } : {}),
    ...(options.headers || {}),
  };
  return fetch(url, { ...options, headers });
});

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>B站字幕链路调试</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; background: #f6f7f9; color: #222; }
  h1 { font-size: 20px; }
  .card { background: #fff; border: 1px solid #e3e5e8; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  label { display: block; margin: 8px 0 4px; font-weight: 600; }
  input, textarea { width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #ccc; border-radius: 6px; font-family: monospace; }
  button { margin-top: 12px; padding: 8px 18px; border: 0; border-radius: 6px; background: #00a1d6; color: #fff; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .step { border: 1px solid #e3e5e8; border-radius: 8px; margin-top: 12px; overflow: hidden; }
  .step-head { padding: 10px 12px; background: #f0f2f5; font-weight: 600; cursor: pointer; }
  .step-head.ok { border-left: 4px solid #2ecc71; }
  .step-head.fail { border-left: 4px solid #e74c3c; }
  .step-body { padding: 12px; display: none; white-space: pre-wrap; word-break: break-all; background: #fafbfc; font-family: monospace; font-size: 12px; }
  .step.open .step-body { display: block; }
  .error { color: #c0392b; }
  .muted { color: #888; font-size: 13px; }
</style>
</head>
<body>
  <h1>B站字幕获取链路调试</h1>
  <div class="card">
    <label>BVID</label>
    <input id="bvid" placeholder="例如 BV1xx411c7mD" value="" />
    <label>分P（默认 1）</label>
    <input id="page" type="number" min="1" value="1" />
    <label>Cookie（可选，用于带登录态调试；例如 SESSDATA=xxx; bili_jct=xxx）</label>
    <textarea id="cookie" rows="2" placeholder="可选"></textarea>
    <button id="run">执行调试</button>
    <div class="muted" id="status"></div>
  </div>
  <div id="result"></div>

<script>
const $ = (id) => document.getElementById(id);
$("run").addEventListener("click", async () => {
  const bvid = $("bvid").value.trim();
  const page = $("page").value || "1";
  const cookie = $("cookie").value.trim();
  if (!bvid) { alert("请输入 BVID"); return; }
  $("run").disabled = true;
  $("status").textContent = "请求中…";
  $("result").innerHTML = "";
  try {
    const q = new URLSearchParams({ bvid, page, cookie });
    const res = await fetch("/api/debug?" + q.toString());
    const data = await res.json();
    $("status").textContent = res.ok ? "" : ("HTTP " + res.status);
    render(data);
  } catch (e) {
    $("status").textContent = "请求失败：" + e.message;
  } finally {
    $("run").disabled = false;
  }
});

function render(data) {
  const root = $("result");
  root.innerHTML = "";
  if (!data || !Array.isArray(data.steps)) {
    root.innerHTML = '<div class="card error">返回格式异常</div>';
    return;
  }
  const box = document.createElement("div");
  box.className = "card";
  const title = document.createElement("div");
  title.innerHTML = data.success
    ? '<b style="color:#2ecc71">链路成功</b>'
    : '<b style="color:#e74c3c">链路失败</b>';
  box.appendChild(title);
  for (const step of data.steps) {
    const div = document.createElement("div");
    div.className = "step" + (step.ok ? " ok" : " fail");
    const head = document.createElement("div");
    head.className = "step-head";
    head.textContent = step.name + (step.ok ? "" : " ✗");
    head.addEventListener("click", () => div.classList.toggle("open"));
    const body = document.createElement("div");
    body.className = "step-body";
    body.textContent = JSON.stringify(step, null, 2);
    div.appendChild(head);
    div.appendChild(body);
    box.appendChild(div);
  }
  root.appendChild(box);
}
</script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(PAGE);
    return;
  }

  if (url.pathname === "/api/debug") {
    const bvid = String(url.searchParams.get("bvid") || "").trim();
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const cookie = String(url.searchParams.get("cookie") || "").trim();
    if (!bvid) {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: "缺少 bvid" }));
      return;
    }
    debugCookie = cookie;
    try {
      const result = await debugFetchSubtitleChain(bvid, page);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  res.statusCode = 404;
  res.end("Not Found");
});

server.listen(PORT, HOST, () => {
  console.log(`B站字幕链路调试服务已启动: http://${HOST}:${PORT}`);
});

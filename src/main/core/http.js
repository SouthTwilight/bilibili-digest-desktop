// Bilibili HTTP access for the main process.
//
// Deliberately avoids BOTH network stacks that touch Chromium:
//   - net.fetch follows the system proxy, and Bilibili's CDN serves WRONG
//     subtitle files for the same URLs through foreign/shared proxy exits;
//   - the main process's global fetch is Electron's Chromium-backed wrapper
//     with the same problem plus Chromium's HTTP cache.
// Node's https module goes direct, uncached, and measured 100% correct.
// Login cookies are attached manually from the embedded browser session.
import { request as httpsRequest } from "node:https";

let bilibiliSession = null;
let bilibiliUserAgent = "";

export function initBilibiliHttp(session) {
  bilibiliSession = session;
  bilibiliUserAgent = session
    .getUserAgent()
    .replace(/\s*Electron\/\S+/i, "")
    .replace(/\s*bilibili-digest-desktop\/\S+/i, "")
    .trim();
}

async function sessionCookieHeader(url) {
  const cookies = await bilibiliSession.cookies.get({ url });
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function rawRequest(url, headers, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "GET", headers }, (res) => {
      resolve(res);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("B站请求超时（30秒）")));
    req.on("error", reject);
    req.end();
  });
}

async function readBody(stream, limitBytes = 64 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limitBytes) throw new Error("响应超过大小限制");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function makeResponse(status, headers, bodyBuffer) {
  const text = bodyBuffer.toString("utf8");
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

export async function bilibiliFetch(url, options = {}) {
  if (!bilibiliSession) {
    throw new Error("Bilibili session is not initialized yet.");
  }
  const cookie = await sessionCookieHeader(url);
  const baseHeaders = {
    "User-Agent": bilibiliUserAgent,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: "https://www.bilibili.com/",
    ...(cookie ? { Cookie: cookie } : {}),
    ...(options.headers || {}),
  };

  let currentUrl = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const res = await rawRequest(currentUrl, baseHeaders);
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      const location = res.headers.location;
      res.resume(); // drain the redirect body
      if (!location) throw new Error(`重定向缺少地址（HTTP ${res.statusCode}）`);
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    const body = await readBody(res);
    return makeResponse(res.statusCode, res.headers, body);
  }
  throw new Error("重定向次数过多");
}

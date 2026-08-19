// CDP-based fallback for Bilibili subtitle files.
//
// When the direct player/v2 -> subtitle JSON chain is rate-limited, we can
// still capture the subtitle file the embedded Bilibili player actually loads
// by watching Chrome DevTools Protocol network events. This is intentionally a
// last-resort path: it may reload the current video page to force the player
// to request subtitles again.

import { normalizeTranscript } from "./bilibili.js";

const SUBTITLE_URL_RE = /(aisubtitle\.hdslb\.com|subtitle).*\.json/i;
const TIMEOUT_MS = 15_000;

export function createCdpSubtitleFetcher(getBrowserView) {
  return async function fetchSubtitleViaCdp(videoId, cid) {
    const view = getBrowserView?.();
    const contents = view?.webContents;
    if (!contents || contents.isDestroyed()) {
      return {
        success: false,
        error: "CDP_UNAVAILABLE",
        message: "浏览器视图不可用，无法使用 CDP 兜底。",
      };
    }

    let attached = false;
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3");
      attached = true;
    }

    try {
      await contents.debugger.sendCommand("Network.enable");
    } catch (error) {
      if (attached) {
        try {
          contents.debugger.detach();
        } catch {}
      }
      return {
        success: false,
        error: "CDP_ENABLE_FAILED",
        message: `CDP Network 开启失败：${error.message}`,
      };
    }

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve({
          success: false,
          error: "CDP_TIMEOUT",
          message: "CDP 等待字幕文件超时（15 秒）。",
        });
      }, TIMEOUT_MS);

      const onMessage = (_event, method, params) => {
        if (method !== "Network.responseReceived") return;
        const url = params?.response?.url || "";
        if (!SUBTITLE_URL_RE.test(url)) return;
        const requestId = params.requestId;

        contents.debugger
          .sendCommand("Network.getResponseBody", { requestId })
          .then(({ body }) => {
            let data;
            try {
              data = JSON.parse(body);
            } catch (error) {
              throw new Error(`字幕 JSON 解析失败：${error.message}`);
            }
            const normalized = normalizeTranscript(
              (data.body || []).map((chunk) => ({
                text: String(chunk.content || "").trim(),
                start: Math.max(0, Number(chunk.from) || 0),
                end: Math.max(0, Number(chunk.to) || 0),
              })),
              {
                language:
                  typeof data?.font_class === "string" ? data.font_class : null,
                source: "bilibili-subtitle",
              },
            );
            cleanup();
            resolve(normalized);
          })
          .catch((error) => {
            cleanup();
            resolve({
              success: false,
              error: "CDP_BODY_FAILED",
              message: `读取 CDP 响应体失败：${error.message}`,
            });
          });
      };

      const cleanup = () => {
        clearTimeout(timer);
        contents.debugger.removeListener("message", onMessage);
        if (attached) {
          try {
            contents.debugger.detach();
          } catch {}
        }
      };

      contents.debugger.on("message", onMessage);

      // Force the player to (re)load subtitles so the network event fires.
      // To avoid hijacking the user's current page, only reload when the
      // embedded view is already on the target video.
      const currentUrl = contents.getURL();
      if (!currentUrl.includes(`/video/${videoId}`)) {
        cleanup();
        resolve({
          success: false,
          error: "CDP_PAGE_MISMATCH",
          message: "当前页面不是该视频，CDP 兜底不会自动跳转；请先在应用内打开该视频页面后重试。",
        });
        return;
      }
      contents.reload();
    });
  };
}

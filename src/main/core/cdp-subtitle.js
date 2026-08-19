// CDP-based fallback for Bilibili subtitles.
//
// The direct player/v2 chain can return an empty subtitle list when Bilibili
// requires the page-generated dm_* risk-control parameters. In that case we
// can still recover the subtitle by watching the embedded player's own network
// traffic via Chrome DevTools Protocol:
//
//   1. Capture the player API response (/x/player/wbi/v2 or /x/player/v2)
//      which contains the real subtitle_url.
//   2. Download that subtitle JSON (normally the CDN URL is directly usable).
//   3. If the file download still fails, fall back to capturing the subtitle
//      file response from the page network.
//
// This path is user-triggered only (the "CDP 兜底重试" button) and never runs
// automatically.

import { normalizeTranscript } from "./bilibili.js";
import { bilibiliFetch } from "./http.js";

const PLAYER_API_RE = /\/x\/player\/(?:wbi\/)?v2/i;
const SUBTITLE_FILE_RE = /(aisubtitle\.hdslb\.com|subtitle).*\.json/i;
const TIMEOUT_MS = 20_000;

function pickSubtitle(subtitles) {
  return (
    subtitles.find((item) => item?.lan === "ai-zh") ||
    subtitles.find((item) => /zh/i.test(item?.lan || "")) ||
    subtitles[0]
  );
}

function normalizeSubtitleData(data, language) {
  return normalizeTranscript(
    (data?.body || []).map((chunk) => ({
      text: String(chunk?.content || "").trim(),
      start: Math.max(0, Number(chunk?.from) || 0),
      end: Math.max(0, Number(chunk?.to) || 0),
    })),
    { language: language || null, source: "bilibili-subtitle" },
  );
}

async function downloadSubtitleFile(subtitleUrl) {
  const fileUrl = subtitleUrl.startsWith("//")
    ? `https:${subtitleUrl}`
    : subtitleUrl;
  const response = await bilibiliFetch(fileUrl);
  if (!response.ok) throw new Error(`字幕文件下载失败（HTTP ${response.status}）`);
  return response.json();
}

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
      // Avoid serving the player API / subtitle file from cache so the
      // network events actually fire after reload.
      await contents.debugger.sendCommand("Network.setCacheDisabled", {
        cacheDisabled: true,
      });
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
      let settled = false;
      const timer = setTimeout(() => {
        cleanup();
        resolve({
          success: false,
          error: "CDP_TIMEOUT",
          message: "CDP 等待字幕接口/文件超时（20 秒）。",
        });
      }, TIMEOUT_MS);

      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
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

      const onMessage = async (_event, method, params) => {
        if (method !== "Network.responseReceived") return;
        const url = params?.response?.url || "";
        const requestId = params.requestId;

        try {
          // Case 1: player API response -> get the real subtitle_url.
          if (PLAYER_API_RE.test(url)) {
            const { body } = await contents.debugger.sendCommand(
              "Network.getResponseBody",
              { requestId },
            );
            const data = JSON.parse(body);
            const subtitles = data?.data?.subtitle?.subtitles || [];
            const preferred = pickSubtitle(subtitles);
            if (preferred?.subtitle_url) {
              try {
                const fileData = await downloadSubtitleFile(preferred.subtitle_url);
                const normalized = normalizeSubtitleData(
                  fileData,
                  preferred.lan || preferred.lan_doc,
                );
                if (normalized.success) {
                  finish(normalized);
                  return;
                }
              } catch (error) {
                // File download failed; keep listening for the page's own
                // subtitle file response below.
              }
            }
          }

          // Case 2: the subtitle JSON file itself is loaded by the page.
          if (SUBTITLE_FILE_RE.test(url)) {
            const { body } = await contents.debugger.sendCommand(
              "Network.getResponseBody",
              { requestId },
            );
            const data = JSON.parse(body);
            const normalized = normalizeSubtitleData(data, null);
            if (normalized.success) {
              finish(normalized);
            }
          }
        } catch (error) {
          // Ignore per-request errors and keep waiting for a usable response.
        }
      };

      contents.debugger.on("message", onMessage);

      // Force the player to (re)load subtitles. Only reload when the embedded
      // view is already on the target video to avoid hijacking the user.
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

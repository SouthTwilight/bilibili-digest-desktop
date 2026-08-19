import { bilibiliFetch } from "./http.js";
import { createHash } from "node:crypto";

const BILIBILI_REFERER = "https://www.bilibili.com/";

// ---- wbi request signing ---------------------------------------------------
// player/v2 intermittently soft-throttles unsigned callers by returning an
// empty subtitle list. Signing works around it (algorithm documented in the
// bilibili-API-collect project): fetch the key pair from nav, derive a mixin
// key through the fixed permutation table, then sign the query with MD5.

const WBI_MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

let wbiKeys = null;
let wbiKeysFetchedAt = 0;

function md5Hex(text) {
  return createHash("md5").update(text, "utf8").digest("hex");
}

async function getWbiKeys() {
  if (wbiKeys && Date.now() - wbiKeysFetchedAt < 3600_000) return wbiKeys;
  const response = await bilibiliFetch("https://api.bilibili.com/x/web-interface/nav");
  const payload = await response.json();
  const img = payload?.data?.wbi_img || {};
  const extract = (url = "") => (url.split("/").pop() || "").replace(/\.\w+$/, "");
  wbiKeys = { imgKey: extract(img.img_url), subKey: extract(img.img_sub_url) };
  wbiKeysFetchedAt = Date.now();
  return wbiKeys;
}

async function wbiSignedUrl(url) {
  try {
    const parsed = new URL(url);
    const { imgKey, subKey } = await getWbiKeys();
    const mixin = WBI_MIXIN_TABLE.map((n) => `${imgKey}${subKey}`[n]).join("").slice(0, 32);
    const params = new URLSearchParams(parsed.search);
    params.delete("w_rid");
    params.set("wts", String(Math.floor(Date.now() / 1000)));
    const query = Array.from(params.entries())
      .filter(([, value]) => !/[!'()*]/.test(value))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const wRid = md5Hex(query + mixin);
    return `${parsed.origin}${parsed.pathname}?${query}&w_rid=${wRid}`;
  } catch {
    return url; // Unsigned on any failure — same behaviour as before.
  }
}

export function canonicalBilibiliUrl(videoId) {
  const normalized = String(videoId || "").trim();
  if (!/^BV[A-Za-z0-9]{10}$/.test(normalized)) {
    throw new Error("Invalid Bilibili BV id.");
  }
  return `https://www.bilibili.com/video/${normalized}`;
}

export function parseVideoPageUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/video\/(BV[A-Za-z0-9]{10})/i);
    if (!match) return null;
    return {
      bvid: match[1],
      page: Math.max(1, Number(parsed.searchParams.get("p")) || 1),
    };
  } catch {
    return null;
  }
}

export async function fetchBilibiliView(videoId) {
  const response = await bilibiliFetch(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(videoId)}`,
  );
  const payload = await response.json();
  if (!payload || payload.code !== 0 || !payload.data) {
    throw new Error(payload?.message || "无法读取 B 站视频信息。");
  }
  return payload.data;
}

export async function getVideoDetails(videoId) {
  const view = await fetchBilibiliView(videoId);
  return {
    title: String(view.title || "").trim(),
    channelName: String(view.owner?.name || "").trim(),
    description: String(view.desc || "").trim(),
    duration: Math.max(0, Math.round(Number(view.duration || 0))),
    canonicalUrl: canonicalBilibiliUrl(videoId),
  };
}

export function resolvePageCid(view, requestedPage) {
  const page =
    view.pages?.[Math.max(1, requestedPage) - 1] || view.pages?.[0];
  if (!page?.cid) throw new Error("无法识别当前分 P 的 CID。");
  return page.cid;
}

export function collectionVideosFromView(view) {
  const season = view?.ugc_season;
  if (!season?.sections?.length) return null;
  const seen = new Set();
  const videos = [];
  for (const section of season.sections) {
    for (const episode of section.episodes || []) {
      if (!episode?.bvid || seen.has(episode.bvid)) continue;
      seen.add(episode.bvid);
      videos.push({
        bvid: episode.bvid,
        title:
          String(episode.title || "")
            .replace(/^\s*P?\d+\s*[.、:-]\s*/, "")
            .trim() || episode.bvid,
        duration: Math.max(
          0,
          Math.round(Number(episode?.arc?.duration ?? episode?.duration ?? 0)),
        ),
      });
    }
  }
  if (!videos.length) return null;
  return { collectionTitle: String(season.title || "").trim() || "合集", videos };
}

export async function getCollectionInfo(videoId) {
  const collection = collectionVideosFromView(await fetchBilibiliView(videoId));
  if (!collection) return { inCollection: false };
  return {
    inCollection: true,
    collectionTitle: collection.collectionTitle,
    videoCount: collection.videos.length,
  };
}

// ---- Bilibili subtitle track ---------------------------------------------

async function fetchSubtitleTrackList(videoId, cid) {
  const rawUrl = `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(videoId)}&cid=${cid}`;
  const url = await wbiSignedUrl(rawUrl);

  // Bilibili intermittently soft-throttles player/v2 with an empty subtitle
  // list. Retry a couple of times with a short delay before reporting
  // "no subtitles" — no page-context fallback: the browser view's page is
  // unsandboxed third-party state we cannot trust to answer for a
  // different video's parameters.
  let payload = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await bilibiliFetch(url);
    payload = await response.json();
    const subtitles = payload?.data?.subtitle?.subtitles || [];
    if (payload?.code === 0 && subtitles.length) return subtitles;
    if (payload && payload.code !== 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!payload || payload.code !== 0) {
    throw new Error(payload?.message || "无法读取 B 站字幕列表。");
  }
  return payload?.data?.subtitle?.subtitles || [];
}

export async function bilibiliVideoHasSubtitle(videoId) {
  try {
    const view = await fetchBilibiliView(videoId);
    const cid = view.pages?.[0]?.cid;
    if (!cid) return false;
    const subtitles = await fetchSubtitleTrackList(videoId, cid);
    return subtitles.some((item) => item?.subtitle_url);
  } catch {
    return false;
  }
}

export async function fetchBilibiliSubtitleTranscript(videoId, cid) {
  try {
    const subtitles = await fetchSubtitleTrackList(videoId, cid);
    // AI subtitles first (most complete & granular), then human CC tracks,
    // then whatever exists.
    const preferred =
      subtitles.find((item) => item?.lan === "ai-zh") ||
      subtitles.find((item) => /zh/i.test(item.lan || "")) ||
      subtitles[0];
    if (!preferred?.subtitle_url) {
      return {
        success: false,
        error: "NO_TRANSCRIPT",
        message: "这个视频没有可用的 B 站字幕。如需语音识别生成，请在下方手动开启。",
      };
    }
    const subtitleUrl = preferred.subtitle_url.startsWith("//")
      ? `https:${preferred.subtitle_url}`
      : preferred.subtitle_url;
    const response = await bilibiliFetch(subtitleUrl);
    if (!response.ok) throw new Error("B 站字幕文件下载失败。");
    const data = await response.json();

  return normalizeTranscript(
    (data.body || []).map((chunk) => ({
      text: String(chunk.content || "").trim(),
      start: Math.max(0, Number(chunk.from) || 0),
      end: Math.max(0, Number(chunk.to) || 0),
    })),
    { language: preferred.lan || null, source: "bilibili-subtitle" },
  );
  } catch (error) {
    return { success: false, error: error.message, message: `B 站字幕获取失败：${error.message}` };
  }
}

// ---- Audio track (for ASR) -----------------------------------------------

export async function fetchBilibiliAudioBlob(videoId, cid, onProgress) {
  const response = await bilibiliFetch(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(videoId)}&cid=${encodeURIComponent(cid)}&fnval=16&qn=16`,
  );
  const payload = await response.json();
  const audioTracks = [...(payload.data?.dash?.audio || [])].sort(
    (a, b) =>
      (Number(a.bandwidth) || Number.MAX_SAFE_INTEGER) -
      (Number(b.bandwidth) || Number.MAX_SAFE_INTEGER),
  );
  // Speech recognition does not benefit from the highest audio bitrate; the
  // smallest track cuts both the CDN download and the ASR upload.
  const audio = audioTracks[0];
  const candidates = [
    audio?.baseUrl,
    audio?.base_url,
    ...(audio?.backupUrl || []),
    ...(audio?.backup_url || []),
  ].filter(Boolean);
  if (!candidates.length) throw new Error("无法获取 B 站音轨地址。");

  let lastError;
  for (const url of candidates) {
    try {
      const audioResponse = await bilibiliFetch(url, {
        headers: { Referer: BILIBILI_REFERER },
      });
      if (!audioResponse.ok) throw new Error(`HTTP ${audioResponse.status}`);
      const buffer = Buffer.from(await audioResponse.arrayBuffer());
      if (!buffer.length) throw new Error("音轨为空");
      onProgress?.(
        `低码率音轨约 ${(buffer.length / 1024 / 1024).toFixed(1)} MB`,
      );
      return buffer;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`B 站音轨下载失败：${lastError?.message || "未知"}`);
}

// ---- Shared transcript normalization -------------------------------------

// Every transcript source funnels into one shape: entries with {text, start,
// duration} plus a `[MM:SS] text` timestamped rendering for the AI prompt.
export function normalizeTranscript(entries, meta = {}) {
  const transcript = entries
    .map((entry) => ({
      text: String(entry.text || "").trim(),
      start: Math.max(0, Number(entry.start || 0)),
      duration: Math.max(0, Number(entry.duration || 0)),
      language: entry.language || meta.language || "zh",
    }))
    .filter((entry) => entry.text);
  if (!transcript.length) {
    return { success: false, error: "EMPTY_TRANSCRIPT", message: "转写结果为空。" };
  }
  let plain = "";
  let timestamped = "";
  for (const entry of transcript) {
    const minutes = Math.floor(entry.start / 60);
    const seconds = Math.floor(entry.start % 60);
    plain += `${entry.text} `;
    timestamped += `[${minutes}:${String(seconds).padStart(2, "0")}] ${entry.text}\n`;
  }
  return {
    success: true,
    transcript,
    transcriptText: plain.trim(),
    transcriptTextTimestamped: timestamped.trim(),
    language: meta.language || "zh",
    source: meta.source || "unknown",
  };
}

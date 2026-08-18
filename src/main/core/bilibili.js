import { bilibiliFetch } from "./http.js";

const BILIBILI_REFERER = "https://www.bilibili.com/";

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
  const response = await bilibiliFetch(
    `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(videoId)}&cid=${cid}`,
  );
  const payload = await response.json();
  if (!payload || payload.code !== 0) {
    throw new Error(payload?.message || "无法读取 B 站字幕列表。");
  }
  return payload.data?.subtitle?.subtitles || [];
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
  const subtitles = await fetchSubtitleTrackList(videoId, cid);
  const preferred =
    subtitles.find((item) => /zh|ai-zh/i.test(item.lan || "")) || subtitles[0];
  if (!preferred?.subtitle_url) {
    return {
      success: false,
      error: "NO_TRANSCRIPT",
      message: "这个视频没有可用的 B 站字幕。",
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

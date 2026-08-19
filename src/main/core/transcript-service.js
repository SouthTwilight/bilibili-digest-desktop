import {
  fetchBilibiliView,
  resolvePageCid,
  fetchBilibiliSubtitleTranscript,
} from "./bilibili.js";
import { transcribeWithBailian } from "./asr-bailian.js";
import { transcribeWithDoubao } from "./asr-doubao.js";

// Transcript policy: automatic fetching (auto/subtitle modes) uses FREE
// Bilibili subtitle tracks ONLY — speech recognition is never triggered
// implicitly. ASR runs exclusively in the explicit "asr" mode, which the UI
// only enters when the user clicks "改用语音识别" or checks an ASR box in the
// collection export preview, so per-video cost is always a manual decision.
export async function fetchTranscript({ settings, videoId, page = 1, mode = "auto", track = "ai", onProgress }) {
  const view = await fetchBilibiliView(videoId);
  const cid = resolvePageCid(view, page);

  if (mode !== "asr") {
    // Pass the video's real duration so cross-wired subtitle files get
    // caught by the span check inside; `track` picks AI vs native CC.
    return fetchBilibiliSubtitleTranscript(
      videoId,
      view.aid,
      cid,
      Math.round(Number(view.duration) || 0),
      track,
    );
  }

  const doubaoReady = settings.asrProvider === "doubao" && settings.asrApiKeys.doubao;
  if (doubaoReady) {
    return transcribeWithDoubao(videoId, cid, settings, onProgress);
  }
  if (settings.asrApiKeys.bailian) {
    return transcribeWithBailian(videoId, cid, settings.asrApiKeys.bailian, onProgress);
  }
  return {
    success: false,
    error: "NO_ASR",
    message: "语音识别未配置：请在设置中填写百炼 API Key 或豆包 Access Token + App ID。",
  };
}

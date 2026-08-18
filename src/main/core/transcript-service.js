import {
  fetchBilibiliView,
  resolvePageCid,
  fetchBilibiliSubtitleTranscript,
} from "./bilibili.js";
import { transcribeWithBailian } from "./asr-bailian.js";
import { transcribeWithDoubao } from "./asr-doubao.js";

// Transcript precedence: free Bilibili subtitle tracks are always preferred
// when they exist; ASR (Bailian/Doubao) only fills in for videos without a
// track. This keeps per-video cost at zero whenever Bilibili already has
// subtitles.
export async function fetchTranscript({ settings, videoId, page = 1, onProgress }) {
  const view = await fetchBilibiliView(videoId);
  const cid = resolvePageCid(view, page);

  const subtitleResult = await fetchBilibiliSubtitleTranscript(videoId, cid);
  if (subtitleResult.success) return subtitleResult;

  const doubaoReady = settings.asrProvider === "doubao" && settings.asrApiKeys.doubao;
  const bailianReady = !!settings.asrApiKeys.bailian;
  if (doubaoReady) {
    return transcribeWithDoubao(videoId, cid, settings, onProgress);
  }
  if (bailianReady) {
    return transcribeWithBailian(videoId, cid, settings.asrApiKeys.bailian, onProgress);
  }
  return {
    success: false,
    error: "NO_TRANSCRIPT",
    message: "这个视频没有 B 站字幕，且语音识别未配置（或在设置中未填写可用的 Key）。",
  };
}

import {
  fetchBilibiliView,
  resolvePageCid,
  fetchBilibiliSubtitleTranscript,
} from "./bilibili.js";
import { transcribeWithBailian } from "./asr-bailian.js";
import { transcribeWithDoubao } from "./asr-doubao.js";

// Transcript precedence: free Bilibili subtitle tracks are always preferred
// when they exist; ASR (Bailian/Doubao) only fills in for videos without a
// track. `mode` lets the UI override: "asr" skips subtitles entirely (for
// poor ai-zh tracks), "subtitle" skips ASR, "auto" is the default order.
export async function fetchTranscript({ settings, videoId, page = 1, mode = "auto", onProgress }) {
  const view = await fetchBilibiliView(videoId);
  const cid = resolvePageCid(view, page);

  const doubaoReady = settings.asrProvider === "doubao" && settings.asrApiKeys.doubao;
  const bailianReady = !!settings.asrApiKeys.bailian;
  const asrReady = doubaoReady || bailianReady;

  if (mode !== "asr") {
    const subtitleResult = await fetchBilibiliSubtitleTranscript(videoId, cid);
    if (subtitleResult.success || mode === "subtitle") return subtitleResult;
  }
  if (doubaoReady) {
    return transcribeWithDoubao(videoId, cid, settings, onProgress);
  }
  if (bailianReady) {
    return transcribeWithBailian(videoId, cid, settings.asrApiKeys.bailian, onProgress);
  }
  return {
    success: false,
    error: "NO_ASR",
    message:
      mode === "asr"
        ? "语音识别未配置或 Key 不可用，请在设置中填写百炼/豆包凭证。"
        : "这个视频没有 B 站字幕，且语音识别未配置。",
  };
}

import {
  fetchBilibiliView,
  resolvePageCid,
  fetchBilibiliSubtitleTranscript,
} from "./bilibili.js";
import { transcribeWithBailian } from "./asr-bailian.js";
import { transcribeWithDoubao } from "./asr-doubao.js";

// Transcript orchestration with the same precedence rules as the extension:
// when an ASR provider is configured it is the source of truth (Bilibili
// ai-zh tracks are unreliable); preferSubtitle inverts that for batch export.
export async function fetchTranscript({ settings, videoId, page = 1, preferSubtitle = false, onProgress }) {
  const view = await fetchBilibiliView(videoId);
  const cid = resolvePageCid(view, page);

  const doubaoReady = settings.asrProvider === "doubao" && settings.asrApiKeys.doubao;
  const bailianReady = !!settings.asrApiKeys.bailian;
  const asrReady = doubaoReady || bailianReady;

  if (preferSubtitle || !asrReady) {
    const subtitleResult = await fetchBilibiliSubtitleTranscript(videoId, cid);
    if (subtitleResult.success || !asrReady) return subtitleResult;
  }
  if (doubaoReady) {
    return transcribeWithDoubao(videoId, cid, settings, onProgress);
  }
  return transcribeWithBailian(videoId, cid, settings.asrApiKeys.bailian, onProgress);
}

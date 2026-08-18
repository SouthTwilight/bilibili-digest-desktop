import { fetchBilibiliAudioBlob, normalizeTranscript } from "./bilibili.js";

const DOUBAO_ASR_FLASH_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
const DOUBAO_ASR_RESOURCE_ID = "volc.bigasr.auc_turbo";
const DOUBAO_ASR_MAX_BYTES = 100 * 1024 * 1024;
const DOUBAO_ASR_TIMEOUT_MS = 300_000;

// btoa over a ~30MB binary string can exceed the call-stack limit, so encode
// in chunks.
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export async function transcribeWithDoubao(videoId, cid, settings, onProgress) {
  const apiKey = settings.asrApiKeys.doubao;
  // New Volcengine consoles issue a single API key; older ones use an
  // App Key + Access Token pair.
  const appKey = settings.asrDoubaoAppKey || "";
  const headers = {
    "Content-Type": "application/json",
    "X-Api-Resource-Id": DOUBAO_ASR_RESOURCE_ID,
    "X-Api-Request-Id": crypto.randomUUID(),
  };
  if (appKey) {
    headers["X-Api-App-Key"] = appKey;
    headers["X-Api-Access-Key"] = apiKey;
  } else {
    headers["X-Api-Key"] = apiKey;
  }

  onProgress?.("正在下载B站音轨", "请保持网络畅通");
  const audio = await fetchBilibiliAudioBlob(videoId, cid, (detail) =>
    onProgress?.("正在下载B站音轨", detail),
  );
  if (audio.length > DOUBAO_ASR_MAX_BYTES) {
    throw new Error("音轨超过豆包 100MB 上限，请改用阿里百炼识别该视频。");
  }

  onProgress?.("正在上传并识别语音", "豆包极速版直接处理音轨数据");
  const body = JSON.stringify({
    user: { uid: appKey || "bilibili-digest-desktop" },
    audio: { format: "m4a", codec: "raw", data: bufferToBase64(audio) },
    request: { model_name: "bigmodel" },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOUBAO_ASR_TIMEOUT_MS);
  try {
    const response = await fetch(DOUBAO_ASR_FLASH_URL, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    const statusCode = response.headers.get("X-Api-Status-Code") || "";
    const payload = await response.json().catch(() => null);
    if (statusCode !== "20000000" || !response.ok) {
      const message = response.headers.get("X-Api-Message") || payload?.message || "";
      if (statusCode === "45000151") {
        throw new Error("豆包不接受该音轨格式，请切换回阿里百炼重试。");
      }
      if (statusCode === "45000010" && /concurrency/i.test(message)) {
        throw new Error("豆包并发配额已满，请稍后重试或在控制台增购并发。");
      }
      throw new Error(`豆包语音识别失败：${message || `HTTP ${response.status}`}`);
    }
    const utterances = payload?.result?.utterances || [];
    return normalizeTranscript(
      utterances.map((utterance) => ({
        text: utterance.text,
        start: Number(utterance.start_time || 0) / 1000,
        duration:
          (Number(utterance.end_time || utterance.start_time || 0) -
            Number(utterance.start_time || 0)) /
          1000,
      })),
      { language: "zh", source: "doubao-bigasr" },
    );
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("豆包语音识别超时（5分钟），请重试或切换回阿里百炼。");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

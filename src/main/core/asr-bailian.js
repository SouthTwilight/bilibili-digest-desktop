import { fetchBilibiliAudioBlob } from "./bilibili.js";

const BAILIAN_ASR_MODEL = "fun-asr";
const DASHSCOPE_BASE = "https://dashscope.aliyuncs.com/api/v1";

export async function transcribeWithBailian(videoId, cid, apiKey, onProgress) {
  onProgress?.("正在下载B站音轨", "请保持网络畅通");
  const audio = await fetchBilibiliAudioBlob(videoId, cid, (detail) =>
    onProgress?.("正在下载B站音轨", detail),
  );

  onProgress?.("正在获取百炼上传凭证", "");
  const policyResponse = await fetch(
    `${DASHSCOPE_BASE}/uploads?action=getPolicy&model=${BAILIAN_ASR_MODEL}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  const policyPayload = await policyResponse.json();
  if (!policyResponse.ok || !policyPayload.data) {
    throw new Error(policyPayload.message || "无法获取百炼临时上传凭证。");
  }

  onProgress?.("正在上传音轨", "上传至阿里云百炼临时空间");
  const policy = policyPayload.data;
  const filename = `${videoId}-${Date.now()}.m4a`;
  const key = `${policy.upload_dir}/${filename}`;
  const form = new FormData();
  form.append("OSSAccessKeyId", policy.oss_access_key_id);
  form.append("Signature", policy.signature);
  form.append("policy", policy.policy);
  form.append("x-oss-object-acl", policy.x_oss_object_acl);
  form.append("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite);
  form.append("key", key);
  form.append("success_action_status", "200");
  form.append("file", new Blob([audio], { type: "audio/mp4" }), filename);
  const uploadResponse = await fetch(policy.upload_host, { method: "POST", body: form });
  if (!uploadResponse.ok) throw new Error(`音频上传百炼失败（${uploadResponse.status}）。`);

  const taskResponse = await fetch(`${DASHSCOPE_BASE}/services/audio/asr/transcription`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
      "X-DashScope-OssResourceResolve": "enable",
    },
    body: JSON.stringify({
      model: BAILIAN_ASR_MODEL,
      input: { file_urls: [`oss://${key}`] },
      parameters: { language_hints: ["zh", "en"] },
    }),
  });
  const taskPayload = await taskResponse.json();
  const taskId = taskPayload.output?.task_id;
  if (!taskResponse.ok || !taskId) throw new Error(taskPayload.message || "无法提交百炼语音识别任务。");

  onProgress?.("正在识别语音", "长视频通常需要几分钟");
  const result = await pollBailianAsrTask(taskId, apiKey);
  const { normalizeTranscript } = await import("./bilibili.js");
  const sentences = result.transcripts?.flatMap((item) => item.sentences || []) || [];
  return normalizeTranscript(
    sentences.map((sentence) => ({
      text: sentence.text,
      start: Number(sentence.begin_time || 0) / 1000,
      duration:
        (Number(sentence.end_time || sentence.begin_time || 0) -
          Number(sentence.begin_time || 0)) /
        1000,
    })),
    { language: "zh", source: "aliyun-fun-asr" },
  );
}

async function pollBailianAsrTask(taskId, apiKey) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await fetch(`${DASHSCOPE_BASE}/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const payload = await response.json();
    const status = payload.output?.task_status;
    if (status === "FAILED" || status === "CANCELED") {
      throw new Error(payload.output?.message || payload.message || "百炼语音识别失败。");
    }
    if (status !== "SUCCEEDED") continue;
    const result = payload.output?.results?.[0];
    if (result?.subtask_status && result.subtask_status !== "SUCCEEDED") {
      throw new Error(result.message || "百炼语音识别子任务失败。");
    }
    if (!result?.transcription_url) throw new Error("百炼未返回转写结果地址。");
    const transcriptionResponse = await fetch(result.transcription_url);
    if (!transcriptionResponse.ok) throw new Error("无法下载百炼转写结果。");
    return transcriptionResponse.json();
  }
  throw new Error("百炼语音识别超时，请稍后重试。");
}

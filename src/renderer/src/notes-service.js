import { transcript, videoDetails, currentVideo } from "./store.js";

// Shared note-taking pipeline: resolve the transcript (loading it lazily if
// the user never opened the transcript tab), grab the line at the timestamp,
// polish it, persist, and report back.
export async function takeNoteAt(seconds) {
  if (!currentVideo.value || seconds == null) {
    return { ok: false, reason: "没有打开中的视频" };
  }

  if (!transcript.value?.transcript?.length) {
    const result = await window.desktop.getTranscript(
      currentVideo.value.bvid,
      currentVideo.value.page,
      "auto",
    );
    if (result.success) transcript.value = result.transcript;
  }

  const entries = transcript.value?.transcript || [];
  const targetIndex = entries.findIndex((entry) => entry.start >= seconds);
  const index = targetIndex === -1 ? entries.length - 1 : Math.max(0, targetIndex - 1);
  const target = entries[index];
  if (!target) {
    return { ok: false, reason: "当前视频还没有字幕数据，请先在字幕页获取" };
  }

  let text = target.text;
  try {
    const polished = await window.desktop.polishNote({
      videoTitle: videoDetails.value?.title || "",
      targetText: target.text,
      beforeText: entries[index - 1]?.text || "",
      afterText: entries[index + 1]?.text || "",
    });
    text = polished.text || target.text;
  } catch {}

  await window.desktop.addNote({
    videoId: `${currentVideo.value.bvid}@p${currentVideo.value.page}`,
    timestamp: seconds,
    text,
    videoTitle: videoDetails.value?.title || "",
    channelName: videoDetails.value?.channelName || "",
  });
  return { ok: true, timestamp: seconds };
}

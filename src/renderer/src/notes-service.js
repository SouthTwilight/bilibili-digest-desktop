import { transcript, videoDetails, currentVideo } from "./store.js";

// Collection membership is stable per video; cache per bvid to avoid an API
// round trip on every note.
const collectionCache = new Map();

export async function collectionTitleFor(bvid) {
  if (collectionCache.has(bvid)) return collectionCache.get(bvid);
  let title = "";
  try {
    const info = await window.desktop.getCollectionInfo(bvid);
    if (info?.inCollection) title = info.collectionTitle || "";
  } catch {}
  collectionCache.set(bvid, title);
  return title;
}

export async function videoNoteContext() {
  if (!currentVideo.value) return null;
  return {
    bvid: currentVideo.value.bvid,
    videoTitle: videoDetails.value?.title || "",
    collectionTitle: await collectionTitleFor(currentVideo.value.bvid),
  };
}

// Shared note-taking pipeline: resolve the transcript (loading it lazily if
// the user never opened the transcript tab), grab the line at the timestamp,
// polish it, persist into the save directory, and report back.
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

  const context = await videoNoteContext();
  // Screenshot the playing frame first; the image joins the note as a
  // picture/ file in the video folder.
  let imageBase64 = null;
  try {
    const shot = await window.desktop.captureFrame();
    if (shot?.success) imageBase64 = shot.imageBase64;
  } catch {}
  await window.desktop.addNote({
    bvid: currentVideo.value.bvid,
    timestamp: seconds,
    text,
    videoTitle: context?.videoTitle || "",
    channelName: videoDetails.value?.channelName || "",
    collectionTitle: context?.collectionTitle || "",
    imageBase64,
  });
    return { ok: true, timestamp: seconds };
}

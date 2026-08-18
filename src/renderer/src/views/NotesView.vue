<script setup>
import { ref, watch, onMounted, onUnmounted } from "vue";
import { currentVideo, transcript, videoDetails } from "../store.js";

const notes = ref([]);
const showAll = ref(false);
const toast = ref("");

let offShortcut = null;

async function refresh() {
  notes.value = await window.desktop.listNotes(
    showAll.value ? null : currentVideo.value ? `${currentVideo.value.bvid}@p${currentVideo.value.page}` : null,
  );
}

async function handleShortcut(payload) {
  if (!payload?.bvid || payload.seconds == null) return;
  const entries = transcript.value?.transcript || [];
  const index = entries.findIndex((entry) => entry.start >= payload.seconds);
  const targetIndex = index === -1 ? entries.length - 1 : Math.max(0, index - 1);
  const target = entries[targetIndex];
  if (!target) return;
  const rawText = target.text;
  let text = rawText;
  try {
    const polished = await window.desktop.polishNote({
      videoTitle: videoDetails.value?.title || "",
      targetText: rawText,
      beforeText: entries[targetIndex - 1]?.text || "",
      afterText: entries[targetIndex + 1]?.text || "",
    });
    text = polished.text || rawText;
  } catch {}
  await window.desktop.addNote({
    videoId: `${payload.bvid}@p${payload.page || 1}`,
    timestamp: payload.seconds,
    text,
    videoTitle: videoDetails.value?.title || "",
    channelName: videoDetails.value?.channelName || "",
  });
  toast.value = "📝 笔记已保存";
  setTimeout(() => (toast.value = ""), 2000);
  await refresh();
}

onMounted(() => {
  offShortcut = window.desktop.onNoteShortcut(handleShortcut);
  refresh();
});
onUnmounted(() => offShortcut?.());

watch(
  () => currentVideo.value && [currentVideo.value.bvid, currentVideo.value.page],
  () => refresh(),
);
watch(showAll, () => refresh());

async function remove(id) {
  await window.desktop.deleteNote(id);
  await refresh();
}

function stamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function seek(note) {
  // Notes reference the video they were taken on; seeking only makes sense
  // while that video is open in the browser view.
  if (currentVideo.value && `${currentVideo.value.bvid}@p${currentVideo.value.page}` === note.videoId) {
    window.desktop.seekVideo(note.timestamp);
  }
}
</script>

<template>
  <div v-if="toast" class="note-toast">{{ toast }}</div>

  <div class="notes-filter">
    <button class="mode-btn" :class="{ active: !showAll }" @click="showAll = false">当前视频</button>
    <button class="mode-btn" :class="{ active: showAll }" @click="showAll = true">全部</button>
  </div>

  <div v-if="!notes.length" class="placeholder">
    还没有笔记。在右侧视频播放时按 <b>n</b> 键，即可把当前时间点的内容存为笔记。
  </div>

  <div v-for="note in notes" :key="note.id" class="note-item">
    <div class="note-head">
      <button class="note-time" @click="seek(note)">{{ stamp(note.timestamp) }}</button>
      <span class="note-video" :title="note.videoTitle">{{ note.videoTitle }}</span>
      <button class="note-del" @click="remove(note.id)">删除</button>
    </div>
    <div class="note-text">{{ note.text }}</div>
  </div>
</template>

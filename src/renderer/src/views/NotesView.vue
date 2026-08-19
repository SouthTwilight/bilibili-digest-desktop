<script setup>
import { ref, watch, onMounted } from "vue";
import { currentVideo } from "../store.js";
import { takeNoteAt, videoNoteContext } from "../notes-service.js";

const notes = ref([]);
const showAll = ref(false);
const toast = ref("");
const saving = ref(false);

async function refresh() {
  if (showAll.value) {
    notes.value = await window.desktop.listNotes("all");
  } else if (currentVideo.value) {
    notes.value = await window.desktop.listNotesFor(await videoNoteContext());
  } else {
    notes.value = [];
  }
}

onMounted(refresh);
watch(
  () => currentVideo.value && [currentVideo.value.bvid, currentVideo.value.page],
  () => refresh(),
);
watch(showAll, () => refresh());

async function takeNoteNow() {
  saving.value = true;
  try {
    const time = await window.desktop.getCurrentTime();
    const result = await takeNoteAt(time.seconds);
    if (result.ok) {
      toast.value = "📝 笔记已保存";
      await refresh();
    } else {
      toast.value = `⚠️ ${result.reason}`;
    }
  } finally {
    saving.value = false;
    setTimeout(() => (toast.value = ""), 2000);
  }
}

async function exportNotes() {
  if (!currentVideo.value || !notes.value.length) return;
  saving.value = true;
  try {
    const context = await videoNoteContext();
    const result = await window.desktop.exportNotes(context);
    toast.value = result.success ? "📄 笔记已整理，见「导出库」" : `⚠️ ${result.error}`;
  } finally {
    saving.value = false;
    setTimeout(() => (toast.value = ""), 2600);
  }
}

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
    <button class="btn ghost small" :disabled="saving || !notes.length" @click="exportNotes" style="margin-left: auto">整理笔记</button>
    <button class="btn small" :disabled="saving || !currentVideo" @click="takeNoteNow">
      {{ saving ? "记录中…" : "记下当前时刻" }}
    </button>
  </div>

  <div v-if="!notes.length" class="placeholder">
    还没有笔记。视频播放时点上方「记下当前时刻」即可记录：<br />
    笔记 = 当前时刻字幕（AI 润色成句）+ 播放画面截图，保存在默认保存目录的「视频名_BV号」文件夹；点「整理笔记」可汇总为 MD 文档（含图片），导出库中可见。
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

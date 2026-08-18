<script setup>
import { ref, watch } from "vue";
import { currentVideo, transcript, progress } from "../store.js";

const loading = ref(false);
const error = ref("");

watch(
  () => currentVideo.value && [currentVideo.value.bvid, currentVideo.value.page],
  async () => {
    if (!currentVideo.value) return;
    error.value = "";
    transcript.value = null;
    loading.value = true;
    progress.visible = false;
    try {
      const result = await window.desktop.getTranscript(
        currentVideo.value.bvid,
        currentVideo.value.page,
      );
      if (!result.success) {
        error.value = result.message || result.error || "获取字幕失败";
      } else {
        transcript.value = result.transcript;
      }
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
      progress.visible = false;
    }
  },
  { immediate: true },
);

function stamp(start) {
  const m = Math.floor(start / 60);
  const s = Math.floor(start % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function seek(seconds) {
  window.desktop.seekVideo(seconds);
}
</script>

<template>
  <div v-if="!currentVideo" class="placeholder">在右侧打开一个 B 站视频后，这里会显示字幕。</div>

  <div v-else-if="loading" class="placeholder">
    <template v-if="progress.visible">
      {{ progress.title }}<span v-if="progress.subtitle"> · {{ progress.subtitle }}</span>
    </template>
    <template v-else>正在获取字幕…</template>
  </div>

  <div v-else-if="error" class="error-note">{{ error }}</div>

  <div v-else-if="transcript" class="transcript">
    <div class="transcript-meta">
      来源：{{ transcript.source === "bilibili-subtitle" ? "B站字幕" : transcript.source }} ·
      {{ transcript.transcript.length }} 条
    </div>
    <div
      v-for="(entry, i) in transcript.transcript"
      :key="i"
      class="transcript-line"
      @click="seek(entry.start)"
    >
      <span class="transcript-time">{{ stamp(entry.start) }}</span>
      <span>{{ entry.text }}</span>
    </div>
  </div>
</template>

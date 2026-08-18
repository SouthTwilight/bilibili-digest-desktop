<script setup>
import { ref, watch, computed } from "vue";
import { currentVideo, transcript, progress } from "../store.js";

const loading = ref(false);
const error = ref("");
const switching = ref(false);
const asrConfigured = ref(false);

const sourceLabel = computed(() => {
  const source = transcript.value?.source;
  if (source === "bilibili-subtitle") return "B站字幕";
  if (source === "aliyun-fun-asr") return "百炼语音识别";
  if (source === "doubao-bigasr") return "豆包语音识别";
  return source || "";
});

const isSubtitleSource = computed(() => transcript.value?.source === "bilibili-subtitle");

async function load(mode = "auto") {
  if (!currentVideo.value) return;
  error.value = "";
  transcript.value = null;
  loading.value = true;
  progress.visible = false;
  try {
    const result = await window.desktop.getTranscript(
      currentVideo.value.bvid,
      currentVideo.value.page,
      mode,
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
    switching.value = false;
    progress.visible = false;
  }
}

watch(
  () => currentVideo.value && [currentVideo.value.bvid, currentVideo.value.page],
  async () => {
    if (!currentVideo.value) return;
    asrConfigured.value = false;
    try {
      const settings = await window.desktop.getSettings();
      asrConfigured.value =
        (settings.asrProvider === "doubao" && !!settings.asrApiKeys.doubao) ||
        (!!settings.asrApiKeys.bailian && settings.asrProvider === "bailian") ||
        !!settings.asrApiKeys.bailian;
    } catch {}
    await load("auto");
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

  <div v-else-if="error" class="error-note">
    {{ error }}
    <button
      v-if="asrConfigured && error.includes('没有 B 站字幕')"
      class="btn"
      style="margin-top: 10px"
      @click="switching = true; load('asr')"
    >改用语音识别</button>
  </div>

  <div v-else-if="transcript" class="transcript">
    <div class="transcript-meta">
      来源：{{ sourceLabel }} · {{ transcript.transcript.length }} 条
      <button
        v-if="isSubtitleSource && asrConfigured"
        class="btn ghost small"
        :disabled="switching"
        title="B站字幕质量不佳时，改用语音识别重新转写（消耗ASR额度）"
        @click="switching = true; load('asr')"
      >{{ switching ? "转写中…" : "改用语音识别" }}</button>
      <button
        v-else-if="!isSubtitleSource"
        class="btn ghost small"
        :disabled="switching"
        title="切回B站字幕（免费）"
        @click="switching = true; load('subtitle')"
      >{{ switching ? "切换中…" : "改用B站字幕" }}</button>
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

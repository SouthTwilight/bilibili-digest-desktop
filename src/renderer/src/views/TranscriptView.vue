<script setup>
import { ref, watch, computed, nextTick } from "vue";
import { currentVideo, videoDetails, transcript, progress } from "../store.js";

const loading = ref(false);
const error = ref("");
const switching = ref(false);
const asrConfigured = ref(false);

// --- translation modes -----------------------------------------------------
const mode = ref("original"); // original | zh | bilingual
const translations = ref({}); // segmentId -> Chinese text
const translating = ref(false);
const translateProgress = ref("");

const CJK = /[\u3400-\u9fff]/;
const originalIsChinese = computed(() => {
  const entries = transcript.value?.transcript || [];
  if (!entries.length) return false;
  const cjk = entries.filter((entry) => CJK.test(entry.text)).length;
  return cjk / entries.length > 0.3;
});

// Group entries into paragraph segments of up to 4 lines — the unit the
// batch translator accepts and the bilingual view renders.
const SEGMENT_SIZE = 4;
const segments = computed(() => {
  const entries = transcript.value?.transcript || [];
  const groups = [];
  for (let i = 0; i < entries.length; i += SEGMENT_SIZE) {
    const chunk = entries.slice(i, i + SEGMENT_SIZE);
    groups.push({
      id: `s${groups.length}`,
      start: chunk[0].start,
      text: chunk.map((entry) => entry.text).join(" "),
      entries: chunk,
    });
  }
  return groups;
});

async function ensureTranslated() {
  if (!currentVideo.value || !videoDetails.value) return;
  const pending = segments.value.filter((segment) => !translations.value[segment.id]);
  if (!pending.length) return;
  translating.value = true;
  try {
    let done = 0;
    for (let i = 0; i < pending.length; i += 4) {
      const batch = pending.slice(i, i + 4);
      let result = null;
      try {
        result = await window.desktop.translateBatch(
          videoDetails.value.title,
          batch.map((segment) => ({ id: segment.id, text: segment.text })),
        );
      } catch {
        result = { success: false };
      }
      if (result.success) {
        for (const segment of result.translatedContent.segments) {
          if (segment.text) translations.value[segment.id] = segment.text;
        }
      }
      done += batch.length;
      translateProgress.value = `翻译中 ${done}/${pending.length} 段`;
    }
    await window.desktop.saveTranslations(
      currentVideo.value.bvid,
      currentVideo.value.page,
      { ...translations.value },
    ).catch(() => {});
  } finally {
    translating.value = false;
    translateProgress.value = "";
  }
}

function switchMode(next) {
  if (mode.value === next) return;
  mode.value = next;
  if (next !== "original" && !originalIsChinese.value) {
    void ensureTranslated();
  }
}

// --- transcript loading ----------------------------------------------------
async function load(loadMode = "auto") {
  if (!currentVideo.value) return;
  error.value = "";
  transcript.value = null;
  translations.value = {};
  mode.value = "original";
  loading.value = true;
  progress.visible = false;
  try {
    const result = await window.desktop.getTranscript(
      currentVideo.value.bvid,
      currentVideo.value.page,
      loadMode,
    );
    if (!result.success) {
      error.value = result.message || result.error || "获取字幕失败";
    } else {
      transcript.value = result.transcript;
      if (result.translations) translations.value = result.translations;
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
        !!settings.asrApiKeys.bailian;
    } catch {}
    await load("auto");
  },
  { immediate: true },
);

// --- selection explain -----------------------------------------------------
const explainState = ref({ visible: false, loading: false, text: "", error: "" });

async function explainSelectionText(selectedText) {
  explainState.value = { visible: true, loading: true, text: "", error: "" };
  try {
    const entries = transcript.value?.transcript || [];
    const index = entries.findIndex((entry) => entry.text.includes(selectedText.slice(0, 20)));
    const context = entries
      .slice(Math.max(0, index - 4), Math.max(0, index - 4) + 9)
      .map((entry) => entry.text)
      .join("\n");
    const result = await window.desktop.explain({
      videoTitle: videoDetails.value?.title || "",
      selectedText,
      transcriptContext: context || "None",
    });
    if (result.success) explainState.value.text = result.explanation;
    else explainState.value.error = result.error || "解释失败";
  } catch (e) {
    explainState.value.error = e.message;
  } finally {
    explainState.value.loading = false;
  }
}

const explainBtn = ref({ visible: false, x: 0, y: 0, text: "" });
let selectionTimer = null;

function onTranscriptMouseup(event) {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(async () => {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (text && text.length >= 2 && event.currentTarget.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0).getBoundingClientRect();
      explainBtn.value = { visible: true, x: range.left, y: range.top - 34, text };
    } else {
      explainBtn.value.visible = false;
    }
  }, 150);
}

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

  <div v-else-if="transcript" class="transcript" @mouseup="onTranscriptMouseup">
    <div class="transcript-meta">
      来源：{{ transcript.source === "bilibili-subtitle" ? "B站字幕" : transcript.source === "aliyun-fun-asr" ? "百炼语音识别" : "豆包语音识别" }} ·
      {{ transcript.transcript.length }} 条
      <button
        v-if="transcript.source === 'bilibili-subtitle' && asrConfigured"
        class="btn ghost small"
        :disabled="switching"
        @click="switching = true; load('asr')"
      >{{ switching ? "转写中…" : "改用语音识别" }}</button>
      <button
        v-else-if="transcript.source !== 'bilibili-subtitle'"
        class="btn ghost small"
        :disabled="switching"
        @click="switching = true; load('subtitle')"
      >{{ switching ? "切换中…" : "改用B站字幕" }}</button>
    </div>

    <div v-if="!originalIsChinese" class="mode-row">
      <button class="mode-btn" :class="{ active: mode === 'original' }" @click="switchMode('original')">原文</button>
      <button class="mode-btn" :class="{ active: mode === 'zh' }" @click="switchMode('zh')">中文</button>
      <button class="mode-btn" :class="{ active: mode === 'bilingual' }" @click="switchMode('bilingual')">双语</button>
      <span v-if="translating || translateProgress" class="translating-hint">{{ translateProgress || "准备翻译…" }}</span>
    </div>

    <!-- original mode: per-line, clickable timestamps -->
    <template v-if="mode === 'original'">
      <div v-for="(entry, i) in transcript.transcript" :key="i" class="transcript-line" @click="seek(entry.start)">
        <span class="transcript-time">{{ stamp(entry.start) }}</span>
        <span>{{ entry.text }}</span>
      </div>
    </template>

    <!-- zh / bilingual modes: paragraph segments -->
    <template v-else>
      <div v-for="segment in segments" :key="segment.id" class="transcript-seg" @click="seek(segment.start)">
        <span class="transcript-time">{{ stamp(segment.start) }}</span>
        <div>
          <div v-if="mode === 'bilingual'" class="seg-original">{{ segment.text }}</div>
          <div class="seg-zh" :class="{ missing: !translations[segment.id] }">
            {{ translations[segment.id] || (translating ? "…" : "（未翻译）") }}
          </div>
        </div>
      </div>
    </template>

    <button
      v-if="explainBtn.visible"
      class="explain-fab"
      :style="{ left: explainBtn.x + 'px', top: explainBtn.y + 'px' }"
      @mousedown.prevent
      @click="explainSelectionText(explainBtn.text)"
    >解释</button>
  </div>

  <div v-if="explainState.visible" class="explain-overlay" @click.self="explainState.visible = false">
    <div class="explain-dialog">
      <div class="explain-title">解释</div>
      <div v-if="explainState.loading" class="placeholder">正在结合视频上下文解释…</div>
      <div v-else-if="explainState.error" class="error-note">{{ explainState.error }}</div>
      <div v-else class="explain-body">{{ explainState.text }}</div>
      <button class="btn ghost" @click="explainState.visible = false">关闭</button>
    </div>
  </div>
</template>

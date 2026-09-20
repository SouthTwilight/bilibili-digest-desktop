<script setup>
import { ref, watch, computed, nextTick, onUnmounted } from "vue";
import { currentVideo, videoDetails, transcript, progress, showAppNotice } from "../store.js";

const loading = ref(false);
const error = ref("");
const switching = ref(false);
const asrConfigured = ref(false);

// --- export ----------------------------------------------------------------
const exportFormat = ref("md");
const collectionInfo = ref(null);
const collectionModal = ref(null); // { collectionTitle, videos, error }
const exporting = ref(false);

async function refreshCollectionInfo() {
  collectionInfo.value = null;
  if (!currentVideo.value) return;
  try {
    const info = await window.desktop.getCollectionInfo(currentVideo.value.bvid);
    collectionInfo.value = info?.inCollection ? info : null;
  } catch {}
}

async function exportSingleNow() {
  if (!currentVideo.value || exporting.value) return;
  exporting.value = true;
  // Feedback fires immediately — the collection probe inside the IPC handler
  // can take seconds and must not leave the click feeling dead.
  showAppNotice({ kind: "export", ok: true, title: "已加入任务队列：单视频导出" });
  try {
    // Export what the user is actually looking at: the displayed transcript's
    // source picks the queue item's source mode, and the current track
    // (native CC vs AI) rides along.
    const source = transcript.value?.source === "bilibili-subtitle" ? "subtitle" : "asr";
    const result = await window.desktop.exportSingle(currentVideo.value.bvid, currentVideo.value.page, exportFormat.value, source, lastLoadTrack);
    if (result && result.success === false) {
      showAppNotice({ ok: false, title: `导出失败：${result.error || "未知错误"}` });
      return;
    }
    error.value = "";
  } catch (e) {
    showAppNotice({ ok: false, title: `导出失败：${e.message || "未知错误"}` });
  } finally {
    exporting.value = false;
  }
}

// Multi-P videos export as ONE whole-video document (one section per part)
// instead of per-part files — the part sections and ?p= jump links are built
// by the export renderer in the main process.
async function exportAllPagesNow() {
  if (!currentVideo.value || exporting.value) return;
  exporting.value = true;
  showAppNotice({ kind: "export", ok: true, title: "已加入任务队列：全部P合并导出" });
  try {
    const source = transcript.value?.source === "bilibili-subtitle" ? "subtitle" : "asr";
    const result = await window.desktop.exportSingle(currentVideo.value.bvid, currentVideo.value.page, exportFormat.value, source, lastLoadTrack, true);
    if (result && result.success === false) {
      showAppNotice({ ok: false, title: `导出失败：${result.error || "未知错误"}` });
      return;
    }
    error.value = "";
  } catch (e) {
    showAppNotice({ ok: false, title: `导出失败：${e.message || "未知错误"}` });
  } finally {
    exporting.value = false;
  }
}

async function openCollectionExport() {
  if (!currentVideo.value || exporting.value) return;
  collectionModal.value = { collectionTitle: "", videos: [], error: "", loading: true };
  const result = await window.desktop.exportCollectionPreview(currentVideo.value.bvid);
  // The modal may have been closed while the list was loading.
  if (!collectionModal.value) return;
  collectionModal.value.loading = false;
  if (!result.success) {
    collectionModal.value.error = result.error;
    return;
  }
  collectionModal.value.collectionTitle = result.collectionTitle;
  collectionModal.value.videos = result.videos.map((video) => ({
    ...video,
    selected: true,
    source: "subtitle",
  }));
}

const allSelected = computed(() => {
  const videos = collectionModal.value?.videos;
  return !!videos?.length && videos.every((video) => video.selected);
});

function toggleSelectAll() {
  const next = !allSelected.value;
  collectionModal.value.videos.forEach((video) => (video.selected = next));
}

function batchSetSource(source) {
  collectionModal.value.videos.forEach((video) => {
    if (video.selected) video.source = source;
  });
}

async function confirmCollectionExport() {
  const modal = collectionModal.value;
  if (!modal || modal.loading || exporting.value) return;
  const items = modal.videos
    .filter((video) => video.selected)
    .map((video) => ({
      bvid: video.bvid,
      title: video.title,
      videoTitle: video.title,
      page: video.page || 1,
      sourceMode: video.source || "subtitle",
      useAsr: (video.source || "subtitle") === "asr",
      format: exportFormat.value,
    }));
  if (!items.length) return;
  exporting.value = true;
  try {
    const result = await window.desktop.exportCollectionConfirm(modal.collectionTitle, exportFormat.value, items);
    collectionModal.value = null;
    if (result && result.success === false) {
      showAppNotice({ ok: false, title: `合集导出失败：${result.error || "未知错误"}` });
      return;
    }
    showAppNotice({ kind: "export", ok: true, title: `已加入任务队列：合集导出（${items.length} 个视频）` });
  } catch (e) {
    collectionModal.value = null;
    showAppNotice({ ok: false, title: `合集导出失败：${e.message || "未知错误"}` });
  } finally {
    exporting.value = false;
  }
}
// App-level modals render in the window page, which the browser view covers;
// hide the view while either modal (collection export / explanation) is open.
watch(
  () => !!collectionModal.value || explainState.value.visible,
  (open) => window.desktop.setViewVisible(!open),
);
onUnmounted(() => window.desktop.setViewVisible(true));

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
    // Only ASR translations are persisted — subtitle content is fetched
    // fresh every time and regenerates server-side, so cached segment
    // translations would no longer align.
    if (!isSubtitleSource.value) {
      await window.desktop.saveTranslations(
        currentVideo.value.bvid,
        currentVideo.value.page,
        { ...translations.value },
        "asr",
      ).catch(() => {});
    }
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
// lastTrack remembers the AI/native choice so retries repeat it.
let lastLoadMode = "auto";
let lastLoadTrack = "ai";

async function load(loadMode = "auto", track = null) {
  if (!currentVideo.value) return;
  const track_ = track || lastLoadTrack;
  error.value = "";
  transcript.value = null;
  translations.value = {};
  mode.value = "original";
  loading.value = true;
  progress.visible = false;
  lastLoadMode = loadMode;
  lastLoadTrack = track_;
  try {
    const result = await window.desktop.getTranscript(
      currentVideo.value.bvid,
      currentVideo.value.page,
      loadMode,
      track_,
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

function retryLoad() {
  if (loading.value) return;
  void load(lastLoadMode, lastLoadTrack);
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
    refreshCollectionInfo();
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
      v-if="asrConfigured && lastLoadMode !== 'asr'"
      class="btn"
      style="margin-top: 10px"
      @click="switching = true; load('asr')"
    >语音识别字幕</button>
  </div>

  <div v-else-if="transcript" class="transcript" @mouseup="onTranscriptMouseup">
    <div class="transcript-meta">
      来源：{{ transcript.source === "bilibili-subtitle" ? (transcript.language === 'ai-zh' ? 'B站字幕·AI' : 'B站字幕·原生') : transcript.source === "aliyun-fun-asr" ? "百炼语音识别" : "豆包语音识别" }} ·
      {{ transcript.transcript.length }} 条
      <template v-if="transcript.source === 'bilibili-subtitle'">
        <button class="mode-btn tiny" :class="{ active: transcript.language !== 'ai-zh' }" :disabled="switching" @click="switching = true; load('subtitle', 'cc')">原生字幕</button>
        <button class="mode-btn tiny" :class="{ active: transcript.language === 'ai-zh' }" :disabled="switching" @click="switching = true; load('subtitle', 'ai')">AI字幕</button>
        <button
          v-if="asrConfigured"
          class="btn ghost small"
          :disabled="switching"
          @click="switching = true; load('asr')"
        >{{ switching ? "转写中…" : "语音识别字幕" }}</button>
      </template>
      <button
        v-else
        class="btn ghost small"
        :disabled="switching"
        @click="switching = true; load('subtitle')"
      >{{ switching ? "切换中…" : "改用B站字幕" }}</button>
    </div>

    <div class="mode-row">
      <button class="mode-btn" :class="{ active: mode === 'original' }" @click="switchMode('original')">原文</button>
      <button class="mode-btn" :class="{ active: mode === 'zh' }" @click="switchMode('zh')">中文</button>
      <button class="mode-btn" :class="{ active: mode === 'bilingual' }" @click="switchMode('bilingual')">双语</button>
      <span v-if="translating || translateProgress" class="translating-hint">{{ translateProgress || "准备翻译…" }}</span>
    </div>

    <div class="export-row">
      <select v-model="exportFormat" class="export-format-select">
        <option value="md">Markdown</option>
        <option value="html">HTML 网页</option>
      </select>
      <button class="btn ghost small" :disabled="exporting" @click="exportSingleNow">导出当前字幕</button>
      <button
        v-if="(videoDetails?.pageCount || 1) > 1"
        class="btn ghost small"
        title="所有分P合并为一份文档，每个P一个章节"
        :disabled="exporting"
        @click="exportAllPagesNow"
      >导出全部P</button>
      <button v-if="collectionInfo" class="btn small" :disabled="exporting" @click="openCollectionExport">导出合集</button>
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

  <div v-if="collectionModal" class="explain-overlay" @click.self="collectionModal = null">
    <div class="explain-dialog" style="max-width: 480px">
      <div class="explain-title">导出合集</div>
      <template v-if="collectionModal.error">
        <div class="error-note">{{ collectionModal.error }}</div>
      </template>
      <template v-else>
        <div class="collection-export-status">
          <template v-if="collectionModal.loading">正在获取合集视频列表，请稍候…</template>
          <template v-else>《{{ collectionModal.collectionTitle }}》共 {{ collectionModal.videos.length }} 个视频。
          默认使用 B站字幕；也可逐个或批量改为 ASR。B站字幕获取失败的任务可在任务页改用 ASR 重试。</template>
        </div>
        <div class="collection-export-toolbar">
          <label class="collection-export-select-all">
            <input type="checkbox" :checked="allSelected" @change="toggleSelectAll" />
            全选
          </label>
          <button class="btn ghost small" :disabled="!collectionModal.videos.some(v => v.selected)" @click="batchSetSource('subtitle')">批量设为 B站字幕</button>
          <button class="btn ghost small" :disabled="!collectionModal.videos.some(v => v.selected)" @click="batchSetSource('asr')">批量设为 ASR</button>
        </div>
        <div class="collection-export-list">
          <label v-for="video in collectionModal.videos" :key="video.bvid" class="collection-export-row">
            <input type="checkbox" v-model="video.selected" />
            <span class="collection-export-row-title">{{ video.title }}</span>
            <select v-model="video.source" :disabled="!video.selected" class="collection-export-source-select">
              <option value="subtitle">B站字幕</option>
              <option value="asr">ASR</option>
            </select>
          </label>
        </div>
        <div style="display: flex; gap: 8px; justify-content: flex-end">
          <button class="btn ghost" @click="collectionModal = null">取消</button>
          <button class="btn" :disabled="collectionModal.loading || exporting || !collectionModal.videos.some(v => v.selected)" @click="confirmCollectionExport">
            开始导出（{{ collectionModal.videos.filter(v => v.selected).length }} 个）</button>
        </div>
      </template>
    </div>
  </div>
</template>

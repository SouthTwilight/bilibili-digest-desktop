<script setup>
import { ref, watch, computed, nextTick, onMounted, onUnmounted } from "vue";
import { currentVideo, videoDetails, transcript, progress, showAppNotice } from "../store.js";
import CollectionExportDialog from "./CollectionExportDialog.vue";

const loading = ref(false);
const error = ref("");
const switching = ref(false);
const asrConfigured = ref(false);

// --- queued transcription ("语音识别字幕") -------------------------------
// ASR runs as a queue task (serial lane, visible on the tasks page), so the
// panel tracks the task and reads the transcript back from the paid cache
// when it finishes. Leaving the page/video does NOT cancel the task.
const pendingTask = ref(null); // { id, bvid, page }
const transcribeDetail = ref("");

function applyTaskUpdate(task) {
  if (!pendingTask.value || task?.id !== pendingTask.value.id) return;
  if (currentVideo.value?.bvid !== pendingTask.value.bvid || currentVideo.value?.page !== pendingTask.value.page) {
    return; // 用户已切走：任务继续跑，结果进缓存，回来时 auto 命中
  }
  if (task.status === "running") {
    transcribeDetail.value = task.results?.[0]?.detail || transcribeDetail.value;
    return;
  }
  const finished = pendingTask.value;
  pendingTask.value = null;
  transcribeDetail.value = "";
  if (task.status === "done" && task.results?.[0]?.status === "done") {
    void showTranscribed(finished);
  } else if (task.status === "canceled") {
    error.value = "语音识别已取消";
    loading.value = false;
    switching.value = false;
  } else {
    error.value = task.results?.[0]?.error || "语音识别失败";
    loading.value = false;
    switching.value = false;
  }
}

async function showTranscribed({ bvid, page }) {
  try {
    const result = await window.desktop.getTranscript(bvid, page, "asr", lastLoadTrack);
    if (!result.success) {
      error.value = result.message || result.error || "获取识别结果失败";
    } else {
      transcript.value = result.transcript;
      translations.value = result.translations || {};
    }
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
    switching.value = false;
  }
}

async function startTranscribe() {
  if (!currentVideo.value) return;
  error.value = "";
  transcript.value = null;
  translations.value = {};
  mode.value = "original";
  loading.value = true;
  progress.visible = false;
  lastLoadMode = "asr";
  pendingTask.value = null;
  transcribeDetail.value = "";
  try {
    const result = await window.desktop.transcribeEnqueue({
      bvid: currentVideo.value.bvid,
      page: currentVideo.value.page,
      track: lastLoadTrack,
      title: videoDetails.value?.title || "",
    });
    if (!result.success) {
      throw new Error(result.error || result.message || "语音识别入队失败");
    }
    pendingTask.value = {
      id: result.task.id,
      bvid: currentVideo.value.bvid,
      page: currentVideo.value.page,
    };
    applyTaskUpdate(result.task); // 幂等附身到已完成的任务时立即收尾
  } catch (e) {
    error.value = e.message;
    loading.value = false;
  } finally {
    switching.value = false;
  }
}

// --- export ----------------------------------------------------------------
const exportFormat = ref("md");
const collectionInfo = ref(null);
const collectionDialog = ref(null);
const exporting = ref(false);

function openCollectionExport() {
  if (!currentVideo.value || exporting.value) return;
  collectionDialog.value?.open(currentVideo.value.bvid);
}

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

// Every part is exported as its own document (视频名_Pn_时间戳.md) — the same
// treatment a collection gives each video, so each P stays readable and can
// be summarized independently.
async function exportAllPagesNow() {
  if (!currentVideo.value || exporting.value) return;
  exporting.value = true;
  showAppNotice({ kind: "export", ok: true, title: "已加入任务队列：全部P分P导出" });
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
  // ASR 不再直连：入队为 transcribe 任务（串行道 + 任务页可见），由
  // applyTaskUpdate 在任务完成后回填结果。
  if (loadMode === "asr") {
    if (track) lastLoadTrack = track;
    return startTranscribe();
  }
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

// App-level modals render in the window page, which the browser view covers;
// the collection dialog manages its own visibility, this watch only tracks
// the explanation modal.
watch(
  () => explainState.value.visible,
  (open) => window.desktop.setViewVisible(!open),
);

// 队列任务进度（transcribe）从主进程推送；切 tab 卸载组件只解绑监听，
// 任务本身在主进程继续跑。
let offTaskUpdates = () => {};
onMounted(() => {
  offTaskUpdates = window.desktop.onExportTaskUpdate(applyTaskUpdate);
});
onUnmounted(() => {
  offTaskUpdates();
  window.desktop.setViewVisible(true);
});

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
    <template v-if="pendingTask">
      语音识别任务进行中{{ transcribeDetail ? `：${transcribeDetail}` : "…" }}<br />
      进度见「任务」页，切换页面或视频不会打断
    </template>
    <template v-else-if="progress.visible">
      {{ progress.title }}<span v-if="progress.subtitle"> · {{ progress.subtitle }}</span>
    </template>
    <template v-else>正在获取字幕…</template>
  </div>

  <div v-else-if="error" class="error-note">
    {{ error }}
    <button
      v-if="asrConfigured"
      class="btn"
      style="margin-top: 10px"
      @click="switching = true; load('asr')"
    >{{ lastLoadMode === "asr" ? "重试语音识别" : "语音识别字幕" }}</button>
  </div>

  <div v-else-if="transcript" class="transcript" @mouseup="onTranscriptMouseup">
    <!-- Source/mode/export controls stay reachable while scrolling long
         transcripts — full-bleed sticky bar over the panel scroll. -->
    <div class="sticky-controls">
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
        title="每个分P导出为一份独立文档（视频名_Pn）"
        :disabled="exporting"
        @click="exportAllPagesNow"
      >导出全部P</button>
      <button v-if="collectionInfo" class="btn small" :disabled="exporting" @click="openCollectionExport">导出合集</button>
    </div>
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

  <CollectionExportDialog ref="collectionDialog" :export-format="exportFormat" />
</template>

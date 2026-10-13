<script setup>
// Shared collection export dialog (incremental-aware). Opened from the
// transcript page or the library's「检查更新」button; `open(bvid)` pulls the
// live Bilibili season list marked with exported/newPages (main-process
// markExported), default-selects only what is new, and enqueues new parts as
// single-P items so old parts are never re-fetched.
import { ref, computed, watch, onUnmounted } from "vue";
import { showAppNotice } from "../store.js";

const props = defineProps({ exportFormat: { type: String, default: "md" } });

const collectionModal = ref(null); // { collectionTitle, videos, error, loading }
const exporting = ref(false);

// App-level modals render in the window page, which the browser view covers.
watch(
  () => !!collectionModal.value,
  (open) => window.desktop.setViewVisible(!open),
);
onUnmounted(() => window.desktop.setViewVisible(true));

async function open(bvid) {
  if (exporting.value || !bvid) return;
  collectionModal.value = { collectionTitle: "", videos: [], error: "", loading: true };
  const result = await window.desktop.exportCollectionPreview(bvid);
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
    // New videos and new-P updates default to selected; plain exported ones off.
    selected: !video.exported || (video.newPages?.length || 0) > 0,
    source: "subtitle",
  }));
}
defineExpose({ open });

const allSelected = computed(() => {
  const videos = collectionModal.value?.videos;
  return !!videos?.length && videos.every((video) => video.selected);
});

const pendingCount = computed(() => {
  const videos = collectionModal.value?.videos || [];
  return videos.filter((v) => !v.exported || (v.newPages?.length || 0) > 0).length;
});

function close() {
  collectionModal.value = null;
}

function toggleSelectAll() {
  const next = !allSelected.value;
  collectionModal.value.videos.forEach((video) => (video.selected = next));
}

function batchSetSource(source) {
  collectionModal.value.videos.forEach((video) => {
    if (video.selected) video.source = source;
  });
}

function buildItem(video, page) {
  return {
    bvid: video.bvid,
    title: video.title,
    videoTitle: video.title,
    page,
    sourceMode: video.source || "subtitle",
    useAsr: (video.source || "subtitle") === "asr",
    format: props.exportFormat,
  };
}

async function confirmCollectionExport() {
  const modal = collectionModal.value;
  if (!modal || modal.loading || exporting.value) return;
  const items = [];
  for (const video of modal.videos.filter((v) => v.selected)) {
    const newPages = video.exported && video.newPages?.length ? video.newPages : null;
    if (newPages) {
      // Incremental: one single-P item per new part — old parts untouched.
      for (const page of newPages) items.push(buildItem(video, page));
    } else {
      items.push(buildItem(video, video.page || 1));
    }
  }
  if (!items.length) return;
  exporting.value = true;
  try {
    const result = await window.desktop.exportCollectionConfirm(modal.collectionTitle, props.exportFormat, items);
    close();
    if (result && result.success === false) {
      showAppNotice({ ok: false, title: `合集导出失败：${result.error || "未知错误"}` });
      return;
    }
    showAppNotice({ kind: "export", ok: true, title: `已加入任务队列：合集增量导出（${items.length} 项）` });
  } catch (e) {
    close();
    showAppNotice({ ok: false, title: `合集导出失败：${e.message || "未知错误"}` });
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <div v-if="collectionModal" class="explain-overlay" @click.self="close">
    <div class="explain-dialog" style="max-width: 480px">
      <div class="explain-title">导出合集</div>
      <template v-if="collectionModal.error">
        <div class="error-note">{{ collectionModal.error }}</div>
      </template>
      <template v-else>
        <div class="collection-export-status">
          <template v-if="collectionModal.loading">正在获取合集视频列表，请稍候…</template>
          <template v-else>《{{ collectionModal.collectionTitle }}》共 {{ collectionModal.videos.length }} 个视频，
            其中 {{ pendingCount }} 个待更新（新视频或新分P）。
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
            <span v-if="(video.newPages?.length || 0) > 0" class="coll-badge newp">有新P +{{ video.newPages.length }}</span>
            <span v-else-if="video.exported" class="coll-badge exported">已导出</span>
            <select v-model="video.source" :disabled="!video.selected" class="collection-export-source-select">
              <option value="subtitle">B站字幕</option>
              <option value="asr">ASR</option>
            </select>
          </label>
        </div>
        <div style="display: flex; gap: 8px; justify-content: flex-end">
          <button class="btn ghost" @click="close">取消</button>
          <button class="btn" :disabled="collectionModal.loading || exporting || !collectionModal.videos.some(v => v.selected)" @click="confirmCollectionExport">
            开始导出（{{ collectionModal.videos.filter(v => v.selected).length }} 项）</button>
        </div>
      </template>
    </div>
  </div>
</template>

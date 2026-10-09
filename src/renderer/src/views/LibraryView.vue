<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import { showAppNotice } from "../store.js";

const tree = ref([]);
const preview = ref(null); // { kind, name, content }
const loading = ref(true);

async function refresh() {
  loading.value = true;
  tree.value = await window.desktop.libraryList();
  loading.value = false;
}

const off = [];
onMounted(() => {
  refresh();
  // New AI总结 files should appear in the tree the moment a summary task
  // settles — without this the user has to hit 刷新 manually.
  off.push(
    window.desktop.onExportTaskUpdate((task) => {
      if (task.type === "summary" && (task.status === "done" || task.status === "canceled")) {
        refresh();
      }
    }),
  );
});
onUnmounted(() => off.forEach((fn) => fn()));

function toggle(node) {
  node.open = !node.open;
  tree.value = [...tree.value];
}

async function openFile(file) {
  // Picture folders open in Explorer directly — no in-app preview.
  if (file.kind === "picture-dir") {
    window.desktop.libraryReveal(file.path);
    return;
  }
  const result = await window.desktop.libraryRead(file.path);
  if (result.success) {
    preview.value = { kind: result.kind, name: result.name, content: result.content, path: file.path };
  } else {
    preview.value = { kind: "error", name: file.name, content: result.error, path: file.path };
  }
}

function reveal(path) {
  window.desktop.libraryReveal(path);
}

function openWithDefaultApp(path) {
  window.desktop.openWithDefaultApp(path);
}

// ---- single-file AI summary (queued like every summary task) --------------

const summarizing = ref(false);
const summarizeStatus = ref("");
const focusModal = ref(false);
const focusText = ref("");

function flashStatus(text, ms = 2000) {
  summarizeStatus.value = text;
  setTimeout(() => (summarizeStatus.value = ""), ms);
}

function anyModalOpen() {
  return !!(focusModal.value || batchModal.value || packModal.value);
}

async function openSummarizeDialog() {
  if (summarizing.value || !preview.value || anyModalOpen()) return;
  // Only markdown documents make sense to summarize.
  if (preview.value.kind !== "md" && !preview.value.name.endsWith(".md")) {
    flashStatus("仅支持 Markdown 文件");
    return;
  }
  try {
    const settings = await window.desktop.getSettings();
    focusText.value = settings.lastSummaryFocus || "";
  } catch {
    focusText.value = "";
  }
  // App-level modals render in the window page, which the browser view covers.
  window.desktop.setViewVisible(false);
  focusModal.value = true;
}

function closeSummarizeDialog() {
  focusModal.value = false;
  window.desktop.setViewVisible(true);
}

async function runSummarize() {
  if (summarizing.value || !preview.value) return;
  summarizing.value = true;
  try {
    const result = await window.desktop.summaryEnqueue("", [{ filePath: preview.value.path }], focusText.value);
    if (result.success) {
      showAppNotice({
        kind: "summary",
        ok: true,
        title: `已加入任务队列：AI 总结（${result.task?.results?.[0]?.title || "1 个文档"}）`,
      });
      closeSummarizeDialog();
    } else {
      flashStatus(`⚠️ ${result.error || "入队失败"}`, 3500);
    }
  } finally {
    summarizing.value = false;
  }
}

// ---- collection batch summarize -------------------------------------------

const batchModal = ref(null); // { collection, scope, videos, loading, error, focus }
const batchSubmitting = ref(false);

async function openBatchSummarize(node) {
  if (anyModalOpen()) return;
  window.desktop.setViewVisible(false);
  // Collections batch over their video folders; a standalone multi-P video
  // batches over its per-P export files — same capability either way.
  const scope = node.type === "video" ? "video" : "collection";
  batchModal.value = { collection: node, scope, videos: [], loading: true, error: "", focus: "" };
  try {
    const settings = await window.desktop.getSettings();
    batchModal.value.focus = settings.lastSummaryFocus || "";
  } catch {}
  const result = await window.desktop.summaryBatchPreview(node.path);
  // Guard against the modal having been closed while scanning.
  if (!batchModal.value) return;
  batchModal.value.loading = false;
  if (!result.success) {
    batchModal.value.error = result.error || "读取文件夹失败";
    return;
  }
  // Default: summarize everything not yet summarized — re-running the ones
  // that already have an AI总结 is a deliberate opt-in (re-check the row).
  batchModal.value.videos = result.videos.map((video) => ({
    ...video,
    selected: !!video.file && !video.hasSummary,
  }));
}

function closeBatchModal() {
  batchModal.value = null;
  window.desktop.setViewVisible(true);
}

const batchPicked = computed(() =>
  (batchModal.value?.videos || []).filter((video) => video.selected && video.file),
);
const batchAllChecked = computed(() => {
  const eligible = (batchModal.value?.videos || []).filter((video) => video.file);
  return eligible.length > 0 && eligible.every((video) => video.selected);
});

function toggleBatchAll() {
  const target = !batchAllChecked.value;
  batchModal.value.videos.forEach((video) => {
    if (video.file) video.selected = target;
  });
}

async function confirmBatchSummarize() {
  const modal = batchModal.value;
  if (!modal || modal.loading || batchSubmitting.value) return;
  const picked = batchPicked.value;
  if (!picked.length) return;
  batchSubmitting.value = true;
  try {
    const result = await window.desktop.summaryEnqueue(
      modal.collection.name,
      picked.map((video) => ({ filePath: video.file, title: video.name })),
      modal.focus,
    );
    if (result.success) {
      const unit = modal.scope === "video" ? "个分P" : "个视频";
      showAppNotice({ kind: "summary", ok: true, title: `已加入任务队列：批量总结（${picked.length} ${unit}）` });
      closeBatchModal();
    } else {
      modal.error = result.error || "入队失败";
    }
  } finally {
    batchSubmitting.value = false;
  }
}

// ---- AI summary packaging (zip export) ------------------------------------

const packModal = ref(null); // { collection, videos, loading, error }
const packSubmitting = ref(false);

async function openPackDialog(node) {
  if (anyModalOpen()) return;
  window.desktop.setViewVisible(false);
  packModal.value = { collection: node, videos: [], loading: true, error: "" };
  const result = await window.desktop.summaryBatchPreview(node.path);
  if (!packModal.value) return;
  packModal.value.loading = false;
  if (!result.success) {
    packModal.value.error = result.error || "读取合集失败";
    return;
  }
  packModal.value.videos = result.videos
    .filter((video) => video.hasSummary)
    .map((video) => ({ ...video, selected: true }));
}

function closePackModal() {
  packModal.value = null;
  window.desktop.setViewVisible(true);
}

async function confirmPack() {
  const modal = packModal.value;
  if (!modal || modal.loading || packSubmitting.value) return;
  const picked = modal.videos.filter((video) => video.selected);
  if (!picked.length) return;
  packSubmitting.value = true;
  try {
    const result = await window.desktop.summaryPack(
      modal.collection.name,
      picked.map((video) => video.dir),
    );
    if (result.success) {
      showAppNotice({
        kind: "summary",
        ok: true,
        title: `AI 总结打包完成（${result.videos} 个视频，${result.files} 个文件）`,
        file: result.file,
      });
      closePackModal();
    } else {
      modal.error = result.error || "打包失败";
    }
  } finally {
    packSubmitting.value = false;
  }
}

// Standalone / in-collection video row: pack just that one video's summaries.
async function packVideo(node) {
  if (anyModalOpen()) return;
  const result = await window.desktop.summaryPack("", [node.path]);
  showAppNotice(
    result.success
      ? { kind: "summary", ok: true, title: `AI 总结打包完成（${result.files} 个文件）`, file: result.file }
      : { kind: "summary", ok: false, title: `打包失败：${result.error || "未知错误"}` },
  );
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function kindIcon(kind) {
  return kind === "md" ? "📄" : kind === "html" ? "🌐" : kind === "notes" ? "📝" : kind === "picture-dir" ? "🖼️" : "📁";
}

// Minimal Markdown rendering for preview: headings, bold, quotes, list items
// and links-as-text. Kept intentionally tiny — full fidelity is what the
// exported .md/.html files themselves are for.
function renderMarkdown(text) {
  const escape = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return String(text || "")
    .split(/\n/)
    .map((line) => {
      const safe = escape(line);
      const bold = safe.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
      if (/^### /.test(line)) return `<h4>${bold.slice(4)}</h4>`;
      if (/^## /.test(line)) return `<h3>${bold.slice(3)}</h3>`;
      if (/^# /.test(line)) return `<h2>${bold.slice(2)}</h2>`;
      if (/^> /.test(line)) return `<blockquote>${bold.slice(2)}</blockquote>`;
      if (/^- /.test(line)) return `<div class="md-li">${bold.slice(2)}</div>`;
      if (/^---+$/.test(line)) return "<hr>";
      if (!line.trim()) return "<div class='md-gap'></div>";
      return `<p>${bold}</p>`;
    })
    .join("");
}

function prettyNotes(content) {
  try {
    const data = JSON.parse(content);
    return (data.notes || [])
      .map(
        (note) =>
          `[${Math.floor(note.timestamp / 60)}:${String(note.timestamp % 60).padStart(2, "0")}] ${note.text}`,
      )
      .join("\n") || "（空）";
  } catch {
    return content;
  }
}
</script>

<template>
  <div class="library-layout">
    <div class="library-tree">
      <div class="library-toolbar">
        <span class="section-title" style="margin: 0">导出库</span>
        <button class="btn ghost small" @click="refresh">刷新</button>
      </div>
      <div v-if="loading" class="placeholder">正在扫描保存目录…</div>
      <div v-else-if="!tree.length" class="placeholder">
        保存目录还是空的。导出字幕或记笔记后，这里会按「合集 → 视频」展示所有文件。
      </div>
      <template v-else>
        <div v-for="node in tree" :key="node.path" class="lib-node">
          <div v-if="node.type === 'collection'" class="lib-row coll" @click="toggle(node)">
            <span class="lib-caret">{{ node.open ? "▾" : "▸" }}</span>
            <span class="lib-name">📂 {{ node.name }}</span>
            <span class="lib-actions">
              <button class="lib-action-btn" title="对整个合集生成 AI 总结（入任务队列）" @click.stop="openBatchSummarize(node)">AI总结</button>
              <button class="lib-action-btn" title="把合集内的 AI 总结打包为 zip 迁移" @click.stop="openPackDialog(node)">打包</button>
            </span>
          </div>
          <template v-if="node.type === 'collection' && node.open">
            <div v-for="child in node.children" :key="child.path" class="lib-sub">
              <div v-if="child.type === 'video'" class="lib-row video" @click="toggle(child)">
                <span class="lib-caret">{{ child.open ? "▾" : "▸" }}</span>
                <span class="lib-name">🎬 {{ child.name }}</span>
                <span class="lib-actions">
                  <button class="lib-action-btn" title="把这个视频的 AI 总结打包为 zip" @click.stop="packVideo(child)">打包</button>
                </span>
              </div>
              <template v-if="child.type === 'video' && child.open">
                <div
                  v-for="file in child.children"
                  :key="file.path"
                  class="lib-row file"
                  :class="{ active: preview?.path === file.path }"
                  @click="openFile(file)"
                >
                  <span class="lib-caret"></span>
                  <span>{{ kindIcon(file.kind) }} {{ file.name }} <i class="lib-size">{{ fmtSize(file.size) }}</i></span>
                </div>
              </template>
              <div
                v-else-if="child.type === 'file'"
                class="lib-row file"
                :class="{ active: preview?.path === child.path }"
                @click="openFile(child)"
              >
                <span class="lib-caret"></span>
                <span>{{ kindIcon(child.kind) }} {{ child.name }}</span>
              </div>
            </div>
          </template>
          <template v-else-if="node.type === 'video'">
            <div class="lib-row video" @click="toggle(node)">
              <span class="lib-caret">{{ node.open ? "▾" : "▸" }}</span>
              <span class="lib-name">🎬 {{ node.name }}</span>
              <span class="lib-actions">
                <button class="lib-action-btn" title="对该视频的所有分P/导出文档批量生成 AI 总结" @click.stop="openBatchSummarize(node)">AI总结</button>
                <button class="lib-action-btn" title="把这个视频的 AI 总结打包为 zip" @click.stop="packVideo(node)">打包</button>
              </span>
            </div>
            <template v-if="node.open">
              <div
                v-for="file in node.children"
                :key="file.path"
                class="lib-row file lib-sub"
                :class="{ active: preview?.path === file.path }"
                @click="openFile(file)"
              >
                <span class="lib-caret"></span>
                <span>{{ kindIcon(file.kind) }} {{ file.name }} <i class="lib-size">{{ fmtSize(file.size) }}</i></span>
              </div>
            </template>
          </template>
        </div>
      </template>
    </div>

    <div class="library-preview" v-if="preview">
      <div class="preview-head">
        <span>{{ preview.name }}</span>
        <span v-if="summarizeStatus" class="summarize-status">{{ summarizeStatus }}</span>
        <button class="btn ghost small" @click="openSummarizeDialog" :disabled="summarizing">AI总结</button>
        <button class="btn ghost small" @click="openWithDefaultApp(preview.path)">默认应用</button>
        <button class="btn ghost small" @click="reveal(preview.path)">资源管理器</button>
        <button class="btn ghost small" @click="preview = null">关闭</button>
      </div>
      <div v-if="preview.kind === 'html'" class="preview-body">
        <iframe :srcdoc="preview.content" sandbox=""></iframe>
      </div>
      <div v-else-if="preview.kind === 'md'" class="preview-body md" v-html="renderMarkdown(preview.content)"></div>
      <pre v-else-if="preview.kind === 'notes'" class="preview-body plain">{{ prettyNotes(preview.content) }}</pre>
      <pre v-else class="preview-body plain">{{ preview.content }}</pre>
    </div>

    <div v-if="focusModal" class="explain-overlay" @click.self="closeSummarizeDialog">
      <div class="focus-dialog">
        <h3>总结关注方向（可选）</h3>
        <textarea
          v-model="focusText"
          class="focus-input"
          rows="3"
          maxlength="500"
          placeholder="如：列出视频中提到的电影和配乐；提取分步骤操作清单；只提取术语和定义"
          @keydown.esc.stop.prevent="closeSummarizeDialog"
          @keydown.ctrl.enter.prevent="runSummarize"
          @keydown.meta.enter.prevent="runSummarize"
        ></textarea>
        <p class="focus-hint">留空使用通用模板；总结的固定结构与格式不受影响。</p>
        <div class="focus-actions">
          <button class="btn ghost small" @click="closeSummarizeDialog">取消</button>
          <button class="btn small" :disabled="summarizing" @click="runSummarize">加入任务队列</button>
        </div>
      </div>
    </div>

    <div v-if="batchModal" class="explain-overlay" @click.self="closeBatchModal">
      <div class="focus-dialog batch-dialog">
        <h3>总结{{ batchModal.scope === "video" ? "视频分P" : "合集" }}：{{ batchModal.collection.name }}</h3>
        <div v-if="batchModal.loading" class="placeholder">正在读取合集视频…</div>
        <p v-else-if="batchModal.error" class="batch-error">{{ batchModal.error }}</p>
        <template v-else>
          <div class="batch-toolbar">
            <label class="batch-check">
              <input type="checkbox" :checked="batchAllChecked" @change="toggleBatchAll" />
              全选有字幕文档的条目
            </label>
            <span class="batch-hint">已总结的默认跳过，重新勾选将覆盖</span>
          </div>
          <div class="batch-list">
            <label
              v-for="video in batchModal.videos"
              :key="video.dir"
              class="batch-item"
              :class="{ disabled: !video.file }"
            >
              <input type="checkbox" v-model="video.selected" :disabled="!video.file" />
              <span class="batch-item-name" :title="video.name">{{ video.name }}</span>
              <span v-if="!video.file" class="batch-badge">无字幕文档</span>
              <span v-else-if="video.hasSummary" class="batch-badge done">已有总结</span>
            </label>
            <div v-if="!batchModal.videos.length" class="placeholder">这里没有可总结的 Markdown 文档。</div>
          </div>
          <textarea
            v-model="batchModal.focus"
            class="focus-input"
            rows="2"
            maxlength="500"
            placeholder="总结关注方向（可选）：如「列出提到的工具与配置步骤」"
            @keydown.ctrl.enter.prevent="confirmBatchSummarize"
            @keydown.meta.enter.prevent="confirmBatchSummarize"
          ></textarea>
          <p class="focus-hint">逐个视频生成 AI 总结并保存在原视频文件夹，任务进度见「任务」页。</p>
        </template>
        <div class="focus-actions">
          <button class="btn ghost small" @click="closeBatchModal">取消</button>
          <button
            class="btn small"
            :disabled="batchModal.loading || batchSubmitting || !batchPicked.length"
            @click="confirmBatchSummarize"
          >开始总结（{{ batchPicked.length }}）</button>
        </div>
      </div>
    </div>

    <div v-if="packModal" class="explain-overlay" @click.self="closePackModal">
      <div class="focus-dialog batch-dialog">
        <h3>打包 AI 总结：{{ packModal.collection.name }}</h3>
        <div v-if="packModal.loading" class="placeholder">正在读取合集视频…</div>
        <p v-else-if="packModal.error" class="batch-error">{{ packModal.error }}</p>
        <template v-else>
          <div v-if="!packModal.videos.length" class="placeholder">这个合集还没有任何 AI 总结文件。</div>
          <div v-else class="batch-list">
            <label v-for="video in packModal.videos" :key="video.dir" class="batch-item">
              <input type="checkbox" v-model="video.selected" />
              <span class="batch-item-name" :title="video.name">{{ video.name }}</span>
            </label>
          </div>
          <p class="focus-hint">打包为 zip（保留「合集 → 视频」目录结构并附 manifest 清单），保存在导出目录根下，可拷贝到其他设备完成迁移。</p>
        </template>
        <div class="focus-actions">
          <button class="btn ghost small" @click="closePackModal">取消</button>
          <button
            class="btn small"
            :disabled="packModal.loading || packSubmitting || !packModal.videos.some((v) => v.selected)"
            @click="confirmPack"
          >打包导出</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lib-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lib-actions {
  margin-left: auto;
  display: inline-flex;
  gap: 4px;
  flex: none;
}
.lib-action-btn {
  border: 1px solid var(--line);
  background: var(--surface-soft, #fafafa);
  color: var(--muted);
  border-radius: 6px;
  font-size: 11px;
  line-height: 1;
  padding: 4px 7px;
  cursor: pointer;
}
.lib-action-btn:hover {
  border-color: var(--pink);
  color: var(--pink);
}
.batch-dialog {
  width: min(560px, 94vw);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.batch-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
  font-size: 12.5px;
}
.batch-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: var(--ink);
}
.batch-hint {
  color: var(--muted);
  font-size: 12px;
  text-align: right;
}
.batch-list {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-soft, #fafafa);
  max-height: 300px;
  overflow-y: auto;
  margin-bottom: 10px;
  flex: none;
}
.batch-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 13px;
  cursor: pointer;
  border-bottom: 1px solid var(--line);
  color: var(--ink);
}
.batch-item:last-child {
  border-bottom: none;
}
.batch-item.disabled {
  opacity: 0.55;
  cursor: default;
}
.batch-item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.batch-badge {
  flex: none;
  font-size: 11px;
  border-radius: 6px;
  padding: 1px 6px;
  border: 1px solid var(--line);
  color: var(--muted);
}
.batch-badge.done {
  color: #2ecc71;
  border-color: rgba(46, 204, 113, 0.4);
}
.batch-error {
  color: #e74c3c;
  font-size: 13px;
  margin: 6px 0;
}
.focus-dialog {
  width: min(480px, 92vw);
  background: var(--surface);
  border-radius: var(--radius);
  padding: 18px 20px;
  box-shadow: 0 12px 40px rgba(24, 25, 28, 0.25);
}
.focus-dialog h3 {
  margin: 0 0 10px;
  font-size: 15px;
  color: var(--ink);
}
.focus-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
  resize: vertical;
  color: var(--ink);
  background: var(--surface-soft);
}
.focus-input:focus {
  outline: 2px solid var(--blue);
  border-color: transparent;
}
.focus-hint {
  margin: 8px 0 14px;
  font-size: 12px;
  color: var(--muted);
}
.focus-actions {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
}
</style>

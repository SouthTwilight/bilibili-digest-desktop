<script>
// Module scope on purpose: the library view is unmounted whenever the user
// switches tabs — "查看" on the queued-compression toast opens the tasks
// page — and a per-instance Set would drop the checks on the way back.
const checkedFolders = new Set();
</script>

<script setup>
import { ref, computed, watch, toRaw, onMounted, onUnmounted } from "vue";
import { showAppNotice } from "../store.js";
import CollectionExportDialog from "./CollectionExportDialog.vue";
import { buildLibraryRows, paginate, fileIdentity, renderMarkdown, prettyNotes } from "../library-view-model.js";

// The library is a paged table, one row per top-level folder. A row is
// checked for the two batch actions (AI 总结 / 压缩) and clicked to show its
// files; a file is clicked to read it. The three views replace each other in
// the same panel instead of stacking — a 400px sidebar has no room for a
// tree, a preview and four buttons per row side by side.

const PAGE_SIZES = [20, 50, 100];
// A transcript export runs to tens of thousands of lines; rendering every
// line made the sidebar crawl, so long documents show their first stretch
// here and point at the default app for the rest.
const PREVIEW_LINE_CAP = 1500;

// ---- list: one row per top-level folder ----
const rows = ref([]);
const loading = ref(true);
const pageSize = ref(20);
const page = ref(1);
const selected = ref(checkedFolders); // folder paths; kept across pages and tab switches
const updateBadges = ref(new Map()); // folder name → { newCount, newPCount }
const checkingUpdates = ref(false);
const saveDir = ref("");
const collectionDialog = ref(null);

const paged = computed(() => paginate(rows.value.length, page.value, pageSize.value));
const pageRows = computed(() => rows.value.slice(paged.value.start, paged.value.end));
const pageAllChecked = computed(
  () => pageRows.value.length > 0 && pageRows.value.every((row) => selected.value.has(row.path)),
);
const pageSomeChecked = computed(() => pageRows.value.some((row) => selected.value.has(row.path)));
const selectedRows = computed(() => rows.value.filter((row) => selected.value.has(row.path)));
watch(pageSize, () => {
  page.value = 1;
});

// ---- detail: the files inside one folder ----
const detail = ref(null); // { row }
const detailPageSize = ref(20);
const detailPage = ref(1);
watch(detailPageSize, () => {
  detailPage.value = 1;
});
const detailPaged = computed(() => paginate(detail.value?.row.files.length || 0, detailPage.value, detailPageSize.value));
const detailRows = computed(() => (detail.value?.row.files || []).slice(detailPaged.value.start, detailPaged.value.end));

// ---- preview: one file, read in place of the table ----
const preview = ref(null); // { kind, name, content, path, size }
const previewTruncated = computed(
  () => preview.value?.kind === "md" && preview.value.content.split("\n").length > PREVIEW_LINE_CAP,
);
const previewHtml = computed(() => {
  if (preview.value?.kind !== "md") return "";
  return renderMarkdown(preview.value.content.split("\n").slice(0, PREVIEW_LINE_CAP).join("\n"));
});

const off = [];
onMounted(() => {
  refresh();
  window.desktop
    .getSettings()
    .then((settings) => {
      saveDir.value = settings.saveDir || "";
    })
    .catch(() => {});
  // A settled export changes both the folders and what is new on Bilibili; a
  // settled summary task only adds files. Compression adds nothing the
  // library lists — its archives land next to the folders, not inside them.
  off.push(
    window.desktop.onExportTaskUpdate((task) => {
      if (task.status !== "done" && task.status !== "canceled") return;
      if (task.type === "compress") return;
      if (task.type === "summary") loadTree();
      else refresh();
    }),
  );
  window.addEventListener("keydown", onKeydown);
});
onUnmounted(() => {
  off.forEach((fn) => fn());
  window.removeEventListener("keydown", onKeydown);
});

async function loadTree() {
  try {
    rows.value = buildLibraryRows(await window.desktop.libraryList());
  } catch (error) {
    showAppNotice({ ok: false, title: `读取导出库失败：${error.message || error}` });
    return;
  } finally {
    loading.value = false;
  }
  // Checks and the open views only ever point at folders that still exist.
  const alive = new Map(rows.value.map((row) => [row.path, row]));
  for (const key of [...selected.value]) if (!alive.has(key)) selected.value.delete(key);
  if (detail.value) detail.value = alive.get(detail.value.row.path) ? { row: alive.get(detail.value.row.path) } : null;
  // A summary that landed while its document is open should show up.
  const shown = detail.value?.row.files.find((item) => item.file.path === preview.value?.path)?.file;
  if (preview.value && shown && shown.size !== preview.value.size) openFile(shown);
}

// One button does both jobs: rescan the folders, and check them against
// Bilibili. The check is one request per collection, so it runs in the
// background and never blocks the rescan.
let updateCheckInFlight = false;
async function checkUpdates() {
  if (updateCheckInFlight) return;
  updateCheckInFlight = true;
  checkingUpdates.value = true;
  try {
    const result = await window.desktop.collectionCheckUpdates();
    if (result?.success) {
      updateBadges.value = new Map((result.updates || []).map((update) => [update.dir, update]));
    }
  } catch {
    // Badges are a convenience; a failed check stays silent.
  } finally {
    updateCheckInFlight = false;
    checkingUpdates.value = false;
  }
}

async function refresh() {
  await Promise.all([loadTree(), checkUpdates()]);
}

function updateText(row) {
  const badge = updateBadges.value.get(row.name);
  if (!badge) return "";
  const parts = [];
  if (badge.newCount) parts.push(`${badge.newCount} 个新视频`);
  if (badge.newPCount) parts.push(`${badge.newPCount} 个有新P`);
  return parts.join("，");
}

// Any exported video's BV resolves its season, so the library needs no
// collection registry to offer an update check.
function checkCollectionUpdate(row) {
  const bvid = (row.node.children || []).find((child) => child.type === "video")?.name?.match(/(BV[A-Za-z0-9]+)$/)?.[1];
  if (!bvid) {
    showAppNotice({ ok: false, title: "该文件夹下没有视频目录，无法定位合集。" });
    return;
  }
  collectionDialog.value?.open(bvid);
}

// ---- selection ----
function toggleRow(row) {
  if (selected.value.has(row.path)) selected.value.delete(row.path);
  else selected.value.add(row.path);
}

function togglePage() {
  const pick = !pageAllChecked.value;
  for (const row of pageRows.value) {
    if (pick) selected.value.add(row.path);
    else selected.value.delete(row.path);
  }
}

// ---- folders and files ----
function openDetail(row) {
  detail.value = { row };
  detailPage.value = 1;
}

async function openFile(file) {
  // The picture folder opens in Explorer directly — no in-app preview.
  if (file.kind === "picture-dir") {
    window.desktop.libraryReveal(file.path);
    return;
  }
  let result;
  try {
    result = await window.desktop.libraryRead(file.path);
  } catch (error) {
    result = { success: false, error: error.message || String(error) };
  }
  preview.value = result.success
    ? { kind: result.kind, name: result.name, content: result.content, path: file.path, size: file.size }
    : { kind: "error", name: file.name, content: result.error, path: file.path };
}

function openDir(path) {
  window.desktop.openDir(path);
}

function reveal(path) {
  window.desktop.libraryReveal(path);
}

function openWithDefaultApp(path) {
  window.desktop.openWithDefaultApp(path);
}

// The title IS the "open the library folder" button.
async function openSaveDir() {
  const dir = saveDir.value || (await window.desktop.getSettings().catch(() => ({}))).saveDir;
  if (dir) openDir(dir);
}

// Named on purpose: a template expression hands over a ref's VALUE, so
// passing the ref from the template would clear a copy.
function closeSummaryDialog() {
  summaryDialog.value = null;
  window.desktop.setViewVisible(true);
}

function onKeydown(event) {
  if (event.key !== "Escape") return;
  if (summaryDialog.value && !summaryDialog.value.busy) return closeSummaryDialog();
  if (focusModal.value) return closeSummarizeDialog();
  if (preview.value) preview.value = null;
  else if (detail.value) detail.value = null;
}

// ---- AI summary of the checked folders ----
const summaryDialog = ref(null); // { folders, items, focus, busy, error }

async function openSummaryDialog() {
  const picked = selectedRows.value;
  if (!picked.length) return;
  let scans;
  try {
    scans = await Promise.all(picked.map((row) => window.desktop.summaryBatchPreview(row.path)));
  } catch (error) {
    showAppNotice({ ok: false, title: `读取勾选项失败：${error.message || error}` });
    return;
  }
  // Already-summarized documents are skipped: re-running them is a paid call.
  const items = scans.flatMap((scan) =>
    scan.success ? scan.videos.filter((video) => video.file && !video.hasSummary).map((video) => ({ filePath: video.file, title: video.name })) : [],
  );
  if (!items.length) {
    showAppNotice({ ok: false, title: `勾选的 ${picked.length} 项里没有需要总结的文档（都已总结，或没有字幕文档）。` });
    return;
  }
  let focus = "";
  try {
    focus = (await window.desktop.getSettings()).lastSummaryFocus || "";
  } catch {}
  // App-level modals render in the window page, which the browser view covers.
  window.desktop.setViewVisible(false);
  summaryDialog.value = { folders: picked.length, items, focus, busy: false, error: "" };
}

async function confirmSummary() {
  const dialog = summaryDialog.value;
  if (!dialog || dialog.busy) return;
  dialog.busy = true;
  dialog.error = "";
  try {
    // Across the IPC bridge only plain data can travel: a reactive proxy
    // array fails to clone and the call silently rejects.
    const items = toRaw(dialog).items.map((item) => ({ ...item }));
    const result = await window.desktop.summaryEnqueue(`勾选的 ${dialog.folders} 项`, items, dialog.focus);
    if (result.success) {
      showAppNotice({ kind: "summary", ok: true, title: `已加入任务队列：AI 总结（${dialog.items.length} 份文档）` });
      closeSummaryDialog();
    } else {
      dialog.error = result.error || "入队失败";
    }
  } finally {
    if (summaryDialog.value) summaryDialog.value.busy = false;
  }
}

// ---- AI summary of the one file being previewed ----
const summarizing = ref(false);
const summarizeStatus = ref("");
const focusModal = ref(false);
const focusText = ref("");

function flashStatus(text, ms = 2000) {
  summarizeStatus.value = text;
  setTimeout(() => (summarizeStatus.value = ""), ms);
}

async function openSummarizeDialog() {
  if (summarizing.value || !preview.value || summaryDialog.value) return;
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
      showAppNotice({ kind: "summary", ok: true, title: "已加入任务队列：AI 总结" });
      closeSummarizeDialog();
    } else {
      flashStatus(`⚠️ ${result.error || "入队失败"}`, 3500);
    }
  } finally {
    summarizing.value = false;
  }
}

// ---- compress: one zip per checked folder, run as a task ----
// Free and non-destructive, so it goes straight to the queue — no dialog.
// Progress and failures (a path Explorer could not read, an empty folder)
// show on the tasks page like any other task.
async function compressSelected() {
  const picked = selectedRows.value;
  if (!picked.length) return;
  const result = await window.desktop.libraryCompress(picked.map((row) => row.path));
  showAppNotice(
    result.success
      ? { kind: "compress", ok: true, title: `已加入任务队列：压缩（${picked.length} 个文件夹）` }
      : { ok: false, title: `⚠️ ${result.error || "入队失败"}` },
  );
}

// ---- rendering helpers ----
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function kindIcon(kind) {
  return kind === "md" ? "📄" : kind === "html" ? "🌐" : kind === "notes" ? "📝" : kind === "picture-dir" ? "🖼️" : "📁";
}
</script>

<template>
  <div class="library-view">
    <div class="library-head">
      <button
        class="lib-btn lib-title"
        :title="`导出库根目录：${saveDir || '（未选择）'}\n点击在文件管理器中打开`"
        @click="openSaveDir"
      >📂 导出库</button>
      <span v-if="checkingUpdates" class="lib-checking">正在检查更新…</span>
      <button
        class="lib-btn"
        :disabled="loading"
        title="重新扫描保存目录，并检查各合集在 B 站是否有更新"
        @click="refresh"
      >{{ loading ? "加载中…" : "刷新" }}</button>
    </div>

    <!-- list -->
    <template v-if="!preview && !detail">
      <div class="lib-actions">
        <label class="lib-check" :class="{ off: !pageRows.length }" title="勾选或取消本页的全部行">
          <input
            type="checkbox"
            :checked="pageAllChecked"
            :indeterminate="pageSomeChecked && !pageAllChecked"
            :disabled="!pageRows.length"
            @change="togglePage"
          />
          <span>{{ pageAllChecked ? "取消本页" : "全选本页" }}</span>
        </label>
        <span class="lib-selected" :title="selectedRows.map((row) => row.name).join('\n')">{{
          selectedRows.length ? `已选 ${selectedRows.length} 项` : "勾选后可批量总结、压缩"
        }}</span>
        <button
          class="lib-btn"
          :disabled="!selectedRows.length"
          title="对勾选项里还没有总结的文档批量生成 AI 总结"
          @click="openSummaryDialog"
        >AI总结</button>
        <button
          class="lib-btn"
          :disabled="!selectedRows.length"
          title="把每个勾选的文件夹各压缩为一个 zip（进入任务队列，进度见「任务」页）"
          @click="compressSelected"
        >压缩</button>
      </div>

      <div v-if="loading" class="lib-table lib-empty">正在扫描保存目录…</div>
      <div v-else-if="!rows.length" class="lib-table lib-empty">
        保存目录还是空的。导出字幕或记笔记后，这里会按合集列出所有内容。
      </div>
      <div v-else class="lib-table">
        <div class="lib-tr lib-th">
          <span></span>
          <span>名称</span>
          <span class="num">视频</span>
          <span class="num">文档</span>
          <span class="num">更新</span>
        </div>
        <div
          v-for="row in pageRows"
          :key="row.path"
          class="lib-tr lib-row"
          :class="{ picked: selected.has(row.path) }"
          :title="`${row.name}\n点击查看里面的文件`"
          @click="openDetail(row)"
        >
          <span @click.stop>
            <input
              type="checkbox"
              :checked="selected.has(row.path)"
              :aria-label="`选择 ${row.name}`"
              @change="toggleRow(row)"
            />
          </span>
          <span class="lib-name">{{ row.type === "collection" ? "📂" : "🎬" }} {{ row.name }}</span>
          <span class="num">{{ row.videos }}</span>
          <span class="num">{{ row.docs }}</span>
          <span class="num">
            <button
              v-if="updateText(row)"
              class="lib-badge"
              :title="`${updateText(row)}，点击增量导出`"
              @click.stop="checkCollectionUpdate(row)"
            >有更新</button>
          </span>
        </div>
      </div>

      <div v-if="rows.length" class="lib-pager">
        <button class="lib-page-btn" :disabled="paged.page <= 1" title="上一页" @click="page = paged.page - 1">‹</button>
        <span class="lib-page-info">{{ paged.page }} / {{ paged.pages }}</span>
        <button class="lib-page-btn" :disabled="paged.page >= paged.pages" title="下一页" @click="page = paged.page + 1">›</button>
        <span class="lib-pager-total">共 {{ rows.length }} 项</span>
        <select v-model.number="pageSize" class="lib-page-size" title="每页显示的行数">
          <option v-for="size in PAGE_SIZES" :key="size" :value="size">{{ size }} 项/页</option>
        </select>
      </div>
    </template>

    <!-- detail: files of one folder (a file opened from here takes over as the preview) -->
    <template v-else-if="detail && !preview">
      <div class="lib-detail-head">
        <button class="lib-btn" @click="detail = null">‹ 返回</button>
        <span class="lib-detail-title" :title="detail.row.name">{{ detail.row.name }}</span>
        <button class="lib-btn" title="在文件管理器中打开该文件夹" @click="openDir(detail.row.path)">文件夹</button>
      </div>
      <div class="lib-detail-meta">
        {{ detail.row.videos }} 个视频 · {{ detail.row.docs }} 份字幕文档 · {{ detail.row.summaries }} 份总结 · 共
        {{ detail.row.files.length }} 个文件
      </div>
      <div v-if="!detailRows.length" class="lib-table lib-empty">这个文件夹里还没有文件。</div>
      <div v-else class="lib-table">
        <div class="lib-tr lib-th lib-file-tr">
          <span>文件</span>
          <span class="num">大小</span>
        </div>
        <div
          v-for="item in detailRows"
          :key="item.file.path"
          class="lib-tr lib-file-tr"
          :title="item.file.kind === 'picture-dir' ? `${item.file.name}\n单击在资源管理器中打开` : `${item.file.name}\n单击预览`"
          @click="openFile(item.file)"
        >
          <span class="lib-fcell">
            <i class="lib-ficon">{{ kindIcon(item.file.kind) }}</i>
            <span class="lib-fname">
              <span class="lib-ftitle">{{ item.file.name }}</span>
              <small v-if="fileIdentity(item.file)">{{ fileIdentity(item.file) }}</small>
            </span>
          </span>
          <span class="num lib-fsize">{{ item.file.size ? fmtSize(item.file.size) : "" }}</span>
        </div>
      </div>
      <div class="lib-pager">
        <button class="lib-page-btn" :disabled="detailPaged.page <= 1" title="上一页" @click="detailPage = detailPaged.page - 1">‹</button>
        <span class="lib-page-info">{{ detailPaged.page }} / {{ detailPaged.pages }}</span>
        <button class="lib-page-btn" :disabled="detailPaged.page >= detailPaged.pages" title="下一页" @click="detailPage = detailPaged.page + 1">›</button>
        <span class="lib-pager-total">共 {{ detail.row.files.length }} 个文件</span>
        <select v-model.number="detailPageSize" class="lib-page-size" title="每页显示的行数">
          <option v-for="size in PAGE_SIZES" :key="size" :value="size">{{ size }} 项/页</option>
        </select>
      </div>
    </template>

    <!-- preview: one file, in place of the table -->
    <div v-else-if="preview" class="lib-preview">
      <div class="lib-preview-head">
        <button class="lib-btn" @click="preview = null">‹ 返回</button>
        <span class="lib-preview-name" :title="preview.name">{{ preview.name }}</span>
        <button v-if="preview.kind === 'md'" class="lib-btn" :disabled="summarizing" title="对这份文档生成 AI 总结" @click="openSummarizeDialog">AI总结</button>
        <button class="lib-btn" @click="openWithDefaultApp(preview.path)">默认应用</button>
        <button class="lib-btn" @click="reveal(preview.path)">资源管理器</button>
      </div>
      <div v-if="summarizeStatus" class="lib-preview-status">{{ summarizeStatus }}</div>
      <div v-if="previewTruncated" class="lib-preview-notice">
        文档较长，预览只显示前面一部分；完整内容请用「默认应用」打开。
      </div>
      <div v-if="preview.kind === 'html'" class="preview-body">
        <iframe :srcdoc="preview.content" sandbox=""></iframe>
      </div>
      <div v-else-if="preview.kind === 'md'" class="preview-body md" v-html="previewHtml"></div>
      <pre v-else-if="preview.kind === 'notes'" class="preview-body plain">{{ prettyNotes(preview.content) }}</pre>
      <pre v-else class="preview-body plain">{{ preview.content }}</pre>
    </div>

    <!-- summary direction for the file being previewed -->
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
          <button class="lib-btn" @click="closeSummarizeDialog">取消</button>
          <button class="lib-btn primary" :disabled="summarizing" @click="runSummarize">加入任务队列</button>
        </div>
      </div>
    </div>

    <!-- AI summary of the checked folders -->
    <div v-if="summaryDialog" class="explain-overlay">
      <div class="focus-dialog">
        <h3>AI 总结</h3>
        <p class="lib-dialog-lead">
          将对勾选的 <b>{{ summaryDialog.folders }}</b> 项里还没有总结的
          <b>{{ summaryDialog.items.length }}</b> 份文档生成 AI 总结。
        </p>
        <p class="focus-hint">已有总结的文档会跳过；每份文档调用一次文本模型，进度见「任务」页。</p>
        <textarea
          v-model="summaryDialog.focus"
          class="focus-input"
          rows="2"
          maxlength="500"
          placeholder="总结关注方向（可选）：如「列出提到的工具与配置步骤」"
          @keydown.ctrl.enter.prevent="confirmSummary"
          @keydown.meta.enter.prevent="confirmSummary"
        ></textarea>
        <p v-if="summaryDialog.error" class="batch-error">{{ summaryDialog.error }}</p>
        <div class="focus-actions">
          <button class="lib-btn" :disabled="summaryDialog.busy" @click="closeSummaryDialog">取消</button>
          <button class="lib-btn primary" :disabled="summaryDialog.busy" @click="confirmSummary">
            {{ summaryDialog.busy ? "提交中…" : `开始总结（${summaryDialog.items.length}）` }}
          </button>
        </div>
      </div>
    </div>

    <CollectionExportDialog ref="collectionDialog" export-format="md" />
  </div>
</template>

<style scoped>
/* Buttons live here rather than in the global .btn.small rule, which adds a
 * left margin to every button — the thing that crowded the old rows. */
.library-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.lib-btn {
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--ink);
  border-radius: 999px;
  padding: 5px 12px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: transform 0.08s ease, filter 0.08s ease, border-color 0.12s ease, color 0.12s ease, background 0.12s ease;
}
.lib-btn:hover:not(:disabled) {
  border-color: var(--pink);
  color: var(--pink-strong);
}
.lib-btn:active:not(:disabled) {
  transform: scale(0.93);
  filter: brightness(0.88);
}
.lib-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.lib-btn.primary:not(:disabled) {
  background: var(--pink);
  border-color: var(--pink);
  color: #fff;
}
.lib-btn.primary:hover:not(:disabled) {
  background: var(--pink-strong);
  color: #fff;
}

.library-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 0 10px;
  border-bottom: 1px solid var(--line);
}
.lib-title {
  font-size: 13px;
}
.lib-checking {
  flex: 1;
  text-align: right;
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.lib-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 0;
}
.lib-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.lib-check.off {
  opacity: 0.45;
  cursor: default;
}
.lib-selected {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.lib-table {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  user-select: none;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
}
.lib-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.8;
  text-align: center;
}
.lib-tr {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) 40px 40px 56px;
  align-items: center;
  gap: 4px;
  padding: 7px 8px;
  font-size: 13px;
  border-bottom: 1px solid var(--line);
}
.lib-tr:last-child {
  border-bottom: none;
}
.lib-th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 6px 8px;
  background: var(--surface);
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}
.lib-tr:not(.lib-th):hover {
  background: var(--surface-soft);
}
.lib-row,
.lib-file-tr {
  cursor: pointer;
}
.lib-tr.picked {
  background: rgba(251, 114, 153, 0.07);
}
.lib-tr input[type="checkbox"] {
  accent-color: var(--pink);
  width: 14px;
  height: 14px;
  margin: 0;
  cursor: pointer;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.lib-name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.lib-badge {
  border: none;
  background: rgba(251, 114, 153, 0.14);
  color: #fb7299;
  border-radius: 999px;
  font: inherit;
  font-size: 11px;
  line-height: 18px;
  padding: 0 8px;
  cursor: pointer;
  white-space: nowrap;
}

.lib-pager {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 10px;
  font-size: 12px;
  color: var(--muted);
}
.lib-page-btn {
  width: 26px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.lib-page-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.lib-page-info {
  min-width: 44px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.lib-pager-total {
  flex: 1;
  text-align: right;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.lib-page-size {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 3px 6px;
  font: inherit;
  font-size: 12px;
  background: var(--surface);
  color: var(--ink);
}

.lib-detail-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0 8px;
  border-bottom: 1px solid var(--line);
}
.lib-detail-title {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  font-weight: 700;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.lib-detail-meta {
  flex: none;
  padding: 8px 2px;
  font-size: 12px;
  color: var(--muted);
}
.lib-file-tr {
  grid-template-columns: minmax(0, 1fr) 64px;
}
.lib-fcell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.lib-ficon {
  flex: none;
  font-style: normal;
}
.lib-fname {
  flex: 1;
  min-width: 0;
}
.lib-ftitle {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.lib-fname small {
  display: block;
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.lib-fsize {
  font-size: 12px;
  color: #9499a0;
}

.lib-preview {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.lib-preview-head {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  padding: 6px 0 8px;
  border-bottom: 1px solid var(--line);
}
.lib-preview-head .lib-btn:first-child {
  margin-right: auto;
}
.lib-preview-name {
  flex: 1 1 120px;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.lib-preview-status {
  flex: none;
  padding-top: 6px;
  font-size: 12px;
  color: var(--muted);
}
.lib-preview-notice {
  flex: none;
  margin-top: 8px;
  padding: 6px 10px;
  font-size: 12px;
  color: #9a5b13;
  background: #fdf6ec;
  border: 1px solid #f5dcc0;
  border-radius: 8px;
}

.lib-dialog-lead {
  margin: 0 0 6px;
  font-size: 13px;
  line-height: 1.6;
}

/* ---- dialogs (shared look of the app's focus dialog) ---- */
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
  gap: 6px;
}
</style>

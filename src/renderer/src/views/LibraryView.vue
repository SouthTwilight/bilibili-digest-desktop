<script setup>
import { ref, onMounted } from "vue";

const tree = ref([]);
const preview = ref(null); // { kind, name, content }
const loading = ref(true);

async function refresh() {
  loading.value = true;
  tree.value = await window.desktop.libraryList();
  loading.value = false;
}

onMounted(refresh);

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

const summarizing = ref(false);
const summarizeStatus = ref("");
const focusModal = ref(false);
const focusText = ref("");

function flashStatus(text, ms = 2000) {
  summarizeStatus.value = text;
  setTimeout(() => (summarizeStatus.value = ""), ms);
}

async function openSummarizeDialog() {
  if (summarizing.value || !preview.value) return;
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
  closeSummarizeDialog();
  summarizing.value = true;
  summarizeStatus.value = "总结中…";
  try {
    const result = await window.desktop.summarizeDoc(preview.value.path, focusText.value);
    if (result.success) {
      summarizeStatus.value = "✓ 已生成 AI 总结";
      await refresh();
      // Auto-open the summary for immediate feedback.
      openWithDefaultApp(result.file);
    } else {
      summarizeStatus.value = `⚠️ ${result.error || "总结失败"}`;
    }
  } finally {
    summarizing.value = false;
    setTimeout(() => (summarizeStatus.value = ""), 3500);
  }
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
            <span>📂 {{ node.name }}</span>
          </div>
          <template v-if="node.type === 'collection' && node.open">
            <div v-for="child in node.children" :key="child.path" class="lib-sub">
              <div v-if="child.type === 'video'" class="lib-row video" @click="toggle(child)">
                <span class="lib-caret">{{ child.open ? "▾" : "▸" }}</span>
                <span>🎬 {{ child.name }}</span>
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
              <span>🎬 {{ node.name }}</span>
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
          <button class="btn small" :disabled="summarizing" @click="runSummarize">开始总结</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
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

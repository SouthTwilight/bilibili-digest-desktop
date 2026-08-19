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

async function summarizeDoc() {
  if (summarizing.value || !preview.value) return;
  // Only markdown documents make sense to summarize.
  if (preview.value.kind !== "md" && !preview.value.name.endsWith(".md")) {
    summarizeStatus.value = "仅支持 Markdown 文件";
    setTimeout(() => (summarizeStatus.value = ""), 2000);
    return;
  }
  summarizing.value = true;
  summarizeStatus.value = "总结中…";
  try {
    const result = await window.desktop.summarizeDoc(preview.value.path);
    if (result.success) {
      summarizeStatus.value = "✓ 已生成 AI 总结";
      await refresh();
      // Auto-open the summary for immediate feedback.
      const relative = result.file;
      openWithDefaultApp(relative);
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
  return kind === "md" ? "📄" : kind === "html" ? "🌐" : kind === "notes" ? "📝" : "📁";
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
        <button class="btn ghost small" @click="summarizeDoc" :disabled="summarizing">AI总结</button>
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
  </div>
</template>

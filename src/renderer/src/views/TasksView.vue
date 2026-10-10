<script setup>
import { ref, onMounted, onUnmounted } from "vue";

const tasks = ref([]);

async function refresh() {
  tasks.value = await window.desktop.exportTasks();
}

const off = [];
onMounted(() => {
  refresh();
  off.push(
    window.desktop.onExportTaskUpdate((task) => {
      const index = tasks.value.findIndex((t) => t.id === task.id);
      if (index === -1) tasks.value.unshift(task);
      else tasks.value[index] = task;
    }),
  );
});
onUnmounted(() => off.forEach((fn) => fn()));

function taskLabel(task) {
  if (task.type === "summary") {
    return task.collectionTitle
      ? `批量总结：${task.collectionTitle}`
      : `AI 总结：${task.results?.[0]?.title || ""}`;
  }
  if (task.type === "collection") return `合集导出：${task.collectionTitle}`;
  const title = task.results?.[0]?.title || "";
  return title ? `单视频导出：${title}` : "单视频导出";
}

// Collection tasks can carry hundreds of items — they render collapsed by
// default with a one-line digest; the user's per-task choice persists for
// the session. Small tasks stay expanded.
const COLLAPSE_OVER = 8;
const collapseChoice = ref(new Map()); // task id -> true(collapsed) / false(expanded)

function isCollapsed(task) {
  return collapseChoice.value.get(task.id) ?? task.total > COLLAPSE_OVER;
}

function toggleCollapse(task) {
  collapseChoice.value.set(task.id, !isCollapsed(task));
}

function collapsedSummary(task) {
  const parts = [];
  const running = task.results.find((r) => r.status === "running");
  if (running) parts.push(`⏳ ${running.title}${running.detail ? ` · ${running.detail}` : ""}`);
  const failed = task.results.filter((r) => r.status === "failed").length;
  if (failed) parts.push(`✗ ${failed} 个失败`);
  const done = task.results.filter((r) => r.status === "done").length;
  if (done) parts.push(`✓ ${done} 个完成`);
  const pending = task.results.filter((r) => r.status === "pending").length;
  if (pending) parts.push(`· 等待 ${pending} 个`);
  if (!parts.length && task.status === "canceled") parts.push("已取消");
  return parts.join("　");
}

function fmtTokens(n) {
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function usageText(usage) {
  if (!usage || (!usage.input && !usage.output)) return "";
  const cached = usage.cached ? `（缓存命中 ${fmtTokens(usage.cached)}）` : "";
  return `Token 消耗：入 ${fmtTokens(usage.input)}${cached} · 出 ${fmtTokens(usage.output)}`;
}

async function cancel(task) {
  await window.desktop.exportCancel(task.id);
  refresh();
}

async function retry(task, itemIndexes) {
  if (task.type === "summary") await window.desktop.summaryRetry(task.id, itemIndexes);
  else await window.desktop.retryAsr(task.id, itemIndexes);
  refresh();
}

function reveal(file) {
  window.desktop.libraryReveal(file);
}
</script>

<template>
  <div v-if="!tasks.length" class="placeholder">
    还没有任务。在字幕页点「导出」，或在导出库对合集点「AI总结」，任务会在这里排队执行——切换页面不会打断。
  </div>

  <div v-for="task in tasks" :key="task.id" class="task-card">
    <div class="task-head" @click="toggleCollapse(task)">
      <span class="task-caret" :title="isCollapsed(task) ? '展开明细' : '收起明细'">{{ isCollapsed(task) ? "▸" : "▾" }}</span>
      <b>{{ taskLabel(task) }}</b>
      <span class="task-status" :class="task.status">{{ task.status === "running" ? "进行中" : task.status === "done" ? "已完成" : "已取消" }}</span>
      <button v-if="task.status === 'running'" class="note-del" @click.stop="cancel(task)">取消</button>
      <button v-if="task.status !== 'canceled' && task.results.some(r => r.status === 'failed')" class="note-del" @click.stop="retry(task)">
        {{ task.type === "summary" ? "重试失败项" : "全部改用 ASR 重试" }}
      </button>
    </div>
    <div class="task-progress">
      <div class="task-progress-bar">
        <div class="task-progress-fill" :style="{ width: (task.done / Math.max(1, task.total)) * 100 + '%' }"></div>
      </div>
      <span class="task-progress-text">{{ task.done }}/{{ task.total }}</span>
    </div>
    <div v-if="usageText(task.usage)" class="task-usage-line">{{ usageText(task.usage) }}</div>
    <div v-if="isCollapsed(task)" class="task-collapsed-line" :title="collapsedSummary(task)">{{ collapsedSummary(task) }}</div>
    <div v-else class="task-items">
      <div v-for="(result, i) in task.results" :key="i" class="task-item" :class="result.status">
        <span class="task-item-status">{{ result.status === "done" ? "✓" : result.status === "failed" ? "✗" : result.status === "running" ? "⏳" : "·" }}</span>
        <span class="task-item-title">{{ result.title }}</span>
        <span v-if="result.status === 'running' && result.detail" class="task-item-detail">{{ result.detail }}</span>
        <span v-if="result.error" class="task-item-error" :title="result.error">{{ result.error }}</span>
        <button v-if="task.status !== 'canceled' && result.status === 'failed'" class="note-del" @click="retry(task, [i])">
          {{ task.type === "summary" ? "重试" : "改下 ASR" }}
        </button>
        <button v-if="result.file && result.status === 'done'" class="note-del" @click="reveal(result.file)">打开位置</button>
      </div>
    </div>
  </div>
</template>

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

async function cancel(task) {
  await window.desktop.exportCancel(task.id);
  refresh();
}

async function retryAsr(taskId, itemIndexes) {
  await window.desktop.retryAsr(taskId, itemIndexes);
  refresh();
}

function reveal(file) {
  window.desktop.libraryReveal(file);
}
</script>

<template>
  <div v-if="!tasks.length" class="placeholder">
    还没有导出任务。在字幕页点「导出」，或在合集视频里点「导出整个合集」，任务会在这里排队执行——切换页面不会打断。
  </div>

  <div v-for="task in tasks" :key="task.id" class="task-card">
    <div class="task-head">
      <b>{{ task.type === "collection" ? `合集导出：${task.collectionTitle}` : "单视频导出" }}</b>
      <span class="task-status" :class="task.status">{{ task.status === "running" ? "进行中" : task.status === "done" ? "已完成" : "已取消" }}</span>
      <button v-if="task.status === 'running'" class="note-del" @click="cancel(task)">取消</button>
      <button v-if="task.status !== 'canceled' && task.results.some(r => r.status === 'failed')" class="note-del" @click="retryAsr(task.id)">全部改用 ASR 重试</button>
    </div>
    <div class="task-progress">
      <div class="task-progress-bar">
        <div class="task-progress-fill" :style="{ width: (task.done / Math.max(1, task.total)) * 100 + '%' }"></div>
      </div>
      <span class="task-progress-text">{{ task.done }}/{{ task.total }}</span>
    </div>
    <div class="task-items">
      <div v-for="(result, i) in task.results" :key="i" class="task-item" :class="result.status">
        <span class="task-item-status">{{ result.status === "done" ? "✓" : result.status === "failed" ? "✗" : result.status === "running" ? "⏳" : "·" }}</span>
        <span class="task-item-title">{{ result.title }}</span>
        <span v-if="result.error" class="task-item-error" :title="result.error">{{ result.error }}</span>
        <button v-if="task.status !== 'canceled' && result.status === 'failed'" class="note-del" @click="retryAsr(task.id, [i])">改下 ASR</button>
        <button v-if="result.file && result.status === 'done'" class="note-del" @click="reveal(result.file)">打开位置</button>
      </div>
    </div>
  </div>
</template>

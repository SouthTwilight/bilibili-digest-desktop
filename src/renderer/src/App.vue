<script setup>
import { onMounted, ref } from "vue";
import SettingsView from "./views/SettingsView.vue";

const tabs = [
  { id: "overview", label: "摘要" },
  { id: "transcript", label: "字幕" },
  { id: "notes", label: "笔记" },
  { id: "library", label: "导出库" },
  { id: "tasks", label: "任务" },
  { id: "settings", label: "设置" },
];
const active = ref("settings");

onMounted(() => {
  // The main process owns the split; follow it so the sidebar column always
  // matches the browser view's left edge.
  window.desktop.onLayout(({ sidebarWidth }) => {
    document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  });
});
</script>

<template>
  <div class="sidebar">
    <div class="brand">
      <b>Bilibili Digest</b>
      <span>桌面版</span>
    </div>
    <nav class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="tab-btn"
        :class="{ active: active === tab.id }"
        @click="active = tab.id"
      >
        {{ tab.label }}
      </button>
    </nav>
    <main class="panel">
      <SettingsView v-if="active === 'settings'" />
      <div v-else class="placeholder">
        「{{ tabs.find((t) => t.id === active)?.label }}」将在后续里程碑开放。<br />
        当前里程碑（M1）：内嵌 B 站浏览、登录与设置持久化。
      </div>
    </main>
  </div>
</template>

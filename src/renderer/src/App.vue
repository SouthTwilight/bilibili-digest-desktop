<script setup>
import { onMounted, onUnmounted, ref } from "vue";
import SettingsView from "./views/SettingsView.vue";
import OverviewView from "./views/OverviewView.vue";
import TranscriptView from "./views/TranscriptView.vue";
import NotesView from "./views/NotesView.vue";
import LibraryView from "./views/LibraryView.vue";
import TasksView from "./views/TasksView.vue";
import { currentVideo, videoDetails, transcript } from "./store.js";

const tabs = [
  { id: "overview", label: "摘要" },
  { id: "transcript", label: "字幕" },
  { id: "notes", label: "笔记" },
  { id: "library", label: "导出库" },
  { id: "tasks", label: "任务" },
  { id: "settings", label: "设置" },
];
const active = ref("settings");

const nav = ref({ url: "", canGoBack: false, canGoForward: false });

const off = [];

onMounted(() => {
  off.push(window.desktop.onLayout(({ sidebarWidth }) => {
    document.documentElement.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  }));
  off.push(
    window.desktop.onVideoChanged(async (video) => {
      currentVideo.value = video;
      videoDetails.value = null;
      transcript.value = null;
      if (video) {
        videoDetails.value = await window.desktop.getVideoDetails(video.bvid);
        active.value = "transcript";
      }
    }),
  );
  off.push(window.desktop.onNavState((state) => (nav.value = state)));
});

onUnmounted(() => off.forEach((fn) => fn()));

function prettyUrl(url) {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.replace(/\/$/, "") + parsed.search).slice(0, 80);
  } catch {
    return url;
  }
}

const navBack = () => window.desktop.navGo("back");
const navForward = () => window.desktop.navGo("forward");
const navReload = () => window.desktop.navReload();
const navHome = () => window.desktop.navHome();
</script>

<template>
  <div class="app-shell">
    <div class="topbar">
      <button class="nav-btn" :disabled="!nav.canGoBack" title="后退" @click="navBack">←</button>
      <button class="nav-btn" :disabled="!nav.canGoForward" title="前进" @click="navForward">→</button>
      <button class="nav-btn" title="刷新" @click="navReload">⟳</button>
      <button class="nav-btn home" title="回到B站首页" @click="navHome">🏠</button>
      <span class="nav-url" :title="nav.url">{{ prettyUrl(nav.url) }}</span>
    </div>

    <div class="body-row">
      <div class="sidebar">
        <div class="brand">
          <b>Bilibili Digest</b>
          <span>桌面版</span>
        </div>

        <div v-if="videoDetails" class="video-head">
          <div class="video-title">{{ videoDetails.title || videoDetails.canonicalUrl }}</div>
          <div class="video-channel">UP主：{{ videoDetails.channelName || "未知" }}</div>
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
          <OverviewView v-if="active === 'overview'" />
          <TranscriptView v-else-if="active === 'transcript'" />
          <NotesView v-else-if="active === 'notes'" />
          <LibraryView v-else-if="active === 'library'" />
          <TasksView v-else-if="active === 'tasks'" />
          <SettingsView v-else-if="active === 'settings'" />
          <div v-else class="placeholder">
            「{{ tabs.find((t) => t.id === active)?.label }}」将在后续里程碑开放。
          </div>
        </main>
      </div>
    </div>
  </div>
</template>

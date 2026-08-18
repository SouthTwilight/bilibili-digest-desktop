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
const onboarding = ref({ visible: false, saveDir: "" });

const off = [];

onMounted(async () => {
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

  // First-run onboarding: pick a save directory, then log in on the right.
  const settings = await window.desktop.getSettings();
  if (!settings.onboarded) {
    onboarding.value = { visible: true, saveDir: settings.saveDir || "" };
    window.desktop.setViewVisible(false);
  }
});

async function pickOnboardingDir() {
  const dir = await window.desktop.pickSaveDir();
  if (dir) onboarding.value.saveDir = dir;
}

async function finishOnboarding() {
  const settings = await window.desktop.getSettings();
  await window.desktop.saveSettings({ ...settings, saveDir: onboarding.value.saveDir, onboarded: true });
  onboarding.value.visible = false;
  window.desktop.setViewVisible(true);
}

// Sidebar drag-resize. The sidebar column starts at x=0, so the cursor's
// clientX is the desired width; IPC is throttled during the drag.
let lastResizeSent = 0;
function streamResize(width) {
  const now = Date.now();
  if (now - lastResizeSent < 60) return;
  lastResizeSent = now;
  window.desktop.resizeSidebar(width);
}
function startResize(event) {
  event.preventDefault();
  const clamp = (x) => Math.min(820, Math.max(400, Math.round(x)));
  const onMove = (ev) => streamResize(clamp(ev.clientX));
  const onUp = (ev) => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    window.desktop.resizeSidebar(clamp(ev.clientX));
  };
  document.body.style.cursor = "col-resize";
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

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
      <div class="sidebar-resizer" title="拖动调整侧边栏宽度" @mousedown="startResize"></div>
    </div>

    <div v-if="onboarding.visible" class="onboarding-overlay">
      <div class="onboarding-card">
        <div class="onboarding-title">👋 欢迎使用 Bilibili Digest</div>
        <div class="onboarding-step">
          <div class="onboarding-step-title">① 选择导出文件的默认保存位置</div>
          <div class="onboarding-dir">
            <span class="onboarding-dir-path">{{ onboarding.saveDir || "文档\\BilibiliDigest（默认）" }}</span>
            <button class="btn ghost" @click="pickOnboardingDir">浏览…</button>
          </div>
          <p class="help">字幕导出、学习资料和笔记都会按「合集名 → 视频名_BV号」整理到这个目录。</p>
        </div>
        <div class="onboarding-step">
          <div class="onboarding-step-title">② 登录 B 站</div>
          <p class="help">点击「开始使用」后，在右侧页面扫码或密码登录 B 站——字幕、合集等能力都需要登录态。登录一次即长期保留。</p>
        </div>
        <div class="onboarding-actions">
          <button class="btn" @click="finishOnboarding">开始使用</button>
        </div>
      </div>
    </div>
  </div>
</template>

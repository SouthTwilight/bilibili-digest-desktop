<script setup>
import { ref, watch } from "vue";
import { currentVideo, videoDetails, transcript, analysis, progress } from "../store.js";

const loading = ref(false);
const error = ref("");

// Never auto-run the LLM: opening a video only resets the view; summaries are
// generated on explicit click (cached results return instantly).
watch(
  () => currentVideo.value && [currentVideo.value.bvid, currentVideo.value.page],
  () => {
    analysis.value = null;
    error.value = "";
    loading.value = false;
    progress.visible = false;
  },
);

async function generate() {
  if (!currentVideo.value) return;
  error.value = "";
  loading.value = true;
  progress.visible = false;
  try {
    const result = await window.desktop.analyzeDigest(
      currentVideo.value.bvid,
      currentVideo.value.page,
    );
    if (!result.success) error.value = result.message || result.error || "生成摘要失败";
    else analysis.value = result.analysis;
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
    progress.visible = false;
  }
}

function seek(seconds) {
  window.desktop.seekVideo(seconds);
}

window.desktop?.onDigestProgress?.((p) => {
  progress.title = p.title || "";
  progress.subtitle = p.subtitle || "";
  progress.visible = !!(p.title || p.subtitle);
});
</script>

<template>
  <div v-if="!currentVideo" class="placeholder">在右侧打开一个 B 站视频后，这里会显示 AI 总结。</div>

  <template v-else>
    <div v-if="!analysis && !loading && !error" class="placeholder">
      还没有这个视频的总结。
      <button class="btn" style="margin-top: 12px" @click="generate">生成 AI 总结</button>
    </div>

    <div v-if="progress.visible" class="progress-note">
      {{ progress.title }}
      <span v-if="progress.subtitle"> · {{ progress.subtitle }}</span>
    </div>

    <div v-if="loading && !analysis" class="placeholder">
      正在获取字幕并生成总结，长视频需要一到几分钟…
    </div>

    <div v-if="error" class="error-note">
      {{ error }}
      <button class="btn ghost" style="margin-top: 10px" @click="generate">重试</button>
    </div>

    <div v-if="analysis">
      <div class="section-title">章节时间线</div>
      <ul class="chapter-list">
        <li v-for="(chapter, i) in analysis.chapters" :key="i" class="chapter-item" @click="seek(chapter.timestampSeconds)">
          <span class="chapter-time">{{ chapter.timestamp }}</span>
          <div>
            <div class="chapter-title">{{ chapter.title }}</div>
            <p class="chapter-summary">{{ chapter.summary }}</p>
          </div>
        </li>
      </ul>

      <div class="section-title">关键观点</div>
      <div class="quotes">
        <blockquote v-for="(quote, i) in analysis.keyQuotes" :key="i" @click="seek(quote.timestampSeconds)">
          <b>{{ quote.timestamp }}</b>{{ quote.quote }}
        </blockquote>
      </div>
    </div>
  </template>
</template>

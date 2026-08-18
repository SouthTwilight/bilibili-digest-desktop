<script setup>
import { onMounted, reactive, ref } from "vue";

const settings = reactive({
  provider: "glm",
  aiApiKeys: { glm: "", deepseek: "" },
  asrProvider: "bailian",
  asrApiKeys: { bailian: "", doubao: "" },
  asrDoubaoAppKey: "",
  saveDir: "",
  exportConcurrency: 4,
});
const status = ref("");
const loading = ref(true);

onMounted(async () => {
  try {
    const stored = await window.desktop.getSettings();
    Object.assign(settings, stored);
  } finally {
    loading.value = false;
  }
});

async function pickSaveDir() {
  const dir = await window.desktop.pickSaveDir();
  if (dir) settings.saveDir = dir;
}

async function save() {
  status.value = "保存中…";
  try {
    // Vue reactive proxies cannot cross the IPC boundary; deep-clone to a
    // plain object first or the call throws DataCloneError and this promise
    // never settles.
    const plain = JSON.parse(JSON.stringify(settings));
    const saved = await window.desktop.saveSettings(plain);
    Object.assign(settings, saved);
    status.value = "已保存 ✓";
  } catch (error) {
    status.value = `保存失败：${error.message || error}`;
  }
  setTimeout(() => (status.value = ""), 2500);
}
</script>

<template>
  <div v-if="loading">加载设置中…</div>
  <form v-else @submit.prevent="save">
    <div class="field">
      <label>文本模型</label>
      <select v-model="settings.provider">
        <option value="glm">GLM 5.2</option>
        <option value="deepseek">DeepSeek Flash</option>
      </select>
      <p class="help">
        当前模型：{{ settings.provider === "glm" ? "GLM 5.2（智谱 bigmodel.cn）" : "DeepSeek Flash" }}。
        注意：智谱 Coding Plan 的 Key 不能用于本应用，请使用按量付费的常规 API Key。
      </p>
    </div>

    <div v-if="settings.provider === 'glm'" class="field">
      <label>GLM API Key</label>
      <input v-model="settings.aiApiKeys.glm" type="password" autocomplete="off" placeholder="粘贴智谱开放平台 API Key" />
    </div>
    <div v-else class="field">
      <label>DeepSeek API Key</label>
      <input v-model="settings.aiApiKeys.deepseek" type="password" autocomplete="off" placeholder="粘贴 DeepSeek API Key" />
    </div>

    <div class="field">
      <label>语音识别服务</label>
      <select v-model="settings.asrProvider">
        <option value="bailian">阿里百炼 Fun-ASR</option>
        <option value="doubao">豆包录音识别（火山引擎）</option>
      </select>
    </div>

    <div v-if="settings.asrProvider === 'bailian'" class="field">
      <label>百炼 API Key</label>
      <input v-model="settings.asrApiKeys.bailian" type="password" autocomplete="off" placeholder="sk-..." />
    </div>
    <template v-else>
      <div class="field">
        <label>豆包 Access Token</label>
        <input v-model="settings.asrApiKeys.doubao" type="password" autocomplete="off" placeholder="语音技术应用的 Access Token" />
      </div>
      <div class="field">
        <label>豆包 App ID</label>
        <input v-model="settings.asrDoubaoAppKey" type="text" autocomplete="off" placeholder="如 7882302511" />
        <p class="help">在语音技术控制台的应用详情页获取，Access Token 与 App ID 需成对填写。</p>
      </div>
    </template>

    <div class="field">
      <label>默认保存目录</label>
      <div class="dir-row">
        <input v-model="settings.saveDir" type="text" readonly placeholder="选择导出文件的默认保存位置" />
        <button class="btn ghost" type="button" @click="pickSaveDir">浏览…</button>
      </div>
      <p class="help">导出的字幕与学习资料将直接写入此目录，不再弹出保存对话框。</p>
    </div>

    <div class="field">
      <label>导出任务并发数</label>
      <select v-model.number="settings.exportConcurrency">
        <option v-for="n in [1, 2, 3, 4, 6, 8]" :key="n" :value="n">{{ n }}</option>
      </select>
      <p class="help">语音识别任务始终按服务商串行执行（豆包有并发配额限制）；此数值控制 B 站字幕类导出的并行度。</p>
    </div>

    <button class="btn" type="submit">保存设置</button>
    <span class="status">{{ status }}</span>
  </form>
</template>

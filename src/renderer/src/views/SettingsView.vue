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
const editing = ref(false);
let snapshot = null;

onMounted(async () => {
  try {
    const stored = await window.desktop.getSettings();
    Object.assign(settings, stored);
  } finally {
    loading.value = false;
  }
});

function startEditing() {
  snapshot = JSON.parse(JSON.stringify(settings));
  status.value = "";
  editing.value = true;
}

function cancelEditing() {
  if (snapshot) Object.assign(settings, JSON.parse(JSON.stringify(snapshot)));
  editing.value = false;
  status.value = "";
}

async function pickSaveDir() {
  if (!editing.value) return;
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
    editing.value = false;
    status.value = "已保存 ✓";
  } catch (error) {
    status.value = `保存失败：${error.message || error}`;
  }
  setTimeout(() => (status.value = ""), 2500);
}

function providerLabel(id) {
  return id === "glm" ? "GLM 5.2（智谱）" : id === "deepseek" ? "DeepSeek Flash" : id;
}

function asrLabel(id) {
  return id === "bailian" ? "阿里百炼 Fun-ASR" : id === "doubao" ? "豆包录音识别（火山引擎）" : id;
}

function maskKey(key) {
  if (!key) return "（未设置）";
  return key.length <= 8 ? "••••" : `${key.slice(0, 4)}••••${key.slice(-4)}`;
}
</script>

<template>
  <div v-if="loading">加载设置中…</div>

  <!-- Read-only view: protects saved values from accidental edits. -->
  <div v-else-if="!editing" class="readonly-list">
    <div class="ro-row"><span>文本模型</span><b>{{ providerLabel(settings.provider) }}</b></div>
    <div class="ro-row"><span>API Key</span><b>{{ maskKey(settings.aiApiKeys[settings.provider]) }}</b></div>
    <div class="ro-row"><span>语音识别</span><b>{{ asrLabel(settings.asrProvider) }}</b></div>
    <div class="ro-row" v-if="settings.asrProvider === 'bailian'">
      <span>百炼 Key</span><b>{{ maskKey(settings.asrApiKeys.bailian) }}</b>
    </div>
    <template v-else>
      <div class="ro-row"><span>豆包 Token</span><b>{{ maskKey(settings.asrApiKeys.doubao) }}</b></div>
      <div class="ro-row"><span>豆包 App ID</span><b>{{ settings.asrDoubaoAppKey || "（未设置）" }}</b></div>
    </template>
    <div class="ro-row"><span>默认保存目录</span><b class="ro-dir">{{ settings.saveDir || "文档/BilibiliDigest（默认）" }}</b></div>
    <div class="ro-row"><span>导出并发数</span><b>{{ settings.exportConcurrency }}</b></div>
    <p class="help" style="margin-top: 14px">字幕获取策略：优先使用 B 站字幕，无字幕视频才使用语音识别。</p>
    <button class="btn" @click="startEditing">编辑</button>
  </div>

  <form v-else @submit.prevent="save">
    <div class="field">
      <label>文本模型</label>
      <select v-model="settings.provider" :disabled="!editing">
        <option value="glm">GLM 5.2</option>
        <option value="deepseek">DeepSeek Flash</option>
      </select>
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
        <p class="help">Access Token 与 App ID 需成对填写（应用详情页获取）。注意：火山方舟的账户级 API Key 不适用。</p>
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
    <button class="btn ghost" type="button" style="margin-left: 8px" @click="cancelEditing">取消</button>
    <span class="status">{{ status }}</span>
  </form>
</template>

# 合集增量更新 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 合集导出支持增量更新——自动标记"已导出/新增/有新P"，新视频与新分P默认勾选只导增量，库视图提供「检查更新」入口与启动检测角标。

**架构：** `markExported` 比对原语放 `library.js`（目录扫描，纯本地）；分P远端数据靠 `collectionVideosFromView` 扩展返回 `pageCount`（episode.pages 原生携带，零额外请求）；启动检测实现为 LibraryView 挂载时 invoke 新 IPC `collection:check-updates`（拉取式，免主进程推送基建）；合集导出弹窗抽为 `CollectionExportDialog.vue` 供两个视图共用。

**技术栈：** Electron 主进程 ESM、`node:test`、Vue 3 `<script setup>`。本机用 Git Bash 执行命令。

**规格：** `docs/superpowers/specs/2026-10-13-collection-incremental-update-design.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/main/core/library.js` | 修改 | 新增 `exportedBvids` / `markExported`（含全库兜底与分P差集） |
| `src/main/core/bilibili.js` | 修改 | `collectionVideosFromView` 每个 video 增加 `pageCount` |
| `src/main/core/collection-update.js` | 创建 | 启动检测：遍历库内合集目录 → 判定真合集 → 汇总差集 |
| `src/main/ipc.js` | 修改 | `export:collection-preview` 接 `markExported`；新增 `collection:check-updates` |
| `src/preload/index.js` | 修改 | 暴露 `collectionCheckUpdates` |
| `src/renderer/src/views/CollectionExportDialog.vue` | 创建 | 合集导出弹窗组件（从 TranscriptView 抽出+增强：徽标/默认勾选/统计条/newP入队） |
| `src/renderer/src/views/TranscriptView.vue` | 修改 | 移除内联弹窗，改用组件 |
| `src/renderer/src/views/LibraryView.vue` | 修改 | 合集行「检查更新」按钮 + 挂载检测角标 |
| `tests/library-mark-exported.test.mjs` `tests/collection-update.test.mjs` | 创建 | 对应单测 |

---

### 任务 1：`exportedBvids` + `markExported`（library.js）

**文件：**
- 修改：`src/main/core/library.js`（文件末尾追加导出函数）
- 测试：`tests/library-mark-exported.test.mjs`

- [ ] **步骤 1：编写失败的测试**

```js
// tests/library-mark-exported.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { exportedBvids, markExported } from "../src/main/core/library.js";

function makeLibrary(root) {
  // 合集目录：两个已导出视频
  mkdirSync(join(root, "GitHub一周热点汇总", "第110期标题_BV1aaa"), { recursive: true });
  mkdirSync(join(root, "GitHub一周热点汇总", "多P视频_BV1bbb"), { recursive: true });
  writeFileSync(join(root, "GitHub一周热点汇总", "第110期标题_BV1aaa", "第110期标题_2026-09-01_10-00.md"), "# t");
  // 多P视频：P1 无标记（单P旧导出）+ P2 标记文件 → 本地 P 集合 {1,2}
  writeFileSync(join(root, "GitHub一周热点汇总", "多P视频_BV1bbb", "多P视频_2026-09-01_10-00.md"), "# t");
  writeFileSync(join(root, "GitHub一周热点汇总", "多P视频_BV1bbb", "多P视频_P2_2026-09-01_10-00.md"), "# t");
  // 全库兜底目标：其他合集里的 BV1ccc
  mkdirSync(join(root, "别的合集", "某视频_BV1ccc"), { recursive: true });
  writeFileSync(join(root, "别的合集", "某视频_BV1ccc", "某视频_2026-09-01_10-00.md"), "# t");
}

test("exportedBvids collects BV suffixes from the collection dir", () => {
  const root = join("tests", "tmp-lib-mark");
  rmSync(root, { recursive: true, force: true });
  makeLibrary(root);
  const set = exportedBvids(root, "GitHub一周热点汇总");
  assert.ok(set.has("BV1aaa"));
  assert.ok(set.has("BV1bbb"));
  assert.ok(!set.has("BV1ccc")); // 不在本合集目录
  assert.equal(exportedBvids(root, "不存在的合集") instanceof Set, true);
  rmSync(root, { recursive: true, force: true });
});

test("markExported flags exported, falls back to whole-library, and diffs new P", () => {
  const root = join("tests", "tmp-lib-mark2");
  rmSync(root, { recursive: true, force: true });
  makeLibrary(root);
  const videos = [
    { bvid: "BV1aaa", title: "第110期标题", pageCount: 1 },
    { bvid: "BV1bbb", title: "多P视频", pageCount: 4 },
    { bvid: "BV1ccc", title: "某视频", pageCount: 1 }, // 在别的合集——全库兜底应命中
    { bvid: "BV1new", title: "新视频", pageCount: 1 },
    { bvid: "BV1nopages", title: "无P数据", }, // pageCount 缺失：不检测分P
  ];
  const marked = markExported(root, "GitHub一周热点汇总", videos);
  const by = (bv) => marked.find((v) => v.bvid === bv);
  assert.equal(by("BV1aaa").exported, true);
  assert.deepEqual(by("BV1aaa").newPages, []);
  assert.equal(by("BV1bbb").exported, true);
  assert.deepEqual(by("BV1bbb").newPages, [3, 4]); // 本地 {1,2}，远端 4P
  assert.equal(by("BV1ccc").exported, true); // 兜底命中
  assert.equal(by("BV1new").exported, false);
  assert.equal(by("BV1nopages").exported, false);
  assert.deepEqual(by("BV1nopages").newPages, []); // pageCount 缺失静默跳过
  rmSync(root, { recursive: true, force: true });
});

test("a 全部P file marks the video fully covered for P diff", () => {
  const root = join("tests", "tmp-lib-mark3");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "合集", "多P视频_BV1fff"), { recursive: true });
  writeFileSync(join(root, "合集", "多P视频_BV1fff", "多P视频_全部P_2026-09-01_10-00.md"), "# t");
  const [marked] = markExported(root, "合集", [{ bvid: "BV1fff", title: "多P视频", pageCount: 9 }]);
  assert.equal(marked.exported, true);
  assert.deepEqual(marked.newPages, []);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`node --test tests/library-mark-exported.test.mjs`
预期：FAIL（函数不存在）

- [ ] **步骤 3：实现（library.js 末尾追加）**

一次全库遍历同时收集"本合集 + 全库兜底"的 BV→本地P集合（全库遍历天然覆盖本合集目录，无需分两步）：

```js
// ---- collection incremental update ---------------------------------------
// "Already exported" is decided by folder names: every video folder is
// 视频名_BV号 (videoFolderName), and BV ids survive sanitize untouched.

const BV_SUFFIX_RE = /(BV[A-Za-z0-9]+)$/;

export function exportedBvids(saveDir, collectionTitle) {
  const set = new Set();
  try {
    const dir = join(String(saveDir || "."), String(collectionTitle || ""));
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const bv = entry.name.match(BV_SUFFIX_RE)?.[1];
      if (bv) set.add(bv);
    }
  } catch {}
  return set;
}

// Annotate collection videos with exported/newPages. One whole-library walk
// builds BV → local-P-set (a `_全部P` file means fully covered); it covers
// both "in this collection" and the renamed-collection fallback for free.
// `collectionTitle` stays in the signature for call-site clarity; the walk
// is deliberately collection-agnostic.
export function markExported(saveDir, collectionTitle, videos) {
  const base = String(saveDir || ".");
  const list = Array.isArray(videos) ? videos : [];
  const localPagesByBv = new Map();
  try {
    for (const dir of readdirSync(base, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.name.startsWith(".")) continue;
      const collectionDir = join(base, dir.name);
      for (const sub of readdirSync(collectionDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const bv = sub.name.match(BV_SUFFIX_RE)?.[1];
        if (!bv || localPagesByBv.has(bv)) continue;
        const pages = new Set([1]); // a plain export file counts as P1
        let fullCover = false;
        for (const file of readdirSync(join(collectionDir, sub.name))) {
          if (file.includes("_全部P")) fullCover = true;
          const m = file.match(/_P(\d+)/);
          if (m) pages.add(Number(m[1]));
        }
        localPagesByBv.set(bv, fullCover ? "all" : pages);
      }
    }
  } catch {}
  return list.map((video) => {
    const local = localPagesByBv.get(video.bvid);
    const exported = !!local;
    let newPages = [];
    // Remote P data missing (pageCount undefined) → skip P diff silently.
    if (exported && video.pageCount > 1 && local !== "all") {
      for (let p = 1; p <= video.pageCount; p += 1) {
        if (!local.has(p)) newPages.push(p);
      }
    }
    return { ...video, exported, newPages };
  });
}
```

- [ ] **步骤 4：运行验证通过**

运行：`node --test tests/library-mark-exported.test.mjs`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/main/core/library.js tests/library-mark-exported.test.mjs
git commit -m "feat: 已导出判定原语——BV 目录标记与分P差集 markExported（任务 1/6）"
```

---

### 任务 2：`pageCount` + preview 接入

**文件：**
- 修改：`src/main/core/bilibili.js`（`collectionVideosFromView`，约 129-139 行 videos.push 处）
- 修改：`src/main/ipc.js`（`export:collection-preview` handler，约 352-364 行）
- 测试：`tests/export.test.mjs` 追加

- [ ] **步骤 1：追加失败测试（export.test.mjs）**

```js
test("markExported is wired into collection preview results", async () => {
  // library.js 的 markExported 已在任务 1 验证；此测试走 preview handler 需要
  // B 站 API，改测纯组装层：markExported 对 preview 形状 videos 的标注。
  const { markExported } = await import("../src/main/core/library.js");
  const base = new URL("./tmp-lib-mark-int/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  rmSync(base, { recursive: true, force: true });
  mkdirSync(join(base, "GitHub一周热点汇总", "老视频_BV1old"), { recursive: true });
  writeFileSync(join(base, "GitHub一周热点汇总", "老视频_BV1old", "老视频_2026-09-01_10-00.md"), "# t");
  const videos = [
    { bvid: "BV1old", title: "老视频", page: 1, pageCount: 1 },
    { bvid: "BV1fresh", title: "新视频", page: 1, pageCount: 1 },
  ];
  const marked = markExported(base, "GitHub一周热点汇总", videos);
  assert.equal(marked.find((v) => v.bvid === "BV1old").exported, true);
  assert.equal(marked.find((v) => v.bvid === "BV1fresh").exported, false);
  rmSync(base, { recursive: true, force: true });
});
```

- [ ] **步骤 2：运行验证失败→实现**

`bilibili.js` `collectionVideosFromView` 的 `videos.push({...})` 增加：

```js
        pageCount: Math.max(1, (episode.pages?.length || 0)),
```

`ipc.js` `export:collection-preview` 的 return 前接原语（顶部补 import `{ scanLibrary, readLibraryFile }` 已有 library.js import，追加 `markExported`）：

```js
      const settings = settingsStore.load();
      return {
        success: true,
        collectionTitle: collection.collectionTitle,
        videos: markExported(settings.saveDir, collection.collectionTitle, collection.videos),
      };
```

- [ ] **步骤 3：运行 `npm test` 全量回归（预期全过）并 Commit**

```bash
git add src/main/core/bilibili.js src/main/ipc.js tests/export.test.mjs
git commit -m "feat: 合集预览带已导出/新P标记——episode.pages 透出 pageCount（任务 2/6）"
```

---

### 任务 3：弹窗抽组件 CollectionExportDialog.vue（含增量增强）

**文件：**
- 创建：`src/renderer/src/views/CollectionExportDialog.vue`
- 修改：`src/renderer/src/views/TranscriptView.vue`（删除内联弹窗与相关函数，改挂组件）

- [ ] **步骤 1：创建组件**

把 TranscriptView 的 `collectionModal`/`openCollectionExport`/`allSelected`/`toggleSelectAll`/`batchSetSource`/`confirmCollectionExport` 及弹窗模板、`.collection-export-*` 样式整体迁入组件，并做增量增强：

script 关键差异（完整迁移 + 以下修改）：

```js
// CollectionExportDialog.vue <script setup>
import { ref, computed, watch } from "vue";
import { showAppNotice } from "../store.js";

const props = defineProps({ exportFormat: { type: String, default: "md" } });
const collectionModal = ref(null);
const exporting = ref(false);

async function open(bvid) {
  if (exporting.value) return;
  collectionModal.value = { collectionTitle: "", videos: [], error: "", loading: true };
  window.desktop.setViewVisible(false);
  const result = await window.desktop.exportCollectionPreview(bvid);
  if (!collectionModal.value) return;
  collectionModal.value.loading = false;
  if (!result.success) {
    collectionModal.value.error = result.error;
    return;
  }
  collectionModal.value.collectionTitle = result.collectionTitle;
  collectionModal.value.videos = result.videos.map((video) => ({
    ...video,
    // New videos and new-P updates default to selected; plain exported ones off.
    selected: !video.exported || (video.newPages?.length || 0) > 0,
    source: "subtitle",
  }));
}
defineExpose({ open });

const pendingCount = computed(() => {
  const videos = collectionModal.value?.videos || [];
  return videos.filter((v) => !v.exported || (v.newPages?.length || 0) > 0).length;
});

function close() {
  collectionModal.value = null;
  window.desktop.setViewVisible(true);
}

async function confirmCollectionExport() {
  const modal = collectionModal.value;
  if (!modal || modal.loading || exporting.value) return;
  const items = [];
  for (const video of modal.videos.filter((v) => v.selected)) {
    const newPages = video.exported && video.newPages?.length ? video.newPages : null;
    if (newPages) {
      // Incremental: one single-P item per new part — old parts untouched.
      for (const page of newPages) {
        items.push(buildItem(video, page));
      }
    } else {
      items.push(buildItem(video, video.page || 1));
    }
  }
  if (!items.length) return;
  exporting.value = true;
  try {
    const result = await window.desktop.exportCollectionConfirm(modal.collectionTitle, props.exportFormat, items);
    close();
    if (result && result.success === false) {
      showAppNotice({ ok: false, title: `合集导出失败：${result.error || "未知错误"}` });
      return;
    }
    showAppNotice({ kind: "export", ok: true, title: `已加入任务队列：合集增量导出（${items.length} 项）` });
  } catch (e) {
    close();
    showAppNotice({ ok: false, title: `合集导出失败：${e.message || "未知错误"}` });
  } finally {
    exporting.value = false;
  }
}

function buildItem(video, page) {
  return {
    bvid: video.bvid,
    title: video.title,
    videoTitle: video.title,
    page,
    sourceMode: video.source || "subtitle",
    useAsr: (video.source || "subtitle") === "asr",
    format: props.exportFormat,
  };
}
```

模板关键差异（迁入后在原结构上改两处）：

```html
<div class="collection-export-status">
  <template v-if="collectionModal.loading">正在获取合集视频列表，请稍候…</template>
  <template v-else>《{{ collectionModal.collectionTitle }}》共 {{ collectionModal.videos.length }} 个视频，
    其中 {{ pendingCount }} 个待更新（新视频或新分P）。
    默认使用 B站字幕；也可逐个或批量改为 ASR。</template>
</div>

<label v-for="video in collectionModal.videos" :key="video.bvid" class="collection-export-row">
  <input type="checkbox" v-model="video.selected" />
  <span class="collection-export-row-title">
    {{ video.title }}
    <span v-if="(video.newPages?.length || 0) > 0" class="coll-badge newp">有新P +{{ video.newPages.length }}</span>
    <span v-else-if="video.exported" class="coll-badge exported">已导出</span>
  </span>
  <select v-model="video.source" :disabled="!video.selected" class="collection-export-source-select">
    <option value="subtitle">B站字幕</option>
    <option value="asr">ASR</option>
  </select>
</label>
```

样式追加：

```css
.coll-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 18px;
  vertical-align: 1px;
}
.coll-badge.exported { background: var(--surface-soft, #eef0f3); color: var(--muted, #61666d); }
.coll-badge.newp { background: rgba(251, 114, 153, 0.14); color: #fb7299; }
```

- [ ] **步骤 2：TranscriptView 换用组件**

- 删除：`collectionModal`/`openCollectionExport`/`allSelected`/`toggleSelectAll`/`batchSetSource`/`confirmCollectionExport`、弹窗模板块、相关 watch 与样式
- 保留原触发按钮改调 `collectionDialog.value?.open(currentVideo.value.bvid)`：

```js
import CollectionExportDialog from "./CollectionExportDialog.vue";
const collectionDialog = ref(null);
```

```html
<CollectionExportDialog ref="collectionDialog" :export-format="exportFormat" />
```

- [ ] **步骤 3：验证**

运行：`node --check` 不适用 vue；跑 `npm run build`（渲染层编译通过）+ `npm test`
预期：全部通过

- [ ] **步骤 4：Commit**

```bash
git add src/renderer/src/views/CollectionExportDialog.vue src/renderer/src/views/TranscriptView.vue
git commit -m "feat: 合集导出弹窗抽组件并支持增量——已导出/新P徽标、默认勾选增量项、新P单P入队（任务 3/6）"
```

---

### 任务 4：库视图「检查更新」入口

**文件：**
- 修改：`src/renderer/src/views/LibraryView.vue`

- [ ] **步骤 1：合集行加按钮与处理函数**

script 追加：

```js
import CollectionExportDialog from "./CollectionExportDialog.vue";
const collectionDialog = ref(null);

function bvidOfVideoNode(node) {
  return node?.name?.match(/(BV[A-Za-z0-9]+)$/)?.[1] || "";
}

function checkCollectionUpdate(node) {
  const firstVideo = (node.children || []).find((c) => c.type === "video");
  const bvid = bvidOfVideoNode(firstVideo);
  if (!bvid) {
    showAppNotice({ ok: false, title: "该合集下没有视频目录，无法定位合集。" });
    return;
  }
  collectionDialog.value?.open(bvid);
}
```

模板合集行（现有 `AI总结`/`打包` 按钮旁，`lib-action-btn` 同款）：

```html
<button class="lib-action-btn" title="对比B站最新列表，增量导出新视频/新分P" @click.stop="checkCollectionUpdate(node)">检查更新</button>
```

文件根节点挂弹窗（exportFormat 默认 "md"，与库场景一致）：

```html
<CollectionExportDialog ref="collectionDialog" export-format="md" />
```

- [ ] **步骤 2：验证**

`npm run build` + `npm test` 通过；手动冒烟留任务 6 一并做。

- [ ] **步骤 3：Commit**

```bash
git add src/renderer/src/views/LibraryView.vue
git commit -m "feat: 库视图合集行「检查更新」——从库内 BV 反查合集增量（任务 4/6）"
```

---

### 任务 5：启动检测角标

**文件：**
- 创建：`src/main/core/collection-update.js`
- 修改：`src/main/ipc.js`、`src/preload/index.js`、`src/renderer/src/views/LibraryView.vue`
- 测试：`tests/collection-update.test.mjs`

- [ ] **步骤 1：失败测试**

```js
// tests/collection-update.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { detectCollectionUpdates } from "../src/main/core/collection-update.js";

test("detectCollectionUpdates reports new videos/new P and skips non-seasons", async () => {
  const root = join("tests", "tmp-coll-update");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "GitHub一周热点汇总", "老视频_BV1old"), { recursive: true });
  writeFileSync(join(root, "GitHub一周热点汇总", "老视频_BV1old", "老视频_2026-09-01_10-00.md"), "# t");
  mkdirSync(join(root, "UP主分组", "视频_BV1solo"), { recursive: true });
  writeFileSync(join(root, "UP主分组", "视频_BV1solo", "视频_2026-09-01_10-00.md"), "# t");

  const fetchView = async (bv) => {
    if (bv === "BV1old") {
      return { ugc_season: { sections: [{ episodes: [
        { bvid: "BV1old", title: "老视频", pages: Array.from({ length: 3 }, (_, i) => ({ page: i + 1 })) },
        { bvid: "BV1new", title: "新视频", pages: [{ page: 1 }] },
      ] }] } };
    }
    return { ugc_season: null }; // BV1solo → UP主分组，跳过
  };

  const updates = await detectCollectionUpdates(root, fetchView);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].collectionTitle, "GitHub一周热点汇总");
  assert.equal(updates[0].newCount, 1);
  assert.equal(updates[0].newPCount, 1); // 本地P1，远端3P
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`node --test tests/collection-update.test.mjs` 预期 FAIL（模块不存在）

- [ ] **步骤 3：实现**

```js
// src/main/core/collection-update.js
// Startup collection check: for every top-level library dir, fetch the
// Bilibili view of one exported video; only real ugc_season collections are
// compared (UP-grouped folders return no season and are skipped silently).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { collectionVideosFromView } from "./bilibili.js";
import { markExported } from "./library.js";

const BV_SUFFIX_RE = /(BV[A-Za-z0-9]+)$/;

export async function detectCollectionUpdates(saveDir, fetchView) {
  const base = String(saveDir || ".");
  let dirs = [];
  try {
    dirs = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
  const updates = [];
  for (const dir of dirs) {
    let probeBv = "";
    try {
      probeBv = readdirSync(join(base, dir), { withFileTypes: true })
        .find((e) => e.isDirectory() && BV_SUFFIX_RE.test(e.name))
        ?.name.match(BV_SUFFIX_RE)?.[1] || "";
    } catch {}
    if (!probeBv) continue;
    try {
      const view = await fetchView(probeBv);
      const collection = collectionVideosFromView(view);
      if (!collection) continue; // not a ugc_season — UP folder, out of scope
      const videos = markExported(base, collection.collectionTitle, collection.videos);
      const newCount = videos.filter((v) => !v.exported).length;
      const newPCount = videos.filter((v) => v.exported && (v.newPages?.length || 0) > 0).length;
      if (newCount || newPCount) {
        updates.push({ collectionTitle: collection.collectionTitle, dir, newCount, newPCount });
      }
    } catch {
      // One collection failing (network etc.) must not block the rest.
    }
  }
  return updates;
}
```

注意：返回的 `dir` 是库内目录名（角标匹配用），`collectionTitle` 是 B 站当前标题（弹窗显示用）。

- [ ] **步骤 4：运行验证通过后接 IPC/preload/UI**

`ipc.js`（顶部 import `detectCollectionUpdates`，`./core/bilibili.js` 已 import `fetchBilibiliView`）新增：

```js
  // Pulled by the library view on mount — the "startup check" is implemented
  // renderer-side to avoid a main→renderer push channel.
  ipcMain.handle("collection:check-updates", async () => {
    try {
      const base = settingsStore.load().saveDir;
      const updates = await detectCollectionUpdates(base, fetchBilibiliView);
      return { success: true, updates };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
```

`preload/index.js`：

```js
  collectionCheckUpdates: () => ipcRenderer.invoke("collection:check-updates"),
```

`LibraryView.vue` script 追加：

```js
const updateBadges = ref(new Map());

onMounted(async () => {
  refresh();
  try {
    const result = await window.desktop.collectionCheckUpdates();
    if (result.success) {
      updateBadges.value = new Map(result.updates.map((u) => [u.dir, u]));
    }
  } catch {}
  // failure is silent: the badge is a convenience, manual「检查更新」still works
});
```

合集行模板加角标（名称后）：

```html
<span v-if="updateBadges.get(node.name)" class="lib-update-badge">
  {{ updateBadges.get(node.name).newCount ? `${updateBadges.get(node.name).newCount} 个新视频` : "" }
  {{ updateBadges.get(node.name).newCount && updateBadges.get(node.name).newPCount ? " / " : "" }
  {{ updateBadges.get(node.name).newPCount ? `${updateBadges.get(node.name).newPCount} 个有新P` : "" }}
</span>
```

样式：

```css
.lib-update-badge {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(251, 114, 153, 0.14);
  color: #fb7299;
  font-size: 11px;
  line-height: 18px;
}
```

（角标点击即触发 `checkCollectionUpdate(node)`：把角标 span 放进按钮或在其上复用 `@click.stop="checkCollectionUpdate(node)"`。）

- [ ] **步骤 5：全量回归**

运行：`npm test`
预期：全部通过

- [ ] **步骤 6：Commit**

```bash
git add src/main/core/collection-update.js src/main/ipc.js src/preload/index.js src/renderer/src/views/LibraryView.vue tests/collection-update.test.mjs
git commit -m "feat: 库挂载时合集更新检测——新视频/新P角标，点击进入增量导出（任务 5/6）"
```

---

### 任务 6：手动冒烟（npm run dev）

- [ ] 打开 GitHub一周热点汇总 任一视频页 → 合集导出弹窗：旧视频带「已导出」徽标且默认不勾，新视频默认勾选，统计条数字正确
- [ ] 库视图 → 合集行「检查更新」→ 弹窗正常，确认入队只导增量项
- [ ] 库视图重新进入 → 合集行出现「N 个新视频 / M 个有新P」角标（若 B 站确有更新）
- [ ] 有新P的视频：确认导出后任务卡按 P 拆项、只生成新 P 的 `视频名_Pn_时间戳.md` 文件
- [ ] `npm test` 最终全量通过

---

## 自检记录

- **规格覆盖度**：已导出判定原语（任务1）、preview 标记+pageCount（任务2）、弹窗增强含 newP 单P入队（任务3）、库入口（任务4）、启动检测+角标（任务5）、冒烟（任务6）——全覆盖；规格 §5 的"renderer 拉取式实现替代主进程推送"已在任务5注明为实现选择。
- **类型一致性**：`markExported(saveDir, collectionTitle, videos)` 返回项含 `exported`/`newPages`（任务1定义，2/3/5消费一致）；`detectCollectionUpdates(saveDir, fetchView)` 返回 `{collectionTitle, dir, newCount, newPCount}`（任务5定义与测试一致）；组件 `defineExpose({ open })`（任务3定义，4消费）。
- **占位符扫描**：任务1步骤3初稿含笔误占位与双版本，已清理为单一正确实现；其余无占位符。
- **已知实现注意**：`showAppNotice` 来自全局 `store.js`（已核实）；弹窗开关需保持 `setViewVisible` 遮挡处理（组件内 close/open 均调，已含）；`pageCount` 缺失的视频不检测分P（任务1已测）。

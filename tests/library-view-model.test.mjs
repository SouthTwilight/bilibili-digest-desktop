import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLibraryRows,
  flattenFiles,
  paginate,
  fileTypeLabel,
  fileIdentity,
  renderMarkdown,
  prettyNotes,
  isTranscript,
  isSummary,
} from "../src/renderer/src/library-view-model.js";

const file = (name, kind = "md", size = 100) => ({ name, path: `/lib/${name}`, type: "file", kind, size });

// scanLibrary 的输出形状：合集 → 视频 → 文件；顶层独立视频 → 文件。
function library() {
  return [
    {
      name: "我的合集",
      path: "/lib/我的合集",
      type: "collection",
      children: [
        {
          name: "多P视频_BV3333333333",
          path: "/lib/我的合集/多P视频_BV3333333333",
          type: "video",
          children: [
            file("多P视频_2026-01-01_10-00.md"),
            file("多P视频_P2_2026-01-01_10-00.md"),
            file("AI总结_多P视频_P2.md"),
            file("notes.json", "notes", 400),
            file("picture (3 张截图)", "picture-dir", 0),
          ],
        },
        {
          name: "视频一_BV1111111111",
          path: "/lib/我的合集/视频一_BV1111111111",
          type: "video",
          children: [file("视频一_2026-01-01_10-00.md"), file("视频一_2026-02-01_10-00.md"), file("笔记_视频一_2026-01-02_09-00.md")],
        },
        file("散落在合集根目录的文档.md"),
      ],
    },
    {
      name: "独立视频_BV9999999999",
      path: "/lib/独立视频_BV9999999999",
      type: "video",
      children: [file("独立视频_2026-01-01_10-00.html", "html", 5000)],
    },
    { name: "空文件夹", path: "/lib/空文件夹", type: "collection", children: [] },
  ];
}

test("flattenFiles：合集里每个视频下的文件依次列出，合集根目录的散落文件排在后面", () => {
  const [collection, standalone] = library();
  assert.deepEqual(
    flattenFiles(collection).map((item) => item.file.name),
    [
      "多P视频_2026-01-01_10-00.md",
      "多P视频_P2_2026-01-01_10-00.md",
      "AI总结_多P视频_P2.md",
      "notes.json",
      "picture (3 张截图)",
      "视频一_2026-01-01_10-00.md",
      "视频一_2026-02-01_10-00.md",
      "笔记_视频一_2026-01-02_09-00.md",
      "散落在合集根目录的文档.md",
    ],
  );
  assert.deepEqual(flattenFiles(standalone).map((item) => item.file.name), ["独立视频_2026-01-01_10-00.html"]);
});

test("buildLibraryRows：一个顶层文件夹一行，统计视频数、字幕文档数、总结数", () => {
  const rows = buildLibraryRows(library());
  assert.deepEqual(rows.map((row) => row.name), ["我的合集", "独立视频_BV9999999999", "空文件夹"]);
  assert.deepEqual(
    rows.map((row) => [row.type, row.videos, row.docs, row.summaries, row.files.length]),
    [
      ["collection", 2, 5, 1, 9], // 字幕文档：多P 的 2 份 + 视频一的 2 份（重复导出各算一份）+ 散落的 1 份
      ["video", 1, 0, 0, 1], // 网页导出不是 Markdown，不算字幕文档
      ["collection", 0, 0, 0, 0],
    ],
  );
  assert.equal(rows[0].path, "/lib/我的合集");
  assert.equal(rows[0].node.type, "collection", "保留原节点，供增量导出取 BV 号");
});

test("buildLibraryRows：空库、坏数据都不抛错", () => {
  assert.deepEqual(buildLibraryRows([]), []);
  assert.deepEqual(buildLibraryRows(null), []);
  assert.deepEqual(buildLibraryRows([{ type: "collection" }, null, { name: "x", type: "video", path: "/p" }]).map((row) => row.name), ["x"]);
});

test("paginate：切片范围正确，列表变短时页码自动回退", () => {
  assert.deepEqual(paginate(45, 1, 20), { page: 1, pages: 3, start: 0, end: 20 });
  assert.deepEqual(paginate(45, 2, 20), { page: 2, pages: 3, start: 20, end: 40 });
  assert.deepEqual(paginate(45, 3, 20), { page: 3, pages: 3, start: 40, end: 45 });
  assert.deepEqual(paginate(45, 9, 20), { page: 3, pages: 3, start: 40, end: 45 }, "超出总页数回到最后一页");
  assert.deepEqual(paginate(45, 0, 20).page, 1, "页码从 1 起");
  assert.deepEqual(paginate(20, 2, 20), { page: 1, pages: 1, start: 0, end: 20 }, "正好一页时回到第 1 页");
  assert.deepEqual(paginate(0, 3, 20), { page: 1, pages: 0, start: 0, end: 0 }, "空列表");
  assert.deepEqual(paginate(10, 2, 50), { page: 1, pages: 1, start: 0, end: 10 });
  assert.equal(paginate(1000, 5, 0).pages, 50, "每页条数非法时回退为 20");
});

test("fileTypeLabel：总结、笔记、字幕、网页、截图各归各的", () => {
  assert.equal(fileTypeLabel(file("AI总结_视频_P2.md")), "总结");
  assert.equal(fileTypeLabel(file("笔记_视频_2026-01-01_10-00.md")), "笔记");
  assert.equal(fileTypeLabel(file("视频_P2_2026-01-01_10-00.md")), "字幕");
  assert.equal(fileTypeLabel(file("视频.html", "html")), "网页");
  assert.equal(fileTypeLabel(file("picture (3 张截图)", "picture-dir")), "截图");
  assert.equal(fileTypeLabel(file("notes.json", "notes")), "笔记数据");
  assert.equal(fileTypeLabel(file("附件.bin", "other")), "文件");
});

test("isTranscript / isSummary：只有不带前缀的 Markdown 才是字幕文档", () => {
  assert.equal(isTranscript(file("视频.md")), true);
  assert.equal(isTranscript(file("AI总结_视频.md")), false);
  assert.equal(isTranscript(file("笔记_视频.md")), false);
  assert.equal(isTranscript(file("视频.html", "html")), false);
  assert.equal(isSummary(file("AI总结_视频.md")), true);
  assert.equal(isSummary(file("视频.md")), false);
});

test("fileIdentity：用一行短文字说明文件的身份（类型 · 分P · 导出时间）", () => {
  // 这次事故里的形态：同一个视频的文件标题段完全相同，区别只在末尾。
  const head = "【全748集】目前B站最全最细的AI Agent开发零基础教程，2026最新版，包含所有";
  assert.equal(fileIdentity(file(`${head}_P75_2026-11-23_21-47.md`)), "字幕 · P75 · 2026-11-23 21:47");
  assert.equal(fileIdentity(file(`AI总结_${head}_P75.md`)), "AI总结 · P75");
  assert.equal(fileIdentity(file(`${head}_2026-11-23_21-47.md`)), "字幕 · 2026-11-23 21:47", "P1 不带分P标记");
  assert.equal(fileIdentity(file("AI总结_视频一.md")), "AI总结");
  assert.equal(fileIdentity(file("笔记_视频一_2026-01-02_09-00.md")), "笔记 · 2026-01-02 09:00");
  assert.equal(fileIdentity(file("视频_2026-01-01_10-00.html", "html")), "网页 · 2026-01-01 10:00");
  // 名字本身已经说明一切的，不重复。
  assert.equal(fileIdentity(file("notes.json", "notes")), "");
  assert.equal(fileIdentity(file("picture (3 张截图)", "picture-dir")), "");
  assert.equal(fileIdentity(file("附件.bin", "other")), "");
  // 身份这一行必须短：窄侧边栏里不会被截断。
  for (const name of [`${head}_P123_2026-11-23_21-47.md`, `AI总结_${head}_P123.md`]) {
    assert.ok(Array.from(fileIdentity(file(name))).length <= 32, fileIdentity(file(name)));
  }
});

test("renderMarkdown：标题、列表、粗体；链接只显示文字，地址放在悬停提示里", () => {
  const html = renderMarkdown(
    [
      "# 视频标题",
      "",
      "- **UP主：** 某某",
      "## 完整字幕",
      "- [0:01](https://www.bilibili.com/video/BV1xwVr6FEh4/?p=21&t=1s) 你好",
      "> [0:02](https://www.bilibili.com/video/BV1xwVr6FEh4/?t=2s) 引用",
      "---",
    ].join("\n"),
  );
  assert.equal(
    html,
    '<h2>视频标题</h2><div class=\'md-gap\'></div><div class="md-li"><b>UP主：</b> 某某</div>' +
      '<h3>完整字幕</h3>' +
      '<div class="md-li"><span class="md-link" title="https://www.bilibili.com/video/BV1xwVr6FEh4/?p=21&amp;t=1s">0:01</span> 你好</div>' +
      '<blockquote><span class="md-link" title="https://www.bilibili.com/video/BV1xwVr6FEh4/?t=2s">0:02</span> 引用</blockquote>' +
      "<hr>",
  );
  assert.equal(renderMarkdown("普通 <b>文本</b> & 特殊字符"), "<p>普通 &lt;b&gt;文本&lt;/b&gt; &amp; 特殊字符</p>");
  assert.equal(renderMarkdown(""), "<div class='md-gap'></div>");
  assert.equal(renderMarkdown(null), "<div class='md-gap'></div>");
});

test("renderMarkdown：字幕文本来自 UP 主，无论写什么都不能变成侧边栏里的标签或事件属性", () => {
  const attacks = [
    '<script>window.desktop.saveSettings({})</script>',
    '<img src=x onerror="window.desktop.openWithDefaultApp(\'C:/evil.bat\')">',
    '- [x](https://a.b/"onmouseover="window.desktop.saveSettings({}) 余下文字',
    '- [x](https://a.b/\'onmouseover=\'window.desktop.saveSettings({}) 余下文字',
    '- [x](javascript:alert(1)) 不是 http 链接',
    '[**粗体标签**](https://a.b/?a=1&b=2) 带与号',
    '[标签](https://a.b/?q=<script>) 带尖括号',
    '[x](https://a.b/?q=`onmouseover=x) 反引号',
  ];
  for (const attack of attacks) {
    const html = renderMarkdown(attack);
    assert.ok(!/<script|<img/i.test(html), `标签没有被转义: ${html}`);
    assert.ok(!/<[^>]+\son\w+\s*=/i.test(html), `出现了事件属性: ${html}`);
    assert.ok(!/<span[^>]*javascript:/.test(html), `非 http 链接进了属性: ${html}`);
  }
  // 多P视频的字幕链接带与号（?p=21&t=1s），必须照常渲染；尖括号在属性里只是转义后的文字。
  assert.equal(
    renderMarkdown("[x](https://a.b/?a=1&b=2)"),
    '<p><span class="md-link" title="https://a.b/?a=1&amp;b=2">x</span></p>',
  );
  assert.equal(
    renderMarkdown("[x](https://a.b/?q=<script>)"),
    '<p><span class="md-link" title="https://a.b/?q=&lt;script&gt;">x</span></p>',
  );
  // 正常的字幕链接仍然可用。
  assert.match(renderMarkdown("- [0:01](https://www.bilibili.com/video/BV1/?t=1s) 正文"), /class="md-link"/);
});

test("prettyNotes：把 notes.json 渲染成「[分:秒] 内容」", () => {
  assert.equal(prettyNotes(JSON.stringify({ notes: [{ timestamp: 62, text: "第一条" }, { timestamp: 5, text: "第二条" }] })), "[1:02] 第一条\n[0:05] 第二条");
  assert.equal(prettyNotes(JSON.stringify({ notes: [] })), "（空）");
  assert.equal(prettyNotes("不是 JSON"), "不是 JSON");
});

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
      return { ugc_season: { title: "GitHub一周热点汇总", sections: [{ episodes: [
        { bvid: "BV1old", title: "老视频", pages: Array.from({ length: 3 }, (_, i) => ({ page: i + 1 })) },
        { bvid: "BV1new", title: "新视频", pages: [{ page: 1 }] },
      ] }] } };
    }
    return { ugc_season: null }; // BV1solo → UP主分组，跳过
  };

  const updates = await detectCollectionUpdates(root, fetchView);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].collectionTitle, "GitHub一周热点汇总");
  assert.equal(updates[0].dir, "GitHub一周热点汇总");
  assert.equal(updates[0].newCount, 1);
  assert.equal(updates[0].newPCount, 1); // 本地P1，远端3P
  rmSync(root, { recursive: true, force: true });
});

test("detectCollectionUpdates swallows per-collection failures and returns []", async () => {
  const root = join("tests", "tmp-coll-update2");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "合集A", "视频_BV1fail"), { recursive: true });
  mkdirSync(join(root, "合集B", "视频_BV1ok"), { recursive: true });
  writeFileSync(join(root, "合集A", "视频_BV1fail", "视频_2026-09-01_10-00.md"), "# t");
  writeFileSync(join(root, "合集B", "视频_BV1ok", "视频_2026-09-01_10-00.md"), "# t");

  const fetchView = async (bv) => {
    if (bv === "BV1fail") throw new Error("network down");
    return { ugc_season: { title: "合集B", sections: [{ episodes: [{ bvid: "BV1ok", title: "视频", pages: [{ page: 1 }] }] }] } };
  };
  // 合集B 全部已导出 → 不出现在结果里；合集A 失败被吞掉
  const updates = await detectCollectionUpdates(root, fetchView);
  assert.deepEqual(updates, []);
  rmSync(root, { recursive: true, force: true });
});

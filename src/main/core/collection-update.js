// Startup collection check: for every top-level library dir, fetch the
// Bilibili view of one exported video; only real ugc_season collections are
// compared (UP-grouped folders return no season and are skipped silently).
// `fetchView` is injected so tests never touch the network.
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
      probeBv =
        readdirSync(join(base, dir), { withFileTypes: true })
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

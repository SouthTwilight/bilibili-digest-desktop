import { requestAiCompletion, loadPromptSection } from "./ai.js";
import { cleanTitle, clip, stripMarkerTails, HEAD_MAX } from "./naming.js";

// Long titles make long paths — the root of most of the library's filename
// incidents. A video that is new to the library gets its head from the text
// model once; the folder then IS the record, so a title is never condensed
// twice and the model's variability can never split one video into two
// folders. Titles up to CONDENSE_ABOVE characters pass through untouched.
export const CONDENSE_ABOVE = 30;
export const CONDENSE_MAX = 16;
const CONDENSE_TIMEOUT_MS = 8_000;

export function needsCondense(title) {
  return cleanTitle(title).length > CONDENSE_ABOVE;
}

// A label the model sometimes puts in front of the answer ("标题：…").
const LABEL_RE = /^(?:浓缩(?:后的)?(?:标题|文件名)|文件名(?:标题)?|标题|输出|结果|answer|title)\s*[:：]\s*/i;

// Model output → something that can be a name: the first line that is not a
// code fence, without a label or wrapping quotes, made legal and cut to the
// cap. "" when nothing usable came back.
export function normalizeCondensed(text) {
  const firstLine =
    String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !/^`+$/.test(line)) || "";
  const unwrapped = firstLine
    .replace(LABEL_RE, "")
    .trim()
    .replace(/^[「『“"'《<\s]+/, "")
    .replace(/[」』”"'》>.\s]+$/, "")
    .trim();
  return stripMarkerTails(clip(cleanTitle(unwrapped), CONDENSE_MAX));
}

// resolve("") when `ms` passes first; the timer is cleared either way so a
// settled request never keeps the process alive.
function within(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(""), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// decideVideoHead(title, bvid, saveDir, context) — the head for a video
// folder that does not exist yet. It never throws and never holds a write
// longer than the timeout: with the feature off, without a key, offline, over
// time or given an unusable answer it falls back to the mechanical clip, so
// an export never fails because of it.
export function createTitleCondenser({
  settingsResolver,
  requestCompletion = requestAiCompletion,
  timeoutMs = CONDENSE_TIMEOUT_MS,
}) {
  const sessionHeads = new Map(); // save dir | BV → head decided earlier this session
  const inFlight = new Map(); // provider | title → pending request

  async function condense(title, settings, context) {
    const key = `${settings.provider}|${title}`;
    let pending = inFlight.get(key);
    if (!pending) {
      pending = requestCompletion({
        settings,
        maxTokens: 64,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: loadPromptSection("naming.md", "Condense title", {
              max: CONDENSE_MAX,
              channel: cleanTitle(context?.channelName || "") || "未知",
              // Last, so braces inside a title are not read as a placeholder.
              title,
            }),
          },
        ],
      })
        .then(normalizeCondensed, () => "")
        .finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    return within(pending, timeoutMs);
  }

  return async function decideVideoHead(title, bvid, saveDir = "", context = {}) {
    const clean = cleanTitle(title);
    const sessionKey = `${saveDir}|${String(bvid || "").toUpperCase()}`;
    if (sessionHeads.has(sessionKey)) return sessionHeads.get(sessionKey);

    let head = "";
    const settings = settingsResolver?.() || null;
    const keyed = !!settings?.aiApiKeys?.[settings.provider];
    if (settings?.condenseLongTitles !== false && keyed && clean.length > CONDENSE_ABOVE) {
      head = await condense(clean, settings, context);
    }
    head = head || stripMarkerTails(clip(clean, HEAD_MAX));
    sessionHeads.set(sessionKey, head);
    return head;
  };
}

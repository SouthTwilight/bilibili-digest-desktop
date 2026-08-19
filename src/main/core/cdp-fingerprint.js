// Passive fingerprint capture via CDP.
//
// Bilibili's web player signs its player-API requests with environment-level
// device fingerprints (dm_img_str / dm_cover_img_str / dm_img_inter). The
// browser view generates fresh, REAL values on every page load. This module
// passively watches the view's OUTGOING requests (never responses) and
// caches the latest fingerprint values so our own main-process requests use
// the same identity the page just proved to B站 — instead of one static
// fingerprint shared by every install of the app (detectable pattern).
import { DM_FALLBACK } from "./fingerprint-defaults.js";

let getWebContents = () => null;
let latest = null;
let attached = false;

export function initFingerprintCapture(resolveWebContents) {
  getWebContents = resolveWebContents;
  void ensureAttached();
}

async function ensureAttached() {
  const wc = getWebContents();
  if (!wc || wc.isDestroyed() || attached) return;
  if (wc.debugger.isAttached()) return;
  try {
    wc.debugger.attach("1.3");
    wc.debugger.on("detach", () => {
      attached = false;
      // Re-attach lazily on the next capture request.
      void ensureAttached();
    });
    wc.debugger.on("message", (_event, method, params) => {
      if (method !== "Network.requestWillBeSent") return;
      const url = params?.request?.url || "";
      if (!/\/x\/player\/wbi\/v2\?/.test(url)) return;
      const query = new URL(url).searchParams;
      const captured = {
        dm_img_str: query.get("dm_img_str"),
        dm_cover_img_str: query.get("dm_cover_img_str"),
        dm_img_inter: query.get("dm_img_inter"),
        web_location: query.get("web_location"),
        capturedAt: Date.now(),
      };
      if (captured.dm_img_str && captured.dm_cover_img_str && captured.dm_img_inter) {
        latest = captured;
      }
    });
    await wc.debugger.sendCommand("Network.enable");
    attached = true;
  } catch {
    // Attach races with early navigation are harmless; the next init or
    // fingerprint request retries.
  }
}

// Returns the latest real fingerprint captured from the page, falling back
// to static bootstrap values until the page has made its first player
// request. Also opportunistically re-attaches after detach events.
export function getFingerprintParams() {
  void ensureAttached();
  if (latest) return latest;
  return DM_FALLBACK;
}

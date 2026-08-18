// Bilibili APIs need the logged-in cookies that live in the embedded browser
// session. Electron is imported lazily so plain-Node unit tests can import
// the pure modules without it.
let bilibiliSession = null;

export function initBilibiliHttp(session) {
  bilibiliSession = session;
}

// SameSite=Lax session cookies (SESSDATA, buvid3, …) are withheld from
// main-process requests because they have no site context, so we read the
// cookies from the session and attach them as an explicit header instead.
async function sessionCookieHeader(url) {
  const cookies = await bilibiliSession.cookies.get({ url });
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export async function bilibiliFetch(url, options = {}) {
  const { net } = await import("electron");
  if (!bilibiliSession) {
    throw new Error("Bilibili session is not initialized yet.");
  }
  const cookie = await sessionCookieHeader(url);
  // A stalled request would hang the whole transcript pipeline forever, so
  // bound every Bilibili call.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    return await net.fetch(url, {
      session: bilibiliSession,
      useSessionCookies: true,
      headers: {
        Referer: "https://www.bilibili.com/",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(options.headers || {}),
      },
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

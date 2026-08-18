// Bilibili APIs need the logged-in cookies that live in the embedded browser
// session. Electron is imported lazily so plain-Node unit tests can import
// the pure modules without it.
let bilibiliSession = null;

// Optional fallback: run a fetch INSIDE the embedded Bilibili page. B站's
// player/v2 intermittently returns an empty subtitle list for unsigned
// main-process requests; the page's own context signs everything, so core
// services fall back to this when the direct call comes back empty.
let pageContextFetch = null;

export function initBilibiliHttp(session) {
  bilibiliSession = session;
}

export function initPageContextFetch(fetchInPage) {
  pageContextFetch = fetchInPage;
}

export function fetchViaPage(url) {
  if (!pageContextFetch) return Promise.reject(new Error("页面上下文不可用"));
  return pageContextFetch(url);
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
  return net.fetch(url, {
    session: bilibiliSession,
    useSessionCookies: true,
    headers: {
      Referer: 'https://www.bilibili.com/',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
}

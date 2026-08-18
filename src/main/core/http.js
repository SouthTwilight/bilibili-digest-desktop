// Bilibili APIs need the logged-in cookies that live in the embedded browser
// session. Plain Node fetch would be anonymous, so every Bilibili request goes
// through net.fetch bound to that session. Electron is imported lazily so
// plain-Node unit tests can import the pure modules without it.
let bilibiliSession = null;

export function initBilibiliHttp(session) {
  bilibiliSession = session;
}

export async function bilibiliFetch(url, options = {}) {
  const { net } = await import("electron");
  if (!bilibiliSession) {
    throw new Error("Bilibili session is not initialized yet.");
  }
  return net.fetch(url, { session: bilibiliSession, ...options });
}

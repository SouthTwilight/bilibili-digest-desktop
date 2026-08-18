// Top-level navigation in the embedded browser view is restricted to
// Bilibili-owned domains. The web login flow performs an SSO/cross-domain
// redirect through passport.biligame.com after the captcha/verification step;
// without allowing that domain the app would hand the login off to the system
// browser instead of completing inside the embedded view.
const ALLOWED_NAVIGATION_DOMAINS = ["bilibili.com", "biligame.com"];

export function isAllowedUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const hostname = parsed.hostname.toLowerCase();
    return ALLOWED_NAVIGATION_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedUrl } from "../src/main/core/url-policy.js";

test("allows bilibili.com and its subdomains", () => {
  assert.equal(isAllowedUrl("https://www.bilibili.com/"), true);
  assert.equal(isAllowedUrl("https://passport.bilibili.com/login"), true);
  assert.equal(isAllowedUrl("https://bilibili.com/"), true);
  assert.equal(isAllowedUrl("http://www.bilibili.com/"), true);
});

test("allows biligame.com SSO/cross-domain login redirects", () => {
  assert.equal(
    isAllowedUrl(
      "https://passport.biligame.com/crossDomain?DedeUserID=1&SESSDATA=x&gourl=https%3A%2F%2Fwww.bilibili.com%2F",
    ),
    true,
  );
  assert.equal(isAllowedUrl("https://www.biligame.com/"), true);
});

test("rejects non-Bilibili domains and lookalikes", () => {
  assert.equal(isAllowedUrl("https://example.com/"), false);
  assert.equal(isAllowedUrl("https://evil-bilibili.com/"), false);
  assert.equal(isAllowedUrl("https://bilibili.com.evil.com/"), false);
  assert.equal(isAllowedUrl("https://passport.biligame.com.evil.com/"), false);
  assert.equal(isAllowedUrl("file:///C:/Windows/win.ini"), false);
});

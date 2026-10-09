import { describe, test, expect } from "bun:test";
import { isThirdParty } from "../src/config";

describe("isThirdParty", () => {
  test("Royal Road and its subdomains load", () => {
    expect(isThirdParty("https://www.royalroad.com/fiction/21220")).toBe(false);
    expect(isThirdParty("https://royalroad.com/")).toBe(false);
    expect(isThirdParty("https://cdn.royalroad.com/app.js")).toBe(false);
  });

  test("Cloudflare (challenge platform, cdnjs) loads", () => {
    expect(isThirdParty("https://challenges.cloudflare.com/turnstile/v0/api.js")).toBe(false);
    expect(isThirdParty("https://cdnjs.cloudflare.com/ajax/libs/x.js")).toBe(false);
  });

  test("ad and analytics hosts are blocked", () => {
    expect(isThirdParty("https://ad.doubleclick.net/x")).toBe(true);
    expect(isThirdParty("https://s.nitropay.com/ads.js")).toBe(true);
    expect(isThirdParty("https://id5-sync.com/i")).toBe(true);
  });

  test("lookalike hosts do not slip through", () => {
    expect(isThirdParty("https://royalroad.com.evil.example/x")).toBe(true);
    expect(isThirdParty("https://notroyalroad.com/x")).toBe(true);
    expect(isThirdParty("https://cloudflare.com.attacker.io/x")).toBe(true);
  });

  test("local schemes are never third parties", () => {
    expect(isThirdParty("data:text/html,hi")).toBe(false);
    expect(isThirdParty("blob:https://www.royalroad.com/abc")).toBe(false);
    expect(isThirdParty("not a url")).toBe(false);
  });
});

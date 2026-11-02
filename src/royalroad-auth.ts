/** Royal Road login over HTTP (the login form needs no JavaScript). */
import { ROYAL_ROAD_BASE_URL, ROYAL_ROAD_USERNAME, ROYAL_ROAD_PASSWORD } from "./config";
import { setRoyalRoadCookie } from "./royalroad-credentials";
import { fetchRoyalRoad } from "./http";

const LOGIN_URL = `${ROYAL_ROAD_BASE_URL}/account/login?returnurl=%2Fhome`;
const IDENTITY = ".AspNetCore.Identity.Application";

/** `name=value` pairs from Set-Cookie headers. */
function cookiePairs(setCookies: string[]): string[] {
  return setCookies.map((c) => c.split(";")[0]);
}

export async function performHttpLogin(userId: string): Promise<boolean> {
  const startTime = Date.now();
  try {
    // The login form carries an antiforgery token tied to a cookie set here.
    const form = await fetchRoyalRoad(LOGIN_URL, { redirect: "manual" });
    const html = await form.text();
    const token = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]*)"/)?.[1];
    if (!token) {
      const why = form.headers.get("cf-mitigated") === "challenge" || /Just a moment/i.test(html)
        ? "Cloudflare challenged the login page"
        : `no login form on the login page (HTTP ${form.status})`;
      console.error(`[AutoLogin] HTTP login failed: ${why}`);
      return false;
    }

    const body = new URLSearchParams({
      Email: ROYAL_ROAD_USERNAME,
      Password: ROYAL_ROAD_PASSWORD,
      Remember: "true",
      __RequestVerificationToken: token,
      returnUrl: "/home",
    });
    const res = await fetchRoyalRoad(LOGIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: LOGIN_URL,
        Cookie: cookiePairs(form.headers.getSetCookie()).join("; "),
      },
      body: body.toString(),
      redirect: "manual",
    });

    const identity = cookiePairs(res.headers.getSetCookie()).find((c) => c.startsWith(`${IDENTITY}=`));
    const value = identity?.slice(IDENTITY.length + 1);
    if (!value) {
      console.error(
        res.headers.get("cf-mitigated") === "challenge"
          ? "[AutoLogin] HTTP login failed: Cloudflare challenged the login POST"
          : `[AutoLogin] HTTP login returned no session cookie (HTTP ${res.status}) - check ROYAL_ROAD_USERNAME/PASSWORD`
      );
      return false;
    }
    setRoyalRoadCookie(userId, IDENTITY, value);
    console.log(`[AutoLogin] Logged in over HTTP in ${Date.now() - startTime}ms`);
    return true;
  } catch (error) {
    console.error(`[AutoLogin] HTTP login failed after ${Date.now() - startTime}ms:`, error);
    return false;
  }
}

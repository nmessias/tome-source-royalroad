import {
  ROYAL_ROAD_BASE_URL,
  ROYAL_ROAD_USERNAME,
  ROYAL_ROAD_PASSWORD,
  ROYAL_ROAD_AUTO_LOGIN_ENABLED,
} from "./config";
import { setRoyalRoadCookie } from "./royalroad-credentials";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export { ROYAL_ROAD_AUTO_LOGIN_ENABLED };

export async function performAutoLogin(userId: string): Promise<boolean> {
  if (!ROYAL_ROAD_AUTO_LOGIN_ENABLED) {
    return false;
  }

  console.log("[AutoLogin] Starting auto-login to Royal Road...");
  const startTime = Date.now();

  try {
    // Step 1: GET login page to extract CSRF token and initial cookies
    const loginPageRes = await fetch(`${ROYAL_ROAD_BASE_URL}/account/login?returnurl=%2Fhome`, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
      },
      redirect: "manual",
    });

    const loginHtml = await loginPageRes.text();
    const initialCookies = loginPageRes.headers.getSetCookie();

    // Check for login page / CSRF token (also serves as "already logged in" check)
    const tokenMatch = loginHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]*)"/);
    if (!tokenMatch) {
      if (loginPageRes.status === 302 || loginHtml.includes("window.location") || !loginHtml.includes("Sign In")) {
        console.log("[AutoLogin] Already logged in or login page not accessible, refreshing cookies");
        const cookieMatch = initialCookies.find(c => c.includes(".AspNetCore.Identity.Application"));
        if (cookieMatch) {
          const value = cookieMatch.split("=")[1]?.split(";")[0];
          if (value) {
            setRoyalRoadCookie(userId, ".AspNetCore.Identity.Application", value);
          }
        }
        return true;
      }
      console.error("[AutoLogin] Could not find CSRF token on login page - Cloudflare may be blocking");
      return false;
    }

    const csrfToken = tokenMatch[1];
    console.log(`[AutoLogin] Got CSRF token, ${initialCookies.length} initial cookies`);

    // Step 2: POST credentials
    const formData = new URLSearchParams();
    formData.append("Email", ROYAL_ROAD_USERNAME);
    formData.append("Password", ROYAL_ROAD_PASSWORD);
    formData.append("Remember", "true");
    formData.append("__RequestVerificationToken", csrfToken);
    formData.append("returnUrl", "/home");

    const cookieHeader = initialCookies.map(c => c.split(";")[0]).join("; ");

    const loginRes = await fetch(`${ROYAL_ROAD_BASE_URL}/account/login?returnurl=%2Fhome`, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html",
        "Referer": `${ROYAL_ROAD_BASE_URL}/account/login?returnurl=%2Fhome`,
        "Cookie": cookieHeader,
      },
      body: formData.toString(),
      redirect: "manual",
    });

    const responseCookies = loginRes.headers.getSetCookie();

    // Find and save the identity cookie
    const identityCookie = responseCookies.find(c => c.includes(".AspNetCore.Identity.Application"));
    if (identityCookie) {
      const value = identityCookie.split("=")[1]?.split(";")[0];
      if (value) {
        setRoyalRoadCookie(userId, ".AspNetCore.Identity.Application", value);
        console.log(`[AutoLogin] Logged in successfully in ${Date.now() - startTime}ms`);
        return true;
      }
    }

    console.error("[AutoLogin] No identity cookie in response - credentials may be invalid");
    return false;
  } catch (error) {
    console.error(`[AutoLogin] Failed after ${Date.now() - startTime}ms:`, error);
    return false;
  }
}

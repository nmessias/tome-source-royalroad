/**
 * Building the Cookie header for an upstream request.
 *
 * Pure and dependency-free so the rules are testable without a database — and
 * so a mistake here cannot be masked by test setup.
 */

export interface NamedCookie {
  name: string;
  value: string;
}

/**
 * Combine a user's cookie jar with the process-wide Cloudflare clearance.
 *
 * Three rules, each of which was a bug when it was not true:
 *
 * 1. The clearance is sent even when there is no user. Public fiction, chapter,
 *    search and toplist pages are fetched anonymously, and skipping the cookie
 *    for them meant every read went out bare and re-challenged from scratch.
 * 2. A user's own clearance wins — it was earned more recently than the shared
 *    one, so it is likely the fresher of the two.
 * 3. A user with no cookies at all still gets the shared clearance rather than
 *    an empty header.
 */
export function buildCookieHeader(
  userCookies: readonly NamedCookie[] | undefined,
  sharedClearance: string | null | undefined
): string {
  const parts: string[] = [];

  for (const cookie of userCookies ?? []) {
    if (cookie?.name && cookie?.value) parts.push(`${cookie.name}=${cookie.value}`);
  }

  const userHasClearance = parts.some((p) => p.startsWith("cf_clearance="));
  if (!userHasClearance && sharedClearance) {
    parts.push(`cf_clearance=${sharedClearance}`);
  }

  return parts.join("; ");
}

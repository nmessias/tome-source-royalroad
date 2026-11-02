# tome-source-royalroad

Royal Road source plugin for [Tome](https://github.com/nmessias/tome) — web fiction proxy optimized for e-ink devices.

Implements the Tome `Source` contract (ADR-0001): search, follows, history, toplists, read-later, bookmarks, and credentials via the unified `/read/royalroad/...` routes.

## Install

```sh
bun add tome-source-royalroad
export TOME_PLUGINS=tome-source-royalroad
```

Until the package is published to npm, install from GitHub:

```sh
bun add github:nmessias/tome-source-royalroad
```

Requires Tome >= 1.5.0.

## Configuration

| Env var | Purpose |
|---|---|
| `ROYAL_ROAD_USERNAME` / `ROYAL_ROAD_PASSWORD` | Auto-login when the session expires (optional) |
| `ENABLE_BROWSER=true` | Use Playwright (Chromium) for scraping. Required: the browser is the only transport Cloudflare accepts. |
| `ROYAL_ROAD_BROWSER` | Only `chromium` is supported. |
| `ROYAL_ROAD_HEADLESS` | Headless by default. Set `false` only for local debugging with a display. |
| `ROYAL_ROAD_PROXY` | Optional proxy URL used by the browser, e.g. `http://user:pass@host:3128` or `socks5://127.0.0.1:1055`. Required in production: Cloudflare challenges every request from datacenter IPs, so the exit node must be residential/mobile. Chromium cannot do SOCKS5 with credentials. |
| `ROYAL_ROAD_CHAPTER_TTL_DAYS` | Chapter cache lifetime in days (default `7`). |
| `ROYAL_ROAD_LOGIN_COOLDOWN_MS` | Backoff after a failed automatic login (default 5 min). The Settings > Refresh session button always skips it. |

Session cookies (`.AspNetCore.Identity.Application`, `cf_clearance`) can also be entered in Tome's Settings page — the form renders from this source's `credentialFields`.

### Fetching and Cloudflare

There is no HTTP fast path. `impit` (a Chrome-TLS-impersonating client) used to
serve most pages, but Royal Road's Cloudflare now answers it with a managed JS
challenge regardless of the User-Agent, so it was removed.

The browser is the transport. It runs **headless** and is kept warm, so only the
first fetch pays start-up. The one non-obvious detail: headless Chrome advertises
`HeadlessChrome/<version>` in its User-Agent, and Cloudflare rejects that token
with a challenge that never clears. The plugin therefore launches Chromium with
`--user-agent=<real Chrome version>`, derived from the installed binary. That,
plus a residential/mobile exit IP (`ROYAL_ROAD_PROXY`), is what gets through.

A stored `cf_clearance` is deliberately **not** sent: it is bound to the IP and
browser that earned it, and a stale one makes the request look forged.

### A note on the two front ends

Royal Road serves a **Legacy** and a **Redesign** (Tailwind) front end behind the
same URLs. The Redesign is gated on `window.royalroad.design ===
"TailwindRedesign"` / `sitePresentationMode === 0` and toggled by the
`beta-ui-v2` cookie.

This plugin never sets that cookie, so it always receives Legacy markup. The
selectors are written to accept several card families (see `FICTION_CARD_SELECTOR`
in `src/parsers.ts`) so a rename degrades to "no rows" rather than crashing, but
the day Royal Road removes Legacy the whole parser needs revisiting. The fixture
tests in `test/` are the early-warning system for that.

### Public pages never require a session

Fiction, chapter, search and toplist pages are readable without being logged in,
so a stale session cookie no longer breaks them: the scraper falls back to an
anonymous fetch and the page renders without your personal state (follow/read
markers). Follows, read-later and history are inherently private and surface an
error telling you to paste a fresh cookie.

## Development

```sh
bun install
bun run typecheck
bun test            # parser regression suite (no network needed)
bun run fixtures    # regenerate fixtures from a fresh capture (needs network)
```

`src/parsers.ts` holds every HTML→domain rule as a pure function; `src/scraper.ts`
holds the fetching, browser and cache orchestration. Keep it that way — the
parsers are the part Royal Road breaks.

Types and shared runtime (cache, config, registry) come from the `tome` package; the adapter imports `Source` and friends via `import type { ... } from "tome"`.

## Known limitations

- **Search and toplist results carry no author.** The list markup has no author
  link, so Tome renders "Unknown" for every row; getting the author would need a
  per-fiction page fetch, which is not worth the cost on a 50-row list.
- **Fiction pages are cached per user** (`fiction:<id>:<userId>`) because they
  carry the antiforgery token and your own follow/read state. Chapter and
  toplist caches are shared, since that content is identical for everyone.

## License

MIT

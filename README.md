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
| `ENABLE_BROWSER=true` | Use Playwright (Firefox) for scraping (optional, heavier image) |

Session cookies (`.AspNetCore.Identity.Application`, `cf_clearance`) can also be entered in Tome's Settings page — the form renders from this source's `credentialFields`.

## Development

```sh
bun install
bun run typecheck
```

Types and shared runtime (cache, config, registry) come from the `tome` package; the adapter imports `Source` and friends via `import type { ... } from "tome"`.

## License

MIT

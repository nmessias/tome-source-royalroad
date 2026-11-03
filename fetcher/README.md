# Royal Road fetcher

A small HTTP service for the phone. Tome (on Fly) POSTs a Royal Road request to
it over Tailscale; the phone makes the request with a Firefox TLS/HTTP2
fingerprint from Android's own network stack and returns status, final URL,
every header (all `Set-Cookie`s) and body.

- `POST /fetch` `{url, method?, headers?: [[name, value]...], body?, redirect?: "follow"|"manual"}`
  returns `{status, url, headers: [[name, value]...], body}`
- `GET /health` returns `ok`
- Requires `Authorization: Bearer $RR_FETCHER_TOKEN` (constant-time compare; refuses to start without a token)
- Only `https://royalroad.com` and its subdomains, also across redirects. Anything else is a 403.
- No cookie jar: Tome sends its cookies in `headers`.

| Env | Default | |
| --- | --- | --- |
| `RR_FETCHER_TOKEN` | none, required | shared secret |
| `RR_FETCHER_ADDR` | `0.0.0.0:8787` | listen address |
| `RR_FETCHER_DNS` | unset | e.g. `1.1.1.1:53`, only for a cross-compiled binary that cannot resolve names |

## Install on the phone (Termux)

Build on the phone (needs Go 1.24.1 or newer, which `pkg` provides):

```sh
pkg install golang git
git clone https://github.com/nmessias/tome-source-royalroad
cd tome-source-royalroad/fetcher
go build -ldflags="-s -w" -o ~/rr-fetcher .
```

Or cross-compile on a PC and copy it over (`adb push`, Tailscale file share, ...):

```sh
CGO_ENABLED=0 GOOS=android GOARCH=arm64 go build -ldflags="-s -w" -o rr-fetcher .
```

A CGO-free Android binary has no `resolv.conf`, so start it with
`RR_FETCHER_DNS=1.1.1.1:53` (a binary built in Termux does not need this).

Set the token (any long random string) and run it:

```sh
mkdir -p ~/.rr-fetcher
openssl rand -hex 32 > ~/.rr-fetcher/token      # or `head -c32 /dev/urandom | base64`
RR_FETCHER_TOKEN=$(cat ~/.rr-fetcher/token) ~/rr-fetcher
```

Check it from the phone: `curl localhost:8787/health`. The same token goes into
Tome's `ROYAL_ROAD_FETCHER_TOKEN`.

## Keep it alive

1. Android: Settings > Apps > Termux > Battery > **Unrestricted** (same for Termux:Boot).
   In the Tailscale app, Termux must not be excluded by split tunneling: an
   excluded app's replies leave over Wi-Fi and tailnet requests time out.
2. Hold a wake lock so the CPU does not sleep: `termux-wake-lock` (or the Termux notification's "Acquire wakelock").
3. Autostart on boot. The Google Play build of Termux runs `~/.termux/boot` scripts
   itself; the F-Droid build needs the Termux:Boot app (install it, open it once). Create
   `~/.termux/boot/rr-fetcher`, then `chmod +x` it:

   ```sh
   #!/data/data/com.termux/files/usr/bin/sh
   termux-wake-lock
   export RR_FETCHER_TOKEN=$(cat ~/.rr-fetcher/token)
   export RR_FETCHER_DNS=1.1.1.1:53   # only for the cross-compiled binary
   exec ~/rr-fetcher >> ~/.rr-fetcher/log 2>&1
   ```

Tailscale must be connected on the phone (it already is, as the exit node).
The service listens on all interfaces; only the tailnet should reach it, so do
not port-forward it on the router.

## On a desktop

The same binary runs on a Linux desktop: build it with `go build -o ~/.local/bin/rr-fetcher .`,
put the token in `~/.config/rr-fetcher/token`, and install `rr-fetcher.service` (instructions
at its top). It listens on the machine's tailnet address only.

## Tome side

On the Fly app, list the routes in order of preference: fetcher URLs, and `direct`
for Tome's own client (through `ROYAL_ROAD_PROXY`, which also carries the calls to
the fetchers). A route that is down is skipped for 2 minutes; a challenged one
falls through to the next; the last route's answer is final. All fetchers share
one token.

```sh
fly secrets set ROYAL_ROAD_FETCHER_URL=http://<desktop>:8787,http://100.115.240.61:8787,direct ROYAL_ROAD_FETCHER_TOKEN=<token>
```

Unset either to go back to fetching directly with impit.

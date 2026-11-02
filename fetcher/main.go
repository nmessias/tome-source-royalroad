// Royal Road fetcher: a tiny authenticated HTTP service that performs Royal
// Road requests with a Firefox TLS/HTTP2 fingerprint from wherever it runs
// (the user's phone), so Cloudflare sees a residential device, not Fly.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	tls "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
)

const (
	userAgent   = "Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0"
	maxBody     = 16 << 20 // response cap: pages are well under 1MB
	maxRequest  = 1 << 20
	maxRedirect = 10
)

type fetchRequest struct {
	URL      string      `json:"url"`
	Method   string      `json:"method"`
	Headers  [][2]string `json:"headers"`
	Body     string      `json:"body"`
	Redirect string      `json:"redirect"`
}

type fetchResponse struct {
	Status  int         `json:"status"`
	URL     string      `json:"url"`
	Headers [][2]string `json:"headers"`
	Body    string      `json:"body"`
}

// Firefox's request header order; headers outside this list follow in the
// order the caller gave them.
var headerOrder = []string{
	"host", "user-agent", "accept", "accept-language", "accept-encoding",
	"content-type", "content-length", "origin", "referer", "cookie",
	"upgrade-insecure-requests", "sec-fetch-dest", "sec-fetch-mode",
	"sec-fetch-site", "sec-fetch-user", "priority", "te",
}

// Defaults for a top-level navigation, added only when the caller gave none.
var defaultHeaders = [][2]string{
	{"user-agent", userAgent},
	{"accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"},
	{"accept-language", "en-US,en;q=0.5"},
	{"accept-encoding", "gzip, deflate, br, zstd"},
	{"upgrade-insecure-requests", "1"},
	{"sec-fetch-dest", "document"},
	{"sec-fetch-mode", "navigate"},
	{"sec-fetch-site", "none"},
	{"sec-fetch-user", "?1"},
	{"priority", "u=0, i"},
}

func allowed(u *url.URL) bool {
	h := strings.ToLower(u.Hostname())
	return u.Scheme == "https" && (h == "royalroad.com" || strings.HasSuffix(h, ".royalroad.com"))
}

func newClient(follow bool) tls.HttpClient {
	opts := []tls.HttpClientOption{
		tls.WithClientProfile(profiles.Firefox_147),
		tls.WithTimeoutSeconds(30),
		tls.WithDisableHttp3(),
	}
	if !follow {
		opts = append(opts, tls.WithNotFollowRedirects())
	} else {
		// A redirect off royalroad.com would turn this into an open proxy.
		opts = append(opts, tls.WithCustomRedirectFunc(func(req *fhttp.Request, via []*fhttp.Request) error {
			if len(via) >= maxRedirect {
				return errors.New("too many redirects")
			}
			if !allowed(req.URL) {
				return errors.New("redirect to a disallowed host")
			}
			return nil
		}))
	}
	c, err := tls.NewHttpClient(nil, opts...) // no cookie jar: Tome sends its own cookies
	if err != nil {
		log.Fatal(err)
	}
	return c
}

func fail(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func main() {
	token := os.Getenv("RR_FETCHER_TOKEN")
	if token == "" {
		log.Fatal("RR_FETCHER_TOKEN is required")
	}
	addr := os.Getenv("RR_FETCHER_ADDR")
	if addr == "" {
		addr = "0.0.0.0:8787"
	}
	// A cross-compiled (CGO-free) Android binary finds no resolv.conf and
	// cannot resolve names; RR_FETCHER_DNS=1.1.1.1:53 gives it a resolver.
	if dns := os.Getenv("RR_FETCHER_DNS"); dns != "" {
		net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, dns)
		}}
	}
	// Two clients so keep-alive connections are reused whichever mode is asked for.
	follow, manual := newClient(true), newClient(false)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok\n") })
	mux.HandleFunc("POST /fetch", func(w http.ResponseWriter, r *http.Request) {
		want := []byte("Bearer " + token)
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), want) != 1 {
			fail(w, 401, "unauthorized")
			return
		}
		var in fetchRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequest)).Decode(&in); err != nil {
			fail(w, 400, "bad request body")
			return
		}
		u, err := url.Parse(in.URL)
		if err != nil || !allowed(u) {
			fail(w, 403, "only https royalroad.com URLs are allowed")
			return
		}
		method := strings.ToUpper(in.Method)
		if method == "" {
			method = "GET"
		}
		var body io.Reader
		if in.Body != "" {
			body = strings.NewReader(in.Body)
		}
		req, err := fhttp.NewRequestWithContext(r.Context(), method, u.String(), body)
		if err != nil {
			fail(w, 400, "bad request")
			return
		}

		have := map[string]bool{}
		var order []string
		for _, h := range in.Headers {
			k := strings.ToLower(h[0])
			if k == "host" || k == "content-length" || k == "connection" {
				continue
			}
			req.Header.Add(k, h[1])
			if !have[k] {
				have[k] = true
				order = append(order, k)
			}
		}
		if method != "GET" && method != "HEAD" {
			// A form POST is not a top-level navigation from the address bar.
			have["sec-fetch-site"], have["sec-fetch-user"], have["priority"] = true, true, true
		}
		for _, d := range defaultHeaders {
			if !have[d[0]] {
				req.Header.Set(d[0], d[1])
				order = append(order, d[0])
			}
		}
		var sorted []string
		for _, k := range headerOrder {
			for _, o := range order {
				if o == k {
					sorted = append(sorted, k)
				}
			}
		}
		for _, o := range order {
			known := false
			for _, k := range headerOrder {
				known = known || k == o
			}
			if !known {
				sorted = append(sorted, o)
			}
		}
		req.Header[fhttp.HeaderOrderKey] = sorted

		c := follow
		if in.Redirect == "manual" {
			c = manual
		}
		start := time.Now()
		resp, err := c.Do(req)
		if err != nil {
			log.Printf("fetch %s failed after %s: %v", u.Path, time.Since(start).Round(time.Millisecond), err)
			fail(w, 502, err.Error())
			return
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
		if err != nil {
			fail(w, 502, err.Error())
			return
		}
		log.Printf("fetch %s %s -> %d (%d bytes, %s)", method, u.Path, resp.StatusCode, len(data), time.Since(start).Round(time.Millisecond))

		out := fetchResponse{Status: resp.StatusCode, URL: resp.Request.URL.String(), Body: string(data)}
		for k, vs := range resp.Header {
			for _, v := range vs {
				out.Headers = append(out.Headers, [2]string{k, v})
			}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out)
	})

	log.Printf("royal road fetcher listening on %s", addr)
	log.Fatal((&http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}).ListenAndServe())
}

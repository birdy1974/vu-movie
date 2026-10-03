# MovieBox-TUI vs vu-movie: selection vs sniffing/fetching

Written after an hour-long side-by-side read of
[`mesamirh/MovieBox-TUI`](https://github.com/mesamirh/MovieBox-TUI) (Rust, v0.1.26, dual
MIT/Apache-2.0 — **not** Apache-only as an older comment in this repo claimed) and this
repo's `src/scrapers/*`, to answer one question:

> *"What is the difference between the **selection** and the **sniffing/fetching** for the
> selected movie? With this application it is not working."*

Short answer: **selection is the same idea in both apps; fetching is a completely different
machine.** MovieBox-TUI never sniffs a browser page and never lets the player talk to the CDN
directly. It resolves the chosen title through the signed REST API, then re-hosts the stream
through a local proxy sidecar that replays the auth headers and rewrites the DASH manifest.
vu-movie's resolve path (as the log in the question shows) is a headless-Chromium network
sniff of the third-party page, with MovieBox-by-title only as a fallback.

---

## 1. The two pipelines, step by step

### MovieBox-TUI — "select a title" (`search` → `details` → `episode_streams`)

| Step | What actually happens | Code |
|---|---|---|
| 1 | `POST /wefeed-mobile-bff/subject-api/search/v2` `{keyword,page,perPage:15,subjectType:0}` | `providers/moviebox/mod.rs:159` |
| 2 | User picks a row → `GET /subject-api/get?subjectId=…` for metadata | `mod.rs` |
| 3 | `play-info` **and** `resource` are fetched **in parallel** (`tokio::join!`) and their releases are unioned, deduped by `url.split('?')[0]` | `providers/moviebox/mod.rs:66-135` (`episode_streams`) |
| 4 | play-info streams → DASH `index.mpd` recovered from the `signCookie` (`Edge-Cache-Cookie: urlprefix=<b64>` or `CloudFront-Policy=<b64>`) | `adapt.rs:592` (`resolve_dash_manifest_from_policy`) |
| 5 | Resource rows → plain CDN links (`resourceLink`/`url`), filtered by season/episode and by `is_deprecation_notice_url()` | `adapt.rs:446,800` |

### MovieBox-TUI — "fetch/play the selected movie"

| Step | What actually happens | Code |
|---|---|---|
| 1 | Every DASH link is routed through a **local sidecar proxy**: `is_dash(url)` → `spawn_sidecar(url, headers, subtitle, max_height)` | `tui/app/playback.rs:336`, `proxy.rs:105` |
| 2 | The sidecar is a second copy of the same binary (`--proxy-for-vlc <url> <headers-json> …`), binds `127.0.0.1:<random>`, prints `PORT <n>` | `proxy.rs:105-172` |
| 3 | The player is handed `http://127.0.0.1:<port>/https/<original-url>` — **not** the CDN URL | `proxy.rs:160` |
| 4 | The sidecar fetches with `Referer` + Android UA always, and with **all** headers (incl. the signed `Cookie`) when the request targets the same host that was resolved | `proxy.rs:286` (`should_forward_header`) |
| 5 | It rewrites the DASH manifest to point every segment back at itself, drops representations above `max_height`, caches segments, fetches `init-stream*.m4s` + `chunk-stream*-00001.m4s` in a warmup pass, splits large m4s requests, and can serve the subtitle through `/sub/<encoded>` | `proxy.rs:614-900` |

Consequence: with the TUI, a MovieBox stream "just plays" in mpv/VLC even though the CDN
demands a signed cookie, because the cookie is injected **per request by the sidecar**, and
even though the manifest is a live DASH MPD, because the manifest is rewritten.

### vu-movie — "select a title"

Same as the TUI for MovieBox (`search/v2` → result cards; see `src/scrapers/moviebox.js`
and `test/moviebox.test.js`, whose fixtures are copied from the reference test-suite), and
plus a second lane: the seven site recipes in `src/scrapers/builtin-sources.json`
(overlook.cx, cinevo.nl, cinejoy.pk, flixhub.studio, redflix.club, 1flex.org, cinezo.st).
That lane works, which is what "the GUI is okay" reflects.

### vu-movie — "fetch the selected movie" (the part that fails)

`registry.resolveTarget()` (`src/scrapers/registry.js:576`) tries, in order:

1. **moviebox:// URL** → `play-info/v2` only (now play-info **+** `resource`, see §4).
2. **HTTP(S) page URL** → `browser.sniff(url)`: open the movie page in headless Chromium,
   click Play, and *watch the network* for `.m3u8` / `.mpd` / `.mp4` responses. This is a
   fundamentally different mechanism from the TUI: it depends on the site's third-party
   embed player being reachable **from the NAS**.
3. **MovieBox by title** — only when the sniff found nothing, and only while MovieBox's
   circuit breaker is closed.
4. Optional external extractor.

The log in the question is steps 2 + 3 both failing:

```
browser sniffing overlook.cx {url: https://overlook.cx/movies/1386315}
WARN browser no media found on overlook.cx after 45096 ms
     {finalUrl: about:blank, consoleErrors: [ERR_CONNECTION_REFUSED ×2],
      note: "page loaded but the embedded player is unreachable …"}
INFO  moviebox requesting a visitor token {startHost: https://api6.aoneroom.com}
ERROR http POST api6.aoneroom.com failed permanently {error: TypeError: fetch failed <- Error: Error}
… all six hosts, TLS layer …
ERROR moviebox visitor-login failed on every API host [fetch-failed:6]
WARN  scraper MovieBox title lookup failed (non-fatal)
INFO  scraper resolve finished: 0 unique candidate(s)
```

So two independent things are broken in that run:

* the **embed host** of the Overlook page refused the connection (and the tab had been
  replaced by `about:blank` — an ad pop-under, which vu-movie used to report as a bare
  "no media found"),
* the **MovieBox API edge** closed every TLS handshake, so there was no browser-free
  fallback left.

Neither is a signing/parsing bug: `npm test` proves byte-identical signatures and
cookie→MPD decoding against the reference fixtures.

---

## 2. Why the TUI's fetch path is more robust (the real differences)

| # | MovieBox-TUI | vu-movie (before this change) | Consequence |
|---|---|---|---|
| 1 | play-info **+** resource, in parallel | play-info only, `resource` as a retry at best | titles where play-info has no usable stream list → 0 candidates |
| 2 | one device identity (UA + `x-client-info` + spoofed `x-forwarded-for`) per client, reused for the token's lifetime | **new random identity on every request** while replaying the cached token | looks like token theft to an anti-abuse edge → 401/403s, "empty" results |
| 3 | token validity from the JWT `exp`/`userId` claims; 7-day ceiling | any token found on disk was reused forever | weeks-old token replayed on every search |
| 4 | `x-user` response header is parsed and adopted as a rotated token | ignored | kept using a stale token |
| 5 | on `HostsExhausted` (and on 401/403): invalidate session → re-login → retry once | only on 401/403 | a dead token could end a resolve |
| 6 | `parse_response` failure = host failure → next host | a `200` with HTML (WAF/block page) returned `data: null` and was treated as success | silent "0 results" instead of a host hop |
| 7 | deprecation/notice URLs by exact markers (`/notice.mp4`, three hashes, macdn `/other/`) | generic `deprecat|notice|unavailable` regex | missed real placeholders, dropped real files |
| 8 | DNS: system resolver **with fallback** to public resolvers (hickory + Cloudflare/Google/Quad9) | Node's system resolver only | filtered/absent DNS kills the whole MovieBox lane |
| 9 | DASH played through the local sidecar (header injection + manifest rewrite + segment prefetch) | hands the `.mpd` (with a `-headers` line) to ffmpeg | A DASH manifest whose *segments* need a signed cookie needs ffmpeg's DASH demuxer to forward the header — historically fragile; the TUI sidesteps the question entirely |
| 10 | TLS via rustls/`webpki-roots` | TLS via Node/OpenSSL (undici) | a JA3/fingerprint-based block can accept one and reject the other — see §5 |
| 11 | header pool includes `api6sg` (DNS-dead today) | removed in an earlier fix | cosmetic only: ENOTFOUND fails in ms |

Items 1–7 are protocol parity and are now implemented (see §4). Items 8–10 are transport
differences that cannot be fixed by "porting code" and are discussed in §5.

---

## 3. How to read the failure log

| Log line | Meaning | What to do |
|---|---|---|
| `browser … note: page loaded but its embedded player/CDN is unreachable — refused host(s): …` | the site loaded, the third-party embed did not | the embed is dead/geo-blocked, or the NAS cannot reach *that* host (DNS/firewall). vu-movie now names the host(s) |
| `blocked an off-site / blank main-frame navigation … (pop-under?)` + `replaced the tab … reloading it once` | an ad script hijacked the page (this is why `finalUrl` was `about:blank`) | nothing — the sniffer now recovers and retries once |
| `visitor-login failed on https://apiN.aoneroom.com — trying next host {kind: connection-reset}` | the API edge accepted TCP and closed during the TLS handshake | see the network check below |
| `MovieBox reachability diagnosis {verdict: …}` | the new probe verdict: `no-egress` / `tls-intercepted` / `dns-filtered` / `tls-or-ip-block` / `service-unreachable` | matches the table in §5 |
| `resolve finished: 0 unique candidate(s) — network check: …` | nothing worked, and the reason is spelled out | read the hint; it names the broken layer |

---

## 3b. Fetching fidelity report — "is our fetching code exactly the reference's?"

**No — and it cannot be, by construction.** MovieBox-TUI is a Rust binary that speaks the
API and re-hosts the CDN through a sidecar process; vu-movie is a Node app that runs a
headless browser for the other sites and hands streams to ffmpeg. What *can* be identical is
the **request layer**, and that now is:

| Fetch layer | Reference | vu-movie | Verdict |
|---|---|---|---|
| Visitor login, search, detail, season-info, play-info, resource, captions endpoints | `mod.rs` | same paths, same query building | ✅ identical |
| `x-client-token`, `x-tr-signature`, canonical string, secret, body hash/length | `crypto.rs` | same algorithm, unit-tested against reference fixtures | ✅ identical |
| `Accept`/`Content-Type`/`Connection: keep-alive`, `x-client-status: 0` | `build_signed_headers` | same six headers + UA | ✅ identical |
| UA string, `x-client-info` JSON shape, spoofed `x-forwarded-for` | `generate_client_info_and_ua` | same fields/space, **one identity per session**, persisted with the token | ✅ identical (behaviour) |
| Token lifecycle: JWT `exp`/`userId`, 7-day ceiling, `x-user` rotation, 401/403 + exhausted-host re-login, one retry | `session.rs`, `client.rs` | same | ✅ identical |
| Host sweep: order, sticky index, hop on transport error **and** retryable status, JSON parse failure = host failure, 429 `Retry-After` capped at 3 s, 50 ms breather | `request_hosts` | same | ✅ identical |
| play-info **+** resource union, per-episode filtering, placeholders filtered by the exact marker list | `episode_streams`, `is_deprecation_notice_url` | same (parallel + union + path dedupe) | ✅ identical |
| Media fetch: header injection on every manifest *and* segment request | sidecar proxy, per-request | ffmpeg `-headers` — verified on the wire to reach `/seg/*` requests too | ✅ equivalent for headers |
| DASH manifest rewriting, `max_height` filtering, segment cache/prefetch, ranged m4s, subtitle-through-proxy | sidecar (`proxy.rs`) | not ported: ffmpeg reads the live MPD directly; the relay is the single place headers are applied | ⚠️ deliberate divergence |
| DNS: system resolver **with public-resolver fallback** | hickory + Cloudflare/Google/Quad9 | system resolver only; public DNS is used for *diagnosis*, not for scraping | ⚠️ divergence (see below) |
| TLS: rustls/`webpki-roots` | rustls | Node/OpenSSL (undici) | ⚠️ divergence (see below) |
| Page sniffing | not implemented (never needed) | Chromium lane for the seven site sources | ➕ extra, not a difference in MovieBox fetching |

The two ⚠️ items are transport, not protocol: Node 22 exposes no supported way to override
the resolver used by `fetch`/`getaddrinfo` (the reference embeds a Rust resolver for exactly
that reason), and swapping the TLS stack would mean moving the API calls into Chromium's
network stack. Both are detectable now (`dns-filtered`, `tls-or-ip-block`, `tls-intercepted`
verdicts) and the operator fixes are `dns:` / `NODE_EXTRA_CA_CERTS` *plus* the
automatically-attempted workarounds in §5 (proxy + Chromium BoringSSL fallback, and the
expanded `h5-api` mirror pool).

## 4. What changed in vu-movie for this comparison

* `src/scrapers/moviebox.js`
  * play-info **+** `resource`, in parallel, unioned and deduped by manifest path
    (`findStreamsByTitle`, `releasesFromResources`).
  * one persisted device identity per visitor token (`identity()` / `resetIdentity()`).
  * JWT-aware sessions: `parseJwtClaims`, `sessionIsValid`, `expiresAt` on disk.
  * `x-user` token rotation adopted on every response.
  * host-hop on an unparseable `200` body (WAF pages) instead of "0 results".
  * one fresh-token retry when every host answered with an error status.
  * the reference client's exact deprecation markers.
  * richer `classifyFetchError` that walks the whole `cause` chain (no more
    `Error: Error`) and recognises TLS interception.
* `src/scrapers/diagnostics.js` *(new)* — on a failed resolve: control-host egress probe +
  system-vs-public DNS cross-check, cached for a minute, rendered as one verdict and one
  actionable hint (`DIAGNOSE_ON_FAILURE`, `DNS_CHECK_SERVERS`).
* `src/scrapers/browser.js` — the sniffer now (a) names the refused embed hosts, (b) blocks
  main-frame `about:blank`/off-site hijacks and reloads once, so `finalUrl: about:blank`
  no longer ends the story with "no media found", and (c) applies per-site `mediaPatterns`
  from the recipe, so an extension-less DASH endpoint is still recognised.
* `src/streams/store.js` + `src/http/server.js` + `public/app.js` — `/s/<token>/direct`
  (a 302 to the CDN) is no longer offered for sources that need request headers (signed
  cookie / `x-*`), because a redirect cannot replay them: the reference client never hands a
  bare CDN URL to a player either. The relay URL is always offered and always works.
* `src/scrapers/http.js` — `undici.ProxyAgent` support for `MOVIEBOX_PROXY` / `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` (with `NO_PROXY` bypass) so an SNI-filtered ISP can be bypassed via a forward proxy/VPN; Chromium is also launched with `--proxy-server` when a proxy is set.
* `src/scrapers/moviebox.js` — `MOVIEBOX_EXTRA_HOSTS`; automatic fallback to `fetchViaBrowser` (Chromium BoringSSL, different JA3) on `tls-or-ip-block`; richer `classifyFetchError` (TLS before reset) and proxy-aware diagnostics hints; and a **second transport** for the *web* BFF (see §6) used when the mobile edge never answers.
* Tests: 26 MovieBox tests, 3 diagnostics, 5 wire-level parity tests (116 total — now with proxy/host-pool and web-BFF coverage).

What was deliberately **not** ported: the full sidecar proxy (ffmpeg already re-requests segments
with `-headers`, and the relay is the single place headers are applied; the Chromium fallback
for the *API* itself — `fetchViaBrowser` with BoringSSL + `ProxyAgent` — is now ported), and the Rust DNS
crate (see §5). `MOVIEBOX_EXTRA_HOSTS` extends the mobile host pool beyond the original six
`api*` hosts; the web (H5) BFF is a separate transport, not a mirror of it — see §6.

---

## 5. If it still fails on your NAS: identify the layer

The verdict from `diagnoseReachability` tells you which of these you are in:

| verdict | What it means | Fix |
|---|---|---|
| `no-egress` | the container cannot reach *any* third-party host (both the failing host **and** the control hosts are dead) | fix the Docker network: `docker compose exec vu-movie getent hosts api6.aoneroom.com`, DNS server of the NAS, firewall, or a missing proxy/VPN. Nothing in the scraper can help |
| `tls-intercepted` | a proxy/AV/gateway re-signs TLS and Node does not trust its CA (Node ships its own CA bundle) | add `NODE_EXTRA_CA_CERTS=/path/to/proxy-ca.pem` to the container, or set `HTTP_PROXY` to bypass it; Chromium's `ignoreHTTPSErrors` also helps for the browser fallback |
| `dns-filtered` | the container's resolver answers differently from public DNS (ISP blocklist, Pi-hole, Synology DNS Server, ControlD…) | point the container at `1.1.1.1`/`8.8.8.8` (`dns:` in `docker-compose.yml`), or enable the reference client's trick of a public-resolver fallback |
| `tls-or-ip-block` | DNS is fine and the container has internet, but the MovieBox edge closes the handshake | SNI/IP-level filtering, ISP blocking, or JA3 fingerprinting. **Now automatically mitigated in three layers:** (1) `MOVIEBOX_PROXY` / `HTTP_PROXY` / `HTTPS_PROXY` (forward proxy/VPN outside the block; supports `NO_PROXY`), (2) `MOVIEBOX_BROWSER_FALLBACK=true` (default) retries the same signed request via Chromium BoringSSL (different JA3, plus `--proxy-server` support), (3) **the web (H5) BFF transport** (§6) re-runs the search on completely different hosts. `MOVIEBOX_TRANSPORT=h5` skips straight to (3). If all else fails, route the container through a VPN/other egress |
| `service-unreachable` | MovieBox itself is down or has rotated its host pool | wait, add a new mirror via `MOVIEBOX_EXTRA_HOSTS` or update `HOST_POOL` |

Remember that MovieBox-TUI and vu-movie run the *same* protocol here: if
`tls-or-ip-block` is the verdict, the TUI would fail too unless its TLS/DNS stack is the
thing being accepted. Testing the reference client from the same NAS is the cheapest way to
tell those apart:

```bash
# on the NAS (or in the container), with the TUI binary available:
moviebox-tui --help          # then search for the same title
# if the TUI plays it while vu-movie gets TLS resets, the difference is the client stack
# (rustls vs OpenSSL, hickory vs the system resolver) — say so and the port can be extended.
```

---

## 6. Legal / attribution

The MovieBox-TUI protocol was reverse-engineered by its authors and is dual-licensed
MIT/Apache-2.0; the endpoints, signing scheme, cookie handling and deprecation markers
re-implemented here are credited to them. vu-movie remains a personal proxy for streams you
are allowed to watch — see the README's *Legal / etiquette* section.

---

## 6. Two backends, not one: mobile BFF vs web (H5) BFF

MovieBox runs two different backends, and only one of them is what MovieBox-TUI speaks:

| | mobile BFF | web (H5) BFF |
|---|---|---|
| hosts | `api6/api5/api4/api4sg/api3.aoneroom.com`, `api.inmoviebox.com` | `h5-api.aoneroom.com`, and the public sites (`movieboxhd.net`, `movieboxonline.net`) which proxy the same BFF |
| prefix | `/wefeed-mobile-bff` | `/wefeed-h5api-bff` |
| who uses it | the Android app, and MovieBox-TUI | the website player |
| auth | `POST /user-api/visitor-login` → `token` in the body | `POST /subject/search-suggest` → anonymous JWT in the **`x-user` response header** |
| token clock | `X-Client-Token: <ms>,<md5(reverse(ms))>` | `X-Client-Token: <seconds>,<md5(reverse(seconds))>` |
| search | `POST /subject-api/search/v2` | `POST /subject/search` `{keyword, page, perPage: 0, subjectType: 0}` |
| playback | `/subject-api/play-info/v2` (+ `/subject-api/resource`) | `/subject/play?subjectId=…&se=…&ep=…&detailPath=…` (fallback `/subject/download`, which only answers on the *site* domain) |
| titles addressed by | `subjectId` | `detailPath` |

This matters because the two host groups do **not** fail together. In the log that prompted
§6, every `apiN.aoneroom.com` host died in the TLS handshake — and `h5-api.aoneroom.com`,
`h5.aoneroom.com` and `i-api.aoneroom.com` completed the handshake and answered **HTTP 404**.
That 404 was the diagnosis: they were never broken mirrors of the mobile BFF, we were just
knocking on them with the mobile path. (vu-movie used to list them as extra mirrors, which
bought a 12-second timeout per sweep per host and nothing else — they are not in the mobile
pool any more.)

vu-movie therefore keeps the reference client's protocol as the **primary** transport and adds
the web BFF as an automatic fallback:

```
search("dune")
   └─ mobile BFF  ── TLS-reset on every host ──▶ err.movieboxTransport = true
         └─ web (H5) BFF on h5-api.aoneroom.com, then the site mirrors
               ├─ POST /subject/search-suggest   → JWT from the x-user header
               ├─ POST /subject/search           → rows (each keeps its detailPath)
               └─ GET  /subject/play?…           → candidates
```

Rules: the fallback only fires when **no host answered at the HTTP layer** (a transport-level
block). An HTTP 401/404/5xx is a protocol answer and switching transports would only hide it.
`MOVIEBOX_TRANSPORT=h5|mobile|auto` (default `auto`) overrides the order; after a failed sweep
the web BFF is tried first so a blocked NAS does not pay for another doomed host sweep on every
search. Playback keeps the same rule: `resolveTarget()` tries mobile play-info first and only
asks the web BFF when that produced nothing.

Streams from the web BFF are `/subject/play` rows (`resolutions`, `size`, `codecName`,
`vipLocked`); VIP-locked rows carry no URL and are dropped rather than offered as dead mirrors.
The CDN checks the Referer the browser would send, so candidates carry
`Referer: https://movieboxhd.net/play/<detailPath>`.

### Checking from the NAS whether the web BFF is reachable at all

```bash
docker compose exec vu-movie curl -sS -i --max-time 20 -X POST \
  'https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/search-suggest' \
  -H 'Content-Type: application/json' -H 'X-Client-Token: 1,c4ca4238a0b923820dcc509a6f75849b' \
  -d '{"keyword":"dune","perPage":10}' | head -20
```

* `200` **and** an `x-user:` header → the web backend answers from this network; the app will
  use it as soon as the mobile edge fails (look for `web (H5) BFF: anonymous token acquired`).
* connection reset / timeout here too → both MovieBox backends are filtered on this egress; use
  `MOVIEBOX_PROXY` or a VPN.
* `404` → right host group, wrong prefix (that is the bug this section documents).


### One caveat when you set a proxy

A proxy is for *outbound* traffic only. `src/scrapers/http.js` therefore bypasses it for internal
service names — hostnames without a dot, i.e. Docker Compose and Kubernetes service names such as
`flaresolverr`, `db` or `vu-movie` (plus loopback and anything in `NO_PROXY`). Without that, setting
`MOVIEBOX_PROXY` to reach MovieBox would also send the container-to-container FlareSolverr call out
through the proxy, where `flaresolverr` cannot resolve.

# Second factor after Google sign-in — design

Date: 2026-10-13. Status: approved in chat, spec for `superpowers:writing-plans`.

## Intent

The console is gated by Google sign-in only: Caddy's `(gauth)` snippet calls oauth2-proxy on
every request, and a 7-day cookie on `.{{DOMAIN}}` then opens the dashboard, every `/term`
terminal, the vnc watch browser, the droid console and the sandbox on all hostnames. A
logged-in Google browser or a stolen oauth2-proxy cookie therefore owns every live
session on the box. This adds one more challenge, a TOTP code from an authenticator app,
enforced by Caddy before any upstream is reached, on every hostname that imports
`(gauth)`, with no new gaps.

Decided in chat: TOTP (not passkeys), 7-day second-factor cookie per browser, no
recovery codes (re-enrol over SSH), the two paths already outside the Google gate
(`/wh/*` webhooks, PWA statics) stay outside.

## 1. The gate: Caddy

`(gauth)` gains three things, in this order, after the existing Google `forward_auth`:

```caddyfile
(gauth) {
    header { ... unchanged ... }
    # only Caddy may assert the signed-in email: drop whatever the client sent
    request_header -X-Auth-Request-Email
    reverse_proxy /oauth2/* 127.0.0.1:4180
    forward_auth 127.0.0.1:4180 { ... unchanged ... }
    # the challenge page and its check: reachable with the Google cookie alone
    handle /2fa/* {
        reverse_proxy 127.0.0.1:3005
    }
    handle /2fa {
        reverse_proxy 127.0.0.1:3005
    }
    # the second gate: 200 with a valid mows_2fa cookie for this email, 401 otherwise
    forward_auth 127.0.0.1:3005 {
        uri /2fa/auth
        @bad status 401
        handle_response @bad {
            redir * https://{{DOMAIN}}/2fa?rd={scheme}://{host}{uri}
        }
    }
}
```

- `forward_auth` sends the request's headers to the auth upstream, so the second gate
  sees the `X-Auth-Request-Email` the first gate copied in. The `request_header` line
  above makes that header trustworthy: a client cannot pre-set it.
- Caddy's `forward_auth` forwards the original `Cookie` header, so the websocket upgrade
  on `/term/ws` and the vnc stream pass the gate like any page.
- `/2fa` is anchored on the apex like `/oauth2/start`: one cookie on `.{{DOMAIN}}` covers
  every subdomain, and `rd` carries the user back to the hostname they started on.
- `(gauth)` is imported by every vhost, so nothing per site changes. The repo template
  (`infra/caddy/Caddyfile.template`) and the live `/etc/caddy/Caddyfile` (which has more
  vhosts than the template) both get the same snippet edit; the live one is validated
  with `caddy validate` before `systemctl reload caddy`.
- Dashboard restart during a deploy: the second gate answers 502 for a second, Caddy's
  `forward_auth` treats a non-2xx as a failure, so requests during that second fail
  closed. Acceptable, and the same window the dashboard proxy already has.

## 2. The service: `infra/dashboard/routes/twofa.mjs`

Mounted in `lite.mjs`'s dispatch, before the `/app` views:

| route | method | behaviour |
|---|---|---|
| `/2fa/auth` | GET | 200 empty when the `mows_2fa` cookie verifies for the request's `X-Auth-Request-Email`, else 401 empty. No HTML, no redirect: Caddy does that. |
| `/2fa` | GET | the challenge page. Shell tokens (`web/tokens.css` palette), one numeric input (`inputmode=numeric autocomplete=one-time-code`), a submit, the error line. `rd` is echoed into a hidden field. An email with no secret gets a 403 page: "not enrolled, run `2fa enroll` on the box". |
| `/2fa` | POST | form body `code`, `rd`. Checks the code, sets the cookie, 303 to `rd` when `rd` is `https://` on the request's host or a subdomain of it (or a same-origin path), else to `/`. Wrong code: 401 and the page with the error. Cross-site POST (Origin/Referer on another host): 403. |

TOTP (RFC 6238 over RFC 4226): HMAC-SHA1 of the 8-byte big-endian counter
`floor(now/30)`, dynamic truncation, 6 digits, zero-padded. Steps `-1, 0, +1` accepted.
Comparison with `timingSafeEqual` on the padded strings. The secret is 20 random bytes,
stored and displayed base32 (RFC 4648, no padding), which is what authenticator apps
read from an `otpauth://` URI.

Replay: the last accepted counter per email and secret is kept in memory; a code equal
to or older than it is refused, so one captured code cannot be used twice within its
window, and a freshly re-enrolled app's first code is not refused by the old secret's state.

Brute force: five wrong codes for one email within five minutes lock that email for
five minutes (in memory, cleared on restart). Lockout answers 429 with the page and
"try again in N min".

Cookie `mows_2fa`: value `<email>.<expiry-unix>.<hmac-sha256-hex of "email.expiry">`,
keyed by the 32-byte `key` from the secrets file; attributes `Secure; HttpOnly;
SameSite=Lax; Path=/; Domain=.{{DOMAIN}}; Max-Age=604800` (7 days). Verification: three
fields, hmac equal (`timingSafeEqual`), expiry in the future, email equal to the
`X-Auth-Request-Email` header. A cookie minted for one Google account is worthless
under another. There is no domain setting: Caddy sends every challenge to
`https://{{DOMAIN}}/2fa`, so the page and its POST run on the apex and the request's own
`Host` is the domain (the cookie's `Domain`, the `rd` allowlist, the page's CSP). `Secure`
and `Domain` are set only when Caddy says `X-Forwarded-Proto: https`; a dev instance on
loopback gets a host-only cookie.

`rd` arrives exactly as Caddy writes it, `rd={scheme}://{host}{uri}`, unescaped, so a
`/term/?arg=..&arg=..` target runs on past the first `&`: the page takes the query after
`?rd=` raw rather than as one parameter. The page's CSP widens `form-action` to
`https://{{DOMAIN}} https://*.{{DOMAIN}}`, because Chrome holds the redirect after a form
POST to `form-action` and the base policy says `'self'`.

The email is always `X-Auth-Request-Email` as Caddy sets it, lower-cased. A request
reaching these routes with no such header (a dev instance with no Caddy) is treated as
`dev@localhost` only when `MOWS_TEST_HOOKS=1`; otherwise 401.

## 3. Secrets and enrolment

File `/opt/claude-dashboard/2fa.json`, mode 0600, root-owned (the dashboard runs as
root and already keeps `vapid.json` the same way; `scripts/deploy-dashboard.sh` installs
listed files and never deletes others, so the file survives deploys):

```json
{ "key": "<64 hex>", "users": { "<email>": { "secret": "<base32>", "enrolledAt": "<iso>" } } }
```

`key` is generated on the first read that finds none. Dev instances point the file
elsewhere with `--2fa-file`, default `path.join(path.dirname(SETTINGS_FILE), '2fa.json')`.

CLI, run over SSH as root (positional args, handled at the top of `lite.mjs` before the
server starts; `args` is already `process.argv.slice(2)`):

```
node /opt/claude-dashboard/lite.mjs 2fa enroll <email>   # (re)creates the secret, prints the otpauth URI + base32 secret
node /opt/claude-dashboard/lite.mjs 2fa revoke <email>   # removes the secret: that account is locked out until re-enrolled
node /opt/claude-dashboard/lite.mjs 2fa list             # emails and enrolledAt, never secrets
```

URI: `otpauth://totp/mows:<email>?secret=<base32>&issuer=mows&algorithm=SHA1&digits=6&period=30`.
No QR rendering: the box has no `qrencode`, and one account types the secret once.
Re-enrolling rotates the secret; existing `mows_2fa` cookies stay valid until expiry
(the cookie key is separate), which is the intended "lost phone, still logged in on the
laptop" path. `revoke` also rotates `key`, which logs every browser out of the second
factor at once.

## 4. Failure modes

| case | behaviour |
|---|---|
| secrets file unreadable / unparsable | `/2fa/auth` answers 401 for everyone (fail closed), the error is logged once per minute |
| email on the Google allowlist, not enrolled | 403 page, never a bypass |
| clock drift on the box or phone | ±1 step (30 s) tolerated; beyond that the code is simply wrong |
| `rd` points off-site | ignored, redirect to `/` |
| cookie from another email, expired, or tampered | 401, back to the page |

## 5. Testing

- `scripts/twofa-logic-check.mjs` (added to `scripts/manifest.txt`, run by preflight like
  `grid-logic-check.mjs`): TOTP against the RFC 6238 SHA-1 test vectors, base32
  round-trip, cookie mint/verify, cross-email reject, expiry reject, lockout after five
  misses, replay reject.
- Probe `docs/qa/probes/twofa-check.mjs <engine>` against a dev instance
  (`MOWS_TEST_HOOKS=1 node infra/dashboard/lite.mjs --port 3105 --host 127.0.0.1 --ui=next --2fa-file <scratch>`),
  which enrols `dev@localhost` through the CLI into the scratch file: `/2fa/auth` 401
  without a cookie; `/2fa` renders; a wrong code shows the error; the right code
  (computed in the probe from the scratch secret) sets the cookie and redirects to `rd`;
  `/2fa/auth` 200 with the cookie; a screenshot of the page read as an image.
- Live, after deploy and Caddy reload: `curl -sI https://{{DOMAIN}}/`, `/term/`, `/vnc/`,
  `https://sandbox.{{DOMAIN}}/` with only a Google cookie → 302 to `/2fa`; without any
  cookie → 302 to `/oauth2/start` (unchanged). Then the real flow in a browser: Google →
  `/2fa` → code → back to the grid, the `/term` panes connect, and a second subdomain
  opens without a new challenge. That browser run is the user's manual gate.

## Out of scope, by decision

Passkeys / WebAuthn, "trust this device for 30 days", an enrolment UI in the dashboard,
recovery codes, per-request step-up for destructive actions. Each sits on top of this
gate without changing it.

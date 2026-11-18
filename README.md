# Patchright Stealth Browser — OpenClaw plugin

An OpenClaw plugin that adds an **interactive, stealth browser** driven by
[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) ([Node package](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs)) (a patched Playwright that
closes the `Runtime.enable` / `navigator.webdriver` CDP leaks). It launches **real Google Chrome**
via `launchPersistentContext` — the only path on which Patchright's stealth patches actually apply —
so it can read sites behind bot detection (DataDome / Cloudflare / Akamai) that block OpenClaw's
native (CDP-attach) browser.

## Why a separate browser

OpenClaw's native browser attaches to Chrome over CDP (`connectOverCDP`), which **bypasses
Patchright's patches entirely**. To get the stealth, Patchright must *launch* the browser itself —
hence this dedicated, separate browser instance. Use the native `browser` tool for ordinary sites;
use these `stealth_*` tools when a site fingerprints or challenges automation.

## Tools

Every tool takes an optional `session` name. Omit it for the agent's default browser; pass a name
(e.g. `"checkout"`) for an extra, separate browser of the same agent:

| Tool | Purpose |
|------|---------|
| `stealth_open`     | Launch a browser with a **proxy** (`proxyProfile` from config, or inline), display-only Chrome `args`, `locale`/`timezoneId`/`geolocation` |
| `stealth_navigate` | Open/navigate to a public http(s) URL, or a `file://` URL inside the agent's workspace |
| `stealth_content`  | Read page text (or HTML) |
| `stealth_click` / `stealth_fill` / `stealth_type` / `stealth_press` | Interact (Playwright selectors) |
| `stealth_wait`     | Wait for selector / load state / URL / delay |
| `stealth_evaluate` | Run JS in the page (isolated world by default, `mainWorld: true` for page globals), return the result |
| `stealth_screenshot` | Save a screenshot (default `~/.openclaw/media/patchright/`; custom paths only inside the agent's workspace) |
| `stealth_box`      | Element bounding box (for computing drag/mouse targets) |
| `stealth_mouse_move` / `stealth_mouse_button` | Low-level trusted mouse control |
| `stealth_drag`     | Trusted press-move-release drag (DataDome / slider captchas) |
| `stealth_hover`    | Hover an element or coordinates |
| `stealth_cookies_get` / `stealth_cookies_set` / `stealth_cookies_clear` | Export (incl. **httpOnly**) / import / clear cookies |
| `stealth_status`   | List the calling agent's browsers / inspect one |
| `stealth_close`    | Close one browser (or all of the calling agent's) |

A bundled skill (`skills/patchright-stealth/SKILL.md`, surfaced to the model) tells each agent when
to reach for these tools.

## Per-agent isolation

The OpenClaw gateway is one shared process, so the plugin loads once and is shared by every agent.
Every tool is built per run from the host tool context, so the plugin knows the **calling agent id**
without trusting model arguments. A browser is keyed by `(agentId, session)`:

| Agent | `session` | Profile folder (`~/.openclaw/browser/…`) |
|-------|-----------|-------------------------------------------|
| `buyer` | omitted or `"buyer"` | `patchright-stealth-profile-buyer` |
| `buyer` | `"buyer-checkout"` or `"checkout"` | `patchright-stealth-profile-buyer-checkout` |
| `main` | `"bookings"` | `patchright-stealth-profile-main-bookings` |

Names that already start with the agent id are kept, everything else gets the agent id as a prefix,
so an agent can never open, read cookies from, list, or close another agent's browser. A session
name that would fall into a longer agent id's namespace (agent `shop`, session `us-x`, while an agent
`shop-us` exists) is refused. Tools are not offered at all when the host supplies no agent id.

All browsers are closed when the plugin instance is disposed (hot reload, replacement, gateway
shutdown), so no orphaned Chrome keeps a profile locked.

## Network and file access

Stealth browsers load public websites and the calling agent's own workspace files, nothing else:

- **URLs:** only `http`/`https` (plus `about:blank`). `file:`, `chrome:`, `view-source:` and other
  schemes are refused.
- **Addresses:** loopback, private (RFC 1918), link-local (including cloud metadata at
  `169.254.169.254`), CGNAT, multicast, reserved and IPv6 local ranges are blocked, in every spelling
  (`127.1`, `2130706433`, `[::ffff:127.0.0.1]`, NAT64/6to4 embeddings, hostnames that resolve to
  them, `localhost`/`*.localhost`). This applies to every request a page makes, not only
  `stealth_navigate`: subresources, `fetch`, iframes, popups and page-initiated navigations.
- **Redirects:** Chrome follows redirects itself, so a redirect hop to a blocked address is detected
  as it happens rather than prevented. The page is cleared to `about:blank` and the tool call fails
  with the blocked URL; any result read during that call is discarded.
- **Workspace files:** `stealth_navigate { url: "file:///…/workspace/card.html" }` works when the file
  (after resolving symlinks) is inside the agent's workspace. Chrome never opens `file://` itself:
  the plugin serves the workspace from the virtual origin `http://workspace.patchright.invalid/`, so
  relative CSS, images and scripts load, and nothing outside the workspace is reachable.
- **Chrome flags:** `stealth_open { args }` accepts only `--window-size`, `--window-position`,
  `--force-device-scale-factor`, `--lang`, `--start-maximized`, `--start-fullscreen`,
  `--hide-scrollbars`, `--mute-audio`, `--force-dark-mode` and `--disable-notifications`.
- **Inline proxies** (`stealth_open { proxy }`) may not point at a local or private address. A proxy
  running on the gateway host goes in the plugin config as a `proxyProfile`.

An operator can open specific local services, or the whole private network, in the plugin config
(see below). WebSocket connections and requests made by service workers are not intercepted, and
addresses are checked when a request is made, so DNS rebinding can still race the check. For hard
isolation, also run Chrome behind an egress firewall or proxy.

## Config (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `PATCHRIGHT_CHANNEL` | `chrome` | Chrome channel / `executablePath` |
| `PATCHRIGHT_HEADLESS` | unset (headful) | set `1` to run headless (more detectable) |
| `PATCHRIGHT_PROFILE_ROOT` | `~/.openclaw/browser` | where per-session profiles live |

## Plugin config

### Local services

```json
"plugins": { "entries": { "patchright-stealth": { "enabled": true, "config": {
  "allowedPrivateHosts": ["localhost:5173", "192.168.1.20"]
} } } }
```

`allowedPrivateHosts` takes `host` or `host:port` entries (IPv6 as `[::1]:8080`).
`"allowPrivateNetwork": true` lifts the address block for all agents; only `http`/`https` stays enforced.

### Proxy profiles

Keep proxy credentials out of tool arguments (and transcripts) by naming proxies in the plugin's
config entry in `openclaw.json`, with the password in a gateway environment variable:

```json
"plugins": { "entries": { "patchright-stealth": { "enabled": true, "config": {
  "proxies": {
    "uk-resi": { "server": "http://proxy.example:8000", "username": "user", "passwordEnv": "UK_RESI_PROXY_PASSWORD" }
  }
} } } }
```

Agents then call `stealth_open { proxyProfile: "uk-resi", timezoneId: "Europe/London", locale: "en-GB" }`.
Inline `proxy: { server, username, password }` still works.

## Limits

- Every wait/timeout a model can request is capped at 120 s; tool calls honour the run's abort signal.
- Page-derived results (`navigate`, `content`, `evaluate`, `cookies_get`, `status`) are marked as network
  content, like the native browser tool, so the host treats them as untrusted.
- Every tool declares an `outputSchema`, so Code Mode and Tool Search know result shapes up front.

## Upgrading from 0.4.1

0.4.2 enforces the network and file rules above. Agents that opened `file://` pages outside their
workspace, local or private addresses, or passed other Chrome flags will now get an error. Add the
services they need to `allowedPrivateHosts`.

## Upgrading from 0.3

0.4 stores each browser under the calling agent's id. Profiles created by 0.3 under a bare session name
(`patchright-stealth-profile-<session>`) are not picked up automatically. To keep their logins, stop the
gateway (or close all stealth browsers) and rename each folder in `~/.openclaw/browser/` to
`patchright-stealth-profile-<agentId>-<session>`, using the agent that owns it. Profiles already named
after an agent (`patchright-stealth-profile-<agentId>…`) need no change.

`stealth_navigate` now returns `httpStatus` instead of `status`.

## Build & install

From ClawHub:

```bash
openclaw plugins install @websirnik/patchright-stealth-browser
openclaw gateway restart
```

From source:

```bash
npm install
npm run build
openclaw plugins install --link .   # local dev
openclaw gateway restart
```

Verify stealth against fingerprint pages:

```bash
node stealth-check.mjs   # opens bot-detector.rebrowser.net + bot.sannysoft.com, prints signals
```

## Caveats

Patchright fixes browser-side leaks, but bot detection also weighs **IP reputation, TLS/JA3, and
behavior**. This is not a guaranteed bypass — slow down, use real waits, and respect site terms.
Requires Google Chrome installed (uses `channel: "chrome"`). Console API is disabled under
Patchright, so in-page `console.*` won't surface — return values from `stealth_evaluate` instead.
`stealth_evaluate { mainWorld: true }` can read page globals but runs where the site's own scripts can
observe it; keep the default isolated world unless you need page state.

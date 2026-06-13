# Patchright Stealth Browser — OpenClaw plugin

An OpenClaw plugin that adds an **interactive, stealth browser** driven by
[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs) (a patched Playwright that
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

All interactive tools require a `session` key (pass your agent name → isolated Chrome + profile):

| Tool | Purpose |
|------|---------|
| `stealth_navigate` | Open/navigate to a URL |
| `stealth_content`  | Read page text (or HTML) |
| `stealth_click` / `stealth_fill` / `stealth_type` / `stealth_press` | Interact (Playwright selectors) |
| `stealth_wait`     | Wait for selector / load state / URL / delay |
| `stealth_evaluate` | Run JS in the page, return the result |
| `stealth_screenshot` | Save a screenshot |
| `stealth_box`      | Element bounding box (for computing drag/mouse targets) |
| `stealth_mouse_move` / `stealth_mouse_button` | Low-level trusted mouse control |
| `stealth_drag`     | Trusted press-move-release drag (DataDome / slider captchas) |
| `stealth_hover`    | Hover an element or coordinates |
| `stealth_cookies_get` / `stealth_cookies_set` / `stealth_cookies_clear` | Export (incl. **httpOnly**) / import / clear cookies |
| `stealth_status`   | List sessions / inspect one |
| `stealth_close`    | Close a session (or all) |

A bundled skill (`skills/patchright-stealth/SKILL.md`, surfaced to the model) tells each agent when
to reach for these tools and to pass `session: "<its-own-name>"`.

## Per-session isolation

The OpenClaw gateway is one shared process, so the plugin loads once and is shared by every agent.
Each distinct `session` value gets its **own** Chrome instance and persistent profile at
`~/.openclaw/browser/patchright-stealth-profile-<session>`, so agents never collide.

## Config (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `PATCHRIGHT_CHANNEL` | `chrome` | Chrome channel / `executablePath` |
| `PATCHRIGHT_HEADLESS` | unset (headful) | set `1` to run headless (more detectable) |
| `PATCHRIGHT_PROFILE_ROOT` | `~/.openclaw/browser` | where per-session profiles live |

## Build & install

```bash
npm install
npm run build
openclaw plugins install --link .   # local dev
openclaw daemon restart
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

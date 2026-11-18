---
name: patchright-stealth
description: Use when a site has bot detection (DataDome, Cloudflare, Akamai, "verify you are human" / challenge pages) or when OpenClaw's native browser gets blocked, captcha'd, or flagged. Drives a real-Chrome stealth browser via the stealth_* tools.
user-invocable: false
---

# Patchright Stealth Browser

Use the `stealth_*` tools (not the native `browser` tool) for sites that fingerprint or
challenge automation. They drive real Google Chrome launched by Patchright, which closes the
`Runtime.enable` / `navigator.webdriver` leaks that get the native browser blocked.

## Your browsers (`session`)

Every tool takes an optional `session`. **Omit it** to use your own default browser. Pass a short name
(e.g. `session: "checkout"`) when you need an extra, separate browser with its own cookies and login.
Browsers are private to your agent: the plugin knows which agent is calling, so you cannot open or
read another agent's browser, and they cannot open yours. Reuse the same `session` name across calls
to keep your tabs, cookies, and login state. Results echo the resolved name (your agent id is added as
a prefix when the name doesn't already start with it, e.g. `checkout` → `<agent>-checkout`); either
form works on later calls.

## When to use vs. the native browser

- **Use `stealth_*`** when: the URL is behind DataDome/Cloudflare/Akamai, you hit a captcha or
  "verify you are human" page, or the native browser returns blocked/empty content on a site.
- **Use the native `browser` tool** for everything else — it has richer snapshots and is fine for
  sites without bot detection. The stealth browser is a separate instance; the two do not share tabs.

## Operating loop

1. `stealth_navigate { url }` — opens/reuses your browser and loads the page.
2. `stealth_wait { selector | state:"networkidle" | ms }` — let the page settle (challenge
   pages and SPAs need this). Waits are capped at 120 s.
3. `stealth_content {}` — read visible text (or `html:true`) to see what's there.
4. Interact: `stealth_click`, `stealth_fill`, `stealth_type` (key-by-key, more human),
   `stealth_press`. Selectors are Playwright-style: CSS (`button#login`), text (`text=Sign in`),
   or role (`role=button[name="Submit"]`).
5. Extract structured data with `stealth_evaluate { expression }`. It accepts an expression, several
   statements (the last value is returned), or a function literal like `() => [...]` (it is called).
   It runs in an isolated world: it sees the DOM but not the page's JS globals. Add `mainWorld: true`
   only when you need page state such as `window.__NEXT_DATA__` (slightly more observable). In-page
   `console.*` will NOT appear — return values instead.
6. `stealth_screenshot {}` when you need to see the page or prove a result. It saves under
   `~/.openclaw/media/patchright/` by default; a custom `path` must be inside your workspace
   (relative paths resolve there).
7. `stealth_status {}` lists your open browsers; `stealth_status { session }` inspects one.
8. `stealth_close {}` when finished (or `{ all: true }` for all of yours), to release the profile lock.
   Leave it open if you'll return soon — the profile persists on disk either way.

## Slider / drag challenges (e.g. DataDome)

The mouse tools dispatch **trusted** input (what anti-bot systems check for), so use them — not JS
clicks — for slider puzzles:

1. `stealth_box { selector }` to get the handle's `{centerX, centerY, width}` — or take a
   `stealth_screenshot` and read coordinates visually (works even when the slider is in an iframe,
   since drag uses viewport coordinates).
2. `stealth_drag { fromX, fromY, toX, toY, steps, holdMs, settleMs }` to drag the handle.
   Use a generous `steps` (e.g. 25–40) and small `holdMs`/`settleMs` for a human-like motion. If the
   track length is unknown, drag toward the right edge of the slider container and let it snap.
3. For finer control, compose `stealth_mouse_move` + `stealth_mouse_button` yourself.

## Cookies

`stealth_evaluate("document.cookie")` only sees JS-readable cookies — it **cannot** see `httpOnly`
session cookies. To export a full session (e.g. after solving a challenge, to hand cookies to
another system): use `stealth_cookies_get {}`, which returns every cookie with full
attributes. Use `stealth_cookies_set` to import a session, `stealth_cookies_clear` to reset.

## Proxies & geo (stealth_open)

To route a browser through a proxy, call `stealth_open` **before** the first `stealth_navigate`.
Prefer a named proxy from the plugin config, so no password passes through your tool call:

```
stealth_open { proxyProfile: "uk-resi", timezoneId: "Europe/London", locale: "en-GB" }
```

If no profile fits, an inline proxy still works:
`stealth_open { proxy: { server: "http://host:port", username, password }, ... }`.

- **Match `timezoneId`/`locale` (and `geolocation` if set) to the proxy's country** — a timezone-vs-IP
  mismatch is itself a bot signal, so a proxy with a mismatched timezone can hurt more than help.
- Proxy and launch options are **fixed once the browser opens**. To change them, `stealth_close` then
  `stealth_open` again.
- Put extra Chrome flags (e.g. window size/position) in `args`.
- **User-Agent is intentionally not overridable** — Patchright's real-Chrome UA is the stealthy choice;
  a spoofed UA reduces stealth.
- If you don't need a proxy, skip `stealth_open` — `stealth_navigate` auto-launches with defaults.
- A misnamed or unset proxy profile fails with the list of configured names.

## What NOT to do

- Don't set custom user-agents/headers or inject init scripts — those re-introduce the very leaks
  this browser exists to avoid (the tools deliberately don't expose them).
- Don't expect stealth to be magic: detection also weighs **IP reputation, TLS fingerprint, and
  behavior**. A datacenter IP or robotic timing still gets flagged. Slow down, use real waits, and
  respect each site's terms.

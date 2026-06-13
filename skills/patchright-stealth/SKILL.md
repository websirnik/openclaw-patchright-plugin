---
name: patchright-stealth
description: Use when a site has bot detection (DataDome, Cloudflare, Akamai, "verify you are human" / challenge pages) or when OpenClaw's native browser gets blocked, captcha'd, or flagged. Drives a real-Chrome stealth browser via the stealth_* tools.
user-invocable: false
---

# Patchright Stealth Browser

Use the `stealth_*` tools (not the native `browser` tool) for sites that fingerprint or
challenge automation. They drive real Google Chrome launched by Patchright, which closes the
`Runtime.enable` / `navigator.webdriver` leaks that get the native browser blocked.

## The one rule: always pass `session`

Every interactive tool **requires** a `session` argument. **Pass your own agent name** (the same
value every time), e.g. `session: "relayter"`. This gives you your own dedicated Chrome window and
profile, isolated from every other agent. Reuse the same `session` across calls to keep your tabs,
cookies, and login state. The call will error if you omit it — that is intentional.

## When to use vs. the native browser

- **Use `stealth_*`** when: the URL is behind DataDome/Cloudflare/Akamai, you hit a captcha or
  "verify you are human" page, or the native browser returns blocked/empty content on a site.
- **Use the native `browser` tool** for everything else — it has richer snapshots and is fine for
  sites without bot detection. The stealth browser is a separate instance; the two do not share tabs.

## Operating loop

1. `stealth_navigate { session, url }` — opens/reuses your browser and loads the page.
2. `stealth_wait { session, selector | state:"networkidle" | ms }` — let the page settle (challenge
   pages and SPAs need this).
3. `stealth_content { session }` — read visible text (or `html:true`) to see what's there.
4. Interact: `stealth_click`, `stealth_fill`, `stealth_type` (key-by-key, more human),
   `stealth_press`. Selectors are Playwright-style: CSS (`button#login`), text (`text=Sign in`),
   or role (`role=button[name="Submit"]`).
5. Extract structured data with `stealth_evaluate { session, expression }` (runs in an isolated
   context; in-page `console.*` will NOT appear — return values instead).
6. `stealth_screenshot { session }` when you need to see the page or prove a result.
7. `stealth_status` (omit `session` to list all open sessions) to check state.
8. `stealth_close { session }` when finished, to release the profile lock. Leave it open if you'll
   return soon — the profile persists on disk either way.

## Slider / drag challenges (e.g. DataDome)

The mouse tools dispatch **trusted** input (what anti-bot systems check for), so use them — not JS
clicks — for slider puzzles:

1. `stealth_box { session, selector }` to get the handle's `{centerX, centerY, width}` — or take a
   `stealth_screenshot` and read coordinates visually (works even when the slider is in an iframe,
   since drag uses viewport coordinates).
2. `stealth_drag { session, fromX, fromY, toX, toY, steps, holdMs, settleMs }` to drag the handle.
   Use a generous `steps` (e.g. 25–40) and small `holdMs`/`settleMs` for a human-like motion. If the
   track length is unknown, drag toward the right edge of the slider container and let it snap.
3. For finer control, compose `stealth_mouse_move` + `stealth_mouse_button` yourself.

## Cookies

`stealth_evaluate("document.cookie")` only sees JS-readable cookies — it **cannot** see `httpOnly`
session cookies. To export a full session (e.g. after solving a challenge, to hand cookies to
another system): use `stealth_cookies_get { session }`, which returns every cookie with full
attributes. Use `stealth_cookies_set` to import a session, `stealth_cookies_clear` to reset.

## What NOT to do

- Don't set custom user-agents/headers or inject init scripts — those re-introduce the very leaks
  this browser exists to avoid (the tools deliberately don't expose them).
- Don't expect stealth to be magic: detection also weighs **IP reputation, TLS fingerprint, and
  behavior**. A datacenter IP or robotic timing still gets flagged. Slow down, use real waits, and
  respect each site's terms.

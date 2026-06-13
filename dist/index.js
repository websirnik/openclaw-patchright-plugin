import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { chromium } from "patchright";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
/**
 * Patchright stealth browser plugin — per-session isolated browsers.
 *
 * The OpenClaw gateway is a single process shared by every agent/bot, so this
 * module loads ONCE and is shared. To stop agents colliding on one browser we
 * keep a registry keyed by a caller-supplied `session` id: each distinct session
 * gets its OWN Chrome instance and its OWN persistent profile directory.
 *
 * (The SDK does not expose the calling agent's identity to a tool's execute(),
 * so the session id is passed explicitly. The companion skill instructs each
 * agent to pass `session: "<its-own-name>"`, which yields per-agent isolation.)
 *
 * STEALTH CONTRACT — Patchright's patches only apply because Patchright launches
 * the browser. Per its guidance we must NOT addInitScript, set custom
 * userAgent/headers, or open raw CDP sessions; doing so re-introduces the
 * Runtime.enable/automation leaks. Those tools are deliberately absent.
 */
// ----- configuration (env-overridable; stealth defaults) -----
const PROFILE_ROOT = process.env.PATCHRIGHT_PROFILE_ROOT ??
    join(homedir(), ".openclaw", "browser");
const CHANNEL = process.env.PATCHRIGHT_CHANNEL ?? "chrome"; // real Google Chrome
const HEADLESS = process.env.PATCHRIGHT_HEADLESS === "1"; // default headful (best practice)
const DEFAULT_MAX_CHARS = 20000;
const SHOT_DIR = join(homedir(), ".openclaw", "media", "patchright");
const sessions = new Map();
/** Make a caller's session id safe to use as a directory name. */
function safeSession(session) {
    const s = (session ?? "default").trim() || "default";
    return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
}
async function ensureSession(sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) {
        if (!existing.page.isClosed())
            return existing;
        // Page died but context may still be alive — try to recover an active page.
        try {
            existing.page = existing.context.pages().at(-1) ?? (await existing.context.newPage());
            return existing;
        }
        catch {
            // Context is gone; drop it and relaunch below. (close handler may already have.)
            sessions.delete(sessionId);
        }
    }
    const profileDir = join(PROFILE_ROOT, `patchright-stealth-profile-${sessionId}`);
    await mkdir(profileDir, { recursive: true });
    // No custom UA, no viewport, no init scripts — Patchright's recommended config.
    const context = await chromium.launchPersistentContext(profileDir, {
        channel: CHANNEL,
        headless: HEADLESS,
        viewport: null,
    });
    const sess = { context, page: context.pages()[0] ?? (await context.newPage()) };
    // Newest tab/popup becomes the active page for this session.
    context.on("page", (p) => {
        sess.page = p;
    });
    context.on("close", () => {
        sessions.delete(sessionId);
    });
    sessions.set(sessionId, sess);
    return sess;
}
async function activePage(session) {
    const id = safeSession(session);
    const sess = await ensureSession(id);
    if (sess.page.isClosed()) {
        sess.page = sess.context.pages().at(-1) ?? (await sess.context.newPage());
    }
    return { id, page: sess.page, sess };
}
function clamp(text, max) {
    if (text.length <= max)
        return { text, truncated: false };
    return { text: text.slice(0, max), truncated: true };
}
// Shared `session` param appended to every stateful tool. REQUIRED on purpose:
// a forgotten key should error loudly, never silently share one browser.
const sessionParam = {
    session: Type.String({
        description: "Isolation key — pass your own agent name. Each session gets a separate, dedicated Chrome + profile.",
    }),
};
export default defineToolPlugin({
    id: "patchright-stealth",
    name: "Patchright Stealth Browser",
    description: "Interactive stealth browser via Patchright (real Chrome, persistent profile, per-session isolated). " +
        "Use for bot-detected sites (DataDome/Cloudflare/Akamai). Pass `session` = your agent name. " +
        "Separate from OpenClaw's native browser tool.",
    tools: (tool) => [
        tool({
            name: "stealth_navigate",
            description: "Open/navigate this session's stealth browser to a URL. Launches it on first use.",
            parameters: Type.Object({
                url: Type.String({ description: "Absolute URL." }),
                waitUntil: Type.Optional(Type.Union([
                    Type.Literal("load"),
                    Type.Literal("domcontentloaded"),
                    Type.Literal("networkidle"),
                    Type.Literal("commit"),
                ])),
                timeoutMs: Type.Optional(Type.Number({ description: "Default 30000." })),
                ...sessionParam,
            }),
            execute: async ({ url, waitUntil, timeoutMs, session }) => {
                const { id, page } = await activePage(session);
                const resp = await page.goto(url, { waitUntil: waitUntil ?? "domcontentloaded", timeout: timeoutMs ?? 30000 });
                return { session: id, url: page.url(), title: await page.title(), status: resp?.status() ?? null };
            },
        }),
        tool({
            name: "stealth_content",
            description: "Read this session's current page as visible text (default) or raw HTML, truncated.",
            parameters: Type.Object({
                html: Type.Optional(Type.Boolean({ description: "Return raw HTML instead of text." })),
                maxChars: Type.Optional(Type.Number({ description: `Default ${DEFAULT_MAX_CHARS}.` })),
                ...sessionParam,
            }),
            execute: async ({ html, maxChars, session }) => {
                const { id, page } = await activePage(session);
                const raw = html ? await page.content() : await page.evaluate(() => document.body?.innerText ?? "");
                const { text, truncated } = clamp(raw, maxChars ?? DEFAULT_MAX_CHARS);
                return { session: id, url: page.url(), title: await page.title(), truncated, content: text };
            },
        }),
        tool({
            name: "stealth_click",
            description: "Click an element by Playwright selector (CSS, text=..., role=...).",
            parameters: Type.Object({
                selector: Type.String({ description: "e.g. 'button#login' or 'text=Sign in'." }),
                timeoutMs: Type.Optional(Type.Number({ description: "Default 15000." })),
                ...sessionParam,
            }),
            execute: async ({ selector, timeoutMs, session }) => {
                const { id, page } = await activePage(session);
                await page.click(selector, { timeout: timeoutMs ?? 15000 });
                return { session: id, ok: true, url: page.url() };
            },
        }),
        tool({
            name: "stealth_fill",
            description: "Fill an input/textarea by selector (clears then sets value).",
            parameters: Type.Object({
                selector: Type.String({ description: "Selector for the input." }),
                value: Type.String({ description: "Value to set." }),
                timeoutMs: Type.Optional(Type.Number({ description: "Default 15000." })),
                ...sessionParam,
            }),
            execute: async ({ selector, value, timeoutMs, session }) => {
                const { id, page } = await activePage(session);
                await page.fill(selector, value, { timeout: timeoutMs ?? 15000 });
                return { session: id, ok: true };
            },
        }),
        tool({
            name: "stealth_type",
            description: "Type text key-by-key with a delay (more human than fill).",
            parameters: Type.Object({
                selector: Type.String({ description: "Selector to focus before typing." }),
                text: Type.String({ description: "Text to type." }),
                delayMs: Type.Optional(Type.Number({ description: "Per-keystroke delay. Default 40." })),
                ...sessionParam,
            }),
            execute: async ({ selector, text, delayMs, session }) => {
                const { id, page } = await activePage(session);
                await page.locator(selector).pressSequentially(text, { delay: delayMs ?? 40 });
                return { session: id, ok: true };
            },
        }),
        tool({
            name: "stealth_press",
            description: "Press a keyboard key (e.g. 'Enter'), optionally focusing a selector first.",
            parameters: Type.Object({
                key: Type.String({ description: "Key name, e.g. 'Enter'." }),
                selector: Type.Optional(Type.String({ description: "Optional selector to focus first." })),
                ...sessionParam,
            }),
            execute: async ({ key, selector, session }) => {
                const { id, page } = await activePage(session);
                if (selector)
                    await page.press(selector, key);
                else
                    await page.keyboard.press(key);
                return { session: id, ok: true };
            },
        }),
        tool({
            name: "stealth_wait",
            description: "Wait for a selector, a load state, a URL pattern, or a fixed delay.",
            parameters: Type.Object({
                selector: Type.Optional(Type.String()),
                state: Type.Optional(Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle")])),
                urlPattern: Type.Optional(Type.String({ description: "Wait until URL matches (glob)." })),
                ms: Type.Optional(Type.Number({ description: "Fixed wait in ms." })),
                timeoutMs: Type.Optional(Type.Number({ description: "Default 30000." })),
                ...sessionParam,
            }),
            execute: async ({ selector, state, urlPattern, ms, timeoutMs, session }) => {
                const { id, page } = await activePage(session);
                const timeout = timeoutMs ?? 30000;
                if (selector)
                    await page.waitForSelector(selector, { timeout });
                if (state)
                    await page.waitForLoadState(state, { timeout });
                if (urlPattern)
                    await page.waitForURL(urlPattern, { timeout });
                if (ms)
                    await page.waitForTimeout(ms);
                return { session: id, ok: true, url: page.url() };
            },
        }),
        tool({
            name: "stealth_evaluate",
            description: "Evaluate a JS expression in the page and return the JSON result. " +
                "Runs in Patchright's isolated context; in-page console.* is unavailable.",
            parameters: Type.Object({
                expression: Type.String({ description: "JS expression returning a value." }),
                ...sessionParam,
            }),
            execute: async ({ expression, session }) => {
                const { id, page } = await activePage(session);
                const result = await page.evaluate((expr) => {
                    const fn = new Function(`return (${expr});`);
                    return fn();
                }, expression);
                return { session: id, result };
            },
        }),
        tool({
            name: "stealth_screenshot",
            description: "Capture a screenshot of this session's page; returns the saved file path.",
            parameters: Type.Object({
                path: Type.Optional(Type.String({ description: "Output path. Default under ~/.openclaw/media/patchright/." })),
                fullPage: Type.Optional(Type.Boolean({ description: "Full scrollable page. Default false." })),
                ...sessionParam,
            }),
            execute: async ({ path, fullPage, session }) => {
                const { id, page } = await activePage(session);
                await mkdir(SHOT_DIR, { recursive: true });
                const out = path ?? join(SHOT_DIR, `${id}-${Date.now()}.png`);
                await page.screenshot({ path: out, fullPage: fullPage ?? false });
                return { session: id, path: out };
            },
        }),
        tool({
            name: "stealth_status",
            description: "List active stealth sessions, or report one session's current URL/title/tab count.",
            parameters: Type.Object({
                session: Type.Optional(Type.String({ description: "Report just this session. Omit to list all." })),
            }),
            execute: async ({ session }) => {
                if (session === undefined) {
                    const list = await Promise.all([...sessions.entries()].map(async ([id, s]) => ({
                        session: id,
                        url: s.page.isClosed() ? null : s.page.url(),
                        tabs: s.context.pages().length,
                    })));
                    return { open: sessions.size, sessions: list, channel: CHANNEL, headless: HEADLESS };
                }
                const id = safeSession(session);
                const s = sessions.get(id);
                if (!s || s.page.isClosed())
                    return { session: id, open: false };
                return { session: id, open: true, url: s.page.url(), title: await s.page.title(), tabs: s.context.pages().length };
            },
        }),
        tool({
            name: "stealth_close",
            description: "Close one session's browser (releases its profile lock), or all sessions.",
            parameters: Type.Object({
                session: Type.Optional(Type.String({ description: "Session to close. Omit + all=true to close everything." })),
                all: Type.Optional(Type.Boolean({ description: "Close every session." })),
            }),
            execute: async ({ session, all }) => {
                if (all) {
                    const ids = [...sessions.keys()];
                    await Promise.all([...sessions.values()].map((s) => s.context.close().catch(() => { })));
                    sessions.clear();
                    return { closed: ids };
                }
                const id = safeSession(session);
                const s = sessions.get(id);
                if (!s)
                    return { closed: [] };
                await s.context.close().catch(() => { });
                sessions.delete(id);
                return { closed: [id] };
            },
        }),
    ],
});

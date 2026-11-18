import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { chromium } from "patchright";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { mkdir, realpath } from "node:fs/promises";
/**
 * Patchright stealth browser plugin — per-agent, per-session isolated browsers.
 *
 * The OpenClaw gateway is a single process shared by every agent/bot, so this
 * module loads ONCE and is shared. Every tool is built by a factory that reads
 * the calling agent's id from the host tool context (never from model args).
 * A browser is keyed by (agentId, session): each pair gets its OWN Chrome
 * instance and its OWN persistent profile directory, and an agent can only see,
 * drive, or close its own browsers.
 *
 * STEALTH CONTRACT — Patchright's patches only apply because Patchright launches
 * the browser. Per its guidance we must NOT addInitScript, set custom
 * userAgent/headers, or open raw CDP sessions; doing so re-introduces the
 * Runtime.enable/automation leaks. Those tools are deliberately absent.
 */
// ----- configuration (env-overridable; stealth defaults) -----
const PROFILE_ROOT = process.env.PATCHRIGHT_PROFILE_ROOT ?? join(homedir(), ".openclaw", "browser");
const PROFILE_PREFIX = "patchright-stealth-profile-";
const CHANNEL = process.env.PATCHRIGHT_CHANNEL ?? "chrome"; // real Google Chrome
const HEADLESS = process.env.PATCHRIGHT_HEADLESS === "1"; // default headful (best practice)
const SHOT_DIR = join(homedir(), ".openclaw", "media", "patchright");
const DEFAULT_MAX_CHARS = 20000;
const MAX_WAIT_MS = 120_000; // upper bound for any wait/timeout a model can request
const CLOSE_TIMEOUT_MS = 5000;
// ----- plugin config: named proxy profiles (keeps proxy passwords out of tool args) -----
const ProxyProfileSchema = Type.Object({
    server: Type.String({ description: "Proxy URL, e.g. http://host:port or socks5://host:port." }),
    username: Type.Optional(Type.String()),
    passwordEnv: Type.Optional(Type.String({ description: "Name of a gateway environment variable that holds the proxy password." })),
    bypass: Type.Optional(Type.String({ description: "Comma-separated hosts to bypass the proxy for." })),
}, { additionalProperties: false });
const configSchema = Type.Object({
    proxies: Type.Optional(Type.Record(Type.String(), ProxyProfileSchema, {
        description: "Named proxy profiles that agents select with stealth_open { proxyProfile }.",
    })),
}, { additionalProperties: false });
/** Make an id safe to use inside a directory name. */
function safeId(value, fallback) {
    const s = (value ?? "").trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
    return s && s !== "." && s !== ".." ? s : fallback;
}
/**
 * Resolve the profile name for (agentId, session). Names that already start with the
 * agent id ("buyer", "buyer-checkout") are kept as-is so existing profiles keep working;
 * anything else is prefixed ("bookings" from main -> "main-bookings"). The result always
 * equals the agent id or starts with "<agentId>-", so agents cannot reach each other's
 * profiles. A name that would fall inside a longer agent id's namespace
 * (agent "shop" + session "us-x" vs agent "shop-us") is refused.
 */
export function resolveSessionName(agentId, session, agentIds = []) {
    const agent = safeId(agentId, "agent");
    const s = safeId(session, agent);
    const name = s === agent || s.startsWith(`${agent}-`) ? s : `${agent}-${s}`;
    for (const other of agentIds) {
        const o = safeId(other, "");
        if (!o || o === agent || !o.startsWith(`${agent}-`))
            continue;
        if (name === o || name.startsWith(`${o}-`)) {
            throw new Error(`session "${session}" resolves into agent "${o}"'s namespace; pick another session name`);
        }
    }
    return name;
}
function profileDirFor(name) {
    return join(PROFILE_ROOT, `${PROFILE_PREFIX}${name}`);
}
const sessions = new Map(); // keyed by profile name
const launching = new Map(); // in-flight launches, so parallel calls share one
async function launchSession(ref, opts) {
    const profileDir = profileDirFor(ref.name);
    await mkdir(profileDir, { recursive: true });
    // Base: Patchright's recommended config (real Chrome, headful, no viewport, default UA).
    const launchOptions = {
        channel: CHANNEL,
        headless: opts?.headless ?? HEADLESS,
        viewport: null,
    };
    if (opts?.proxy)
        launchOptions.proxy = opts.proxy;
    if (opts?.args?.length)
        launchOptions.args = opts.args;
    if (opts?.locale)
        launchOptions.locale = opts.locale;
    if (opts?.timezoneId)
        launchOptions.timezoneId = opts.timezoneId;
    if (opts?.geolocation) {
        launchOptions.geolocation = opts.geolocation;
        launchOptions.permissions = ["geolocation"];
    }
    if (opts?.ignoreHTTPSErrors)
        launchOptions.ignoreHTTPSErrors = true;
    const context = await chromium.launchPersistentContext(profileDir, launchOptions);
    const sess = {
        agentId: ref.owner.agentId,
        session: ref.session,
        context,
        page: context.pages()[0] ?? (await context.newPage()),
        config: {
            proxy: opts?.proxy?.server ?? null,
            ...(opts?.proxyProfile ? { proxyProfile: opts.proxyProfile } : {}),
            ...(opts?.locale ? { locale: opts.locale } : {}),
            ...(opts?.timezoneId ? { timezoneId: opts.timezoneId } : {}),
            headless: opts?.headless ?? HEADLESS,
        },
    };
    // Newest tab/popup becomes the active page for this session.
    context.on("page", (p) => {
        sess.page = p;
    });
    context.on("close", () => {
        if (sessions.get(ref.name) === sess)
            sessions.delete(ref.name);
    });
    sessions.set(ref.name, sess);
    return sess;
}
async function ensureSession(ref, opts) {
    const existing = sessions.get(ref.name);
    if (existing) {
        if (!existing.page.isClosed())
            return existing;
        // Page died but context may still be alive — try to recover an active page.
        try {
            existing.page = existing.context.pages().at(-1) ?? (await existing.context.newPage());
            return existing;
        }
        catch {
            // Context is gone; drop it and relaunch below.
            sessions.delete(ref.name);
        }
    }
    const pending = launching.get(ref.name);
    if (pending)
        return pending;
    const launch = launchSession(ref, opts).finally(() => launching.delete(ref.name));
    launching.set(ref.name, launch);
    return launch;
}
async function activePage(ref) {
    const sess = await ensureSession(ref);
    if (sess.page.isClosed()) {
        sess.page = sess.context.pages().at(-1) ?? (await sess.context.newPage());
    }
    return { page: sess.page, sess };
}
async function closeContext(context) {
    let timer;
    await Promise.race([
        context.close().catch(() => { }),
        new Promise((done) => {
            timer = setTimeout(done, CLOSE_TIMEOUT_MS);
        }),
    ]);
    if (timer)
        clearTimeout(timer);
}
/** Close every browser this plugin launched (plugin dispose / gateway shutdown). */
export async function closeAllSessions() {
    const pending = [...launching.values()];
    await Promise.allSettled(pending);
    const all = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(all.map((s) => closeContext(s.context)));
}
// ----- helpers -----
function clamp(text, max) {
    if (text.length <= max)
        return { text, truncated: false };
    return { text: text.slice(0, max), truncated: true };
}
function boundedMs(value, fallback) {
    const v = value ?? fallback;
    if (!Number.isFinite(v) || v < 0)
        return fallback;
    return Math.min(v, MAX_WAIT_MS);
}
function abortError(signal) {
    return signal.reason ?? new Error("stealth tool call aborted");
}
/** Reject as soon as the tool call is aborted; the underlying Playwright call keeps its own timeout. */
async function abortable(signal, work) {
    if (!signal)
        return work;
    if (signal.aborted) {
        work.catch(() => { });
        throw abortError(signal);
    }
    return await new Promise((resolveWork, rejectWork) => {
        const onAbort = () => rejectWork(abortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        work.then(resolveWork, rejectWork).finally(() => signal.removeEventListener("abort", onAbort));
    });
}
function sleep(ms, signal) {
    return new Promise((done, fail) => {
        if (signal?.aborted)
            return fail(abortError(signal));
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            done();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            fail(abortError(signal));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
function inside(child, root) {
    return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}
/**
 * Screenshots may only be written under the plugin's media dir or the calling agent's
 * workspace. Relative paths resolve against the workspace (or the media dir).
 */
export async function resolveScreenshotPath(requested, owner, name) {
    await mkdir(SHOT_DIR, { recursive: true });
    if (!requested)
        return join(SHOT_DIR, `${name}-${Date.now()}.png`);
    const ext = extname(requested).toLowerCase();
    if (![".png", ".jpg", ".jpeg"].includes(ext))
        throw new Error("screenshot path must end in .png, .jpg or .jpeg");
    const roots = [SHOT_DIR, ...(owner.workspaceDir ? [owner.workspaceDir] : [])];
    const base = owner.workspaceDir ?? SHOT_DIR;
    const out = resolve(isAbsolute(requested) ? requested : join(base, requested));
    const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => resolve(r))));
    if (!roots.some((r) => inside(out, resolve(r))) && !realRoots.some((r) => inside(out, r))) {
        throw new Error(`screenshot path must be inside ${roots.join(" or ")}`);
    }
    await mkdir(dirname(out), { recursive: true });
    const realParent = await realpath(dirname(out));
    if (!realRoots.some((r) => inside(realParent, r))) {
        throw new Error("screenshot path resolves outside the allowed folders (symlink)");
    }
    return join(realParent, basename(out));
}
/** Expressions that are function literals are called; everything else is evaluated as-is. */
export function toEvaluationSource(expression) {
    const src = expression.trim();
    const isFunctionLiteral = /^(async\s+)?(function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(src);
    return isFunctionLiteral ? `(${src})()` : src;
}
function agentIdsFrom(config) {
    const entries = config?.agents?.entries;
    return entries && typeof entries === "object" ? Object.keys(entries) : [];
}
// ----- shared schemas -----
const sessionParam = {
    session: Type.Optional(Type.String({
        description: "Optional browser name within your own agent (e.g. 'checkout'). Omit for your default browser. " +
            "Each name is a separate Chrome + persistent profile, private to your agent.",
    })),
};
const timeoutParam = (fallback) => Type.Optional(Type.Number({ description: `Default ${fallback}. Capped at ${MAX_WAIT_MS}.` }));
// Cookie shape for import/export (matches Playwright's addCookies/cookies).
const CookieSchema = Type.Object({
    name: Type.String(),
    value: Type.String(),
    url: Type.Optional(Type.String()),
    domain: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
    expires: Type.Optional(Type.Number()),
    httpOnly: Type.Optional(Type.Boolean()),
    secure: Type.Optional(Type.Boolean()),
    sameSite: Type.Optional(Type.Union([Type.Literal("Strict"), Type.Literal("Lax"), Type.Literal("None")])),
});
const ProxySchema = Type.Object({
    server: Type.String({ description: "Proxy URL, e.g. http://host:port or socks5://host:port." }),
    username: Type.Optional(Type.String()),
    password: Type.Optional(Type.String()),
    bypass: Type.Optional(Type.String({ description: "Comma-separated hosts to bypass the proxy for." })),
});
const GeoSchema = Type.Object({
    latitude: Type.Number(),
    longitude: Type.Number(),
    accuracy: Type.Optional(Type.Number()),
});
const Str = Type.String();
const Num = Type.Number();
const Bool = Type.Boolean();
const closed = (props) => Type.Object(props, { additionalProperties: false });
const ConfigOut = closed({
    proxy: Type.Union([Str, Type.Null()]),
    proxyProfile: Type.Optional(Str),
    locale: Type.Optional(Str),
    timezoneId: Type.Optional(Str),
    headless: Bool,
});
const OkOut = closed({ session: Str, ok: Bool, url: Str });
const disposeRegistered = new WeakSet();
function registerCleanup(api) {
    if (disposeRegistered.has(api))
        return;
    disposeRegistered.add(api);
    if (typeof api.lifecycle?.onDispose === "function") {
        api.lifecycle.onDispose(closeAllSessions);
    }
    else {
        api.registerService?.({ id: "patchright-stealth-browsers", start: () => { }, stop: closeAllSessions });
    }
}
function stealthTool(def) {
    return {
        name: def.name,
        label: def.label,
        description: def.description,
        parameters: def.parameters,
        factory: ({ api, config, toolContext }) => {
            const agentId = toolContext.agentId;
            if (!agentId)
                return null; // no trusted caller identity -> do not offer the tools
            const owner = { agentId, workspaceDir: toolContext.workspaceDir };
            return {
                name: def.name,
                label: def.label,
                description: def.description,
                parameters: def.parameters,
                outputSchema: def.outputSchema,
                ...(def.network ? { resultContentSource: "network" } : {}),
                execute: async (_toolCallId, params, signal) => {
                    const runtimeConfig = toolContext.getRuntimeConfig?.() ?? toolContext.config ?? api.config;
                    const agentIds = agentIdsFrom(runtimeConfig);
                    const name = resolveSessionName(agentId, params.session, agentIds);
                    const ref = { owner, session: name, name };
                    const result = await def.run(params, { ref, owner, signal, config, agentIds });
                    return jsonResult(result);
                },
            };
        },
    };
}
// ----- tools -----
const toolDefs = [
    stealthTool({
        name: "stealth_open",
        label: "Patchright open",
        description: "Explicitly launch one of your browsers with launch-time options: a proxy (prefer `proxyProfile`, a " +
            "named proxy from the plugin config, so no password goes through tool args), extra Chrome args, locale, " +
            "timezoneId, geolocation, headless. Call this BEFORE stealth_navigate when you need a proxy. Options apply " +
            "only at launch — to change them, stealth_close first. (User-Agent is intentionally NOT overridable.)",
        parameters: Type.Object({
            proxyProfile: Type.Optional(Type.String({ description: "Name of a proxy profile from the plugin config." })),
            proxy: Type.Optional(ProxySchema),
            args: Type.Optional(Type.Array(Type.String(), { description: "Extra Chrome flags, e.g. ['--window-size=1280,800']." })),
            locale: Type.Optional(Type.String({ description: "e.g. 'en-US'. Match the proxy's country." })),
            timezoneId: Type.Optional(Type.String({ description: "e.g. 'America/New_York'. A timezone/IP mismatch is a detection signal — match the proxy." })),
            geolocation: Type.Optional(GeoSchema),
            headless: Type.Optional(Type.Boolean({ description: "Default false (headful is less detectable)." })),
            ignoreHTTPSErrors: Type.Optional(Type.Boolean()),
            ...sessionParam,
        }),
        outputSchema: Type.Union([
            closed({ session: Str, opened: Type.Literal(true), config: ConfigOut }),
            closed({ session: Str, alreadyOpen: Type.Literal(true), note: Str, config: ConfigOut }),
        ]),
        run: async (p, { ref, config }) => {
            const pendingLaunch = launching.get(ref.name);
            if (pendingLaunch)
                await pendingLaunch.catch(() => { });
            const running = sessions.get(ref.name);
            if (running) {
                return {
                    session: ref.session,
                    alreadyOpen: true,
                    note: "Session already running — stealth_close it first to relaunch with different proxy/options.",
                    config: running.config,
                };
            }
            let proxy = p.proxy;
            if (p.proxyProfile) {
                if (p.proxy)
                    throw new Error("pass either proxy or proxyProfile, not both");
                const profile = config.proxies?.[p.proxyProfile];
                if (!profile) {
                    const known = Object.keys(config.proxies ?? {});
                    throw new Error(`unknown proxyProfile "${p.proxyProfile}"; configured: ${known.join(", ") || "none"}`);
                }
                let password;
                if (profile.passwordEnv) {
                    password = process.env[profile.passwordEnv];
                    if (!password)
                        throw new Error(`proxy profile "${p.proxyProfile}": env var ${profile.passwordEnv} is not set`);
                }
                proxy = {
                    server: profile.server,
                    ...(profile.username ? { username: profile.username } : {}),
                    ...(password ? { password } : {}),
                    ...(profile.bypass ? { bypass: profile.bypass } : {}),
                };
            }
            const sess = await ensureSession(ref, {
                proxy,
                proxyProfile: p.proxyProfile,
                args: p.args,
                locale: p.locale,
                timezoneId: p.timezoneId,
                geolocation: p.geolocation,
                headless: p.headless,
                ignoreHTTPSErrors: p.ignoreHTTPSErrors,
            });
            return { session: ref.session, opened: true, config: sess.config };
        },
    }),
    stealthTool({
        name: "stealth_navigate",
        label: "Patchright navigate",
        description: "Open/navigate one of your stealth browsers to a URL. Launches it on first use.",
        parameters: Type.Object({
            url: Type.String({ description: "Absolute URL." }),
            waitUntil: Type.Optional(Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle"), Type.Literal("commit")])),
            timeoutMs: timeoutParam(30000),
            ...sessionParam,
        }),
        outputSchema: closed({ session: Str, url: Str, title: Str, httpStatus: Type.Union([Num, Type.Null()]) }),
        network: true,
        run: async ({ url, waitUntil, timeoutMs }, { ref, signal }) => {
            const { page } = await abortable(signal, activePage(ref));
            const resp = await abortable(signal, page.goto(url, { waitUntil: waitUntil ?? "domcontentloaded", timeout: boundedMs(timeoutMs, 30000) }));
            return { session: ref.session, url: page.url(), title: await page.title(), httpStatus: resp?.status() ?? null };
        },
    }),
    stealthTool({
        name: "stealth_content",
        label: "Patchright content",
        description: "Read the current page as visible text (default) or raw HTML, truncated.",
        parameters: Type.Object({
            html: Type.Optional(Type.Boolean({ description: "Return raw HTML instead of text." })),
            maxChars: Type.Optional(Type.Number({ description: `Default ${DEFAULT_MAX_CHARS}.` })),
            ...sessionParam,
        }),
        outputSchema: closed({ session: Str, url: Str, title: Str, truncated: Bool, content: Str }),
        network: true,
        run: async ({ html, maxChars }, { ref, signal }) => {
            const { page } = await abortable(signal, activePage(ref));
            const raw = html
                ? await abortable(signal, page.content())
                : await abortable(signal, page.evaluate(() => document.body?.innerText ?? ""));
            const { text, truncated } = clamp(raw, maxChars ?? DEFAULT_MAX_CHARS);
            return { session: ref.session, url: page.url(), title: await page.title(), truncated, content: text };
        },
    }),
    stealthTool({
        name: "stealth_click",
        label: "Patchright click",
        description: "Click an element by Playwright selector (CSS, text=..., role=...). Works inside closed shadow roots.",
        parameters: Type.Object({
            selector: Type.String({ description: "e.g. 'button#login' or 'text=Sign in'." }),
            timeoutMs: timeoutParam(15000),
            ...sessionParam,
        }),
        outputSchema: OkOut,
        run: async ({ selector, timeoutMs }, { ref, signal }) => {
            const { page } = await abortable(signal, activePage(ref));
            await abortable(signal, page.click(selector, { timeout: boundedMs(timeoutMs, 15000) }));
            return { session: ref.session, ok: true, url: page.url() };
        },
    }),
    stealthTool({
        name: "stealth_fill",
        label: "Patchright fill",
        description: "Fill an input/textarea by selector (clears then sets value).",
        parameters: Type.Object({
            selector: Type.String({ description: "Selector for the input." }),
            value: Type.String({ description: "Value to set." }),
            timeoutMs: timeoutParam(15000),
            ...sessionParam,
        }),
        outputSchema: OkOut,
        run: async ({ selector, value, timeoutMs }, { ref, signal }) => {
            const { page } = await abortable(signal, activePage(ref));
            await abortable(signal, page.fill(selector, value, { timeout: boundedMs(timeoutMs, 15000) }));
            return { session: ref.session, ok: true, url: page.url() };
        },
    }),
    stealthTool({
        name: "stealth_type",
        label: "Patchright type",
        description: "Type text key-by-key with a delay (more human than fill).",
        parameters: Type.Object({
            selector: Type.String({ description: "Selector to focus before typing." }),
            text: Type.String({ description: "Text to type." }),
            delayMs: Type.Optional(Type.Number({ description: "Per-keystroke delay. Default 40." })),
            timeoutMs: timeoutParam(15000),
            ...sessionParam,
        }),
        outputSchema: OkOut,
        run: async ({ selector, text, delayMs, timeoutMs }, { ref, signal }) => {
            const { page } = await abortable(signal, activePage(ref));
            await abortable(signal, page.locator(selector).pressSequentially(text, { delay: delayMs ?? 40, timeout: boundedMs(timeoutMs, 15000) }));
            return { session: ref.session, ok: true, url: page.url() };
        },
    }),
    stealthTool({
        name: "stealth_press",
        label: "Patchright press",
        description: "Press a keyboard key (e.g. 'Enter'), optionally focusing a selector first.",
        parameters: Type.Object({
            key: Type.String({ description: "Key name, e.g. 'Enter'." }),
            selector: Type.Optional(Type.String({ description: "Optional selector to focus first." })),
            ...sessionParam,
        }),
        outputSchema: OkOut,
        run: async ({ key, selector }, { ref, signal }) => {
            const { page } = await abortable(signal, activePage(ref));
            if (selector)
                await abortable(signal, page.press(selector, key));
            else
                await abortable(signal, page.keyboard.press(key));
            return { session: ref.session, ok: true, url: page.url() };
        },
    }),
    stealthTool({
        name: "stealth_wait",
        label: "Patchright wait",
        description: `Wait for a selector, a load state, a URL pattern, or a fixed delay (each capped at ${MAX_WAIT_MS} ms).`,
        parameters: Type.Object({
            selector: Type.Optional(Type.String()),
            state: Type.Optional(Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle")])),
            urlPattern: Type.Optional(Type.String({ description: "Wait until URL matches (glob)." })),
            ms: Type.Optional(Type.Number({ description: `Fixed wait in ms (max ${MAX_WAIT_MS}).` })),
            timeoutMs: timeoutParam(30000),
            ...sessionParam,
        }),
        outputSchema: OkOut,
        run: async ({ selector, state, urlPattern, ms, timeoutMs }, { ref, signal }) => {
            const { page } = await abortable(signal, activePage(ref));
            const timeout = boundedMs(timeoutMs, 30000);
            if (selector)
                await abortable(signal, page.waitForSelector(selector, { timeout }));
            if (state)
                await abortable(signal, page.waitForLoadState(state, { timeout }));
            if (urlPattern)
                await abortable(signal, page.waitForURL(urlPattern, { timeout }));
            if (ms)
                await sleep(boundedMs(ms, 0), signal);
            return { session: ref.session, ok: true, url: page.url() };
        },
    }),
    stealthTool({
        name: "stealth_evaluate",
        label: "Patchright evaluate",
        description: "Evaluate JavaScript in the page and return the JSON result. Accepts an expression, multiple statements " +
            "(the last value is returned), or a function literal such as `() => ...` / `async () => ...` (it is called). " +
            "Runs in Patchright's isolated world by default (shares the DOM, but not page JS globals). Set mainWorld:true " +
            "to read page globals such as window.__NEXT_DATA__ or app state; that is slightly more observable to the site. " +
            "In-page console.* is unavailable.",
        parameters: Type.Object({
            expression: Type.String({ description: "JS expression, statements, or function literal." }),
            mainWorld: Type.Optional(Type.Boolean({ description: "Run in the page's own JS context. Default false." })),
            ...sessionParam,
        }),
        outputSchema: closed({ session: Str, result: Type.Unknown() }),
        network: true,
        run: async ({ expression, mainWorld }, { ref, signal }) => {
            const { page } = await abortable(signal, activePage(ref));
            // patchright: evaluate(pageFunction, arg, options, isolatedContext = true)
            const result = await abortable(signal, page.evaluate(toEvaluationSource(expression), undefined, undefined, !mainWorld));
            return { session: ref.session, result: result ?? null };
        },
    }),
    stealthTool({
        name: "stealth_screenshot",
        label: "Patchright screenshot",
        description: "Capture a screenshot; returns the saved file path. Default location is ~/.openclaw/media/patchright/. " +
            "A custom `path` must be inside your workspace (relative paths resolve there) or that media folder.",
        parameters: Type.Object({
            path: Type.Optional(Type.String({ description: "Output .png/.jpg path inside your workspace or the media folder." })),
            fullPage: Type.Optional(Type.Boolean({ description: "Full scrollable page. Default false." })),
            ...sessionParam,
        }),
        outputSchema: closed({ session: Str, path: Str }),
        run: async ({ path, fullPage }, { ref, owner, signal }) => {
            const out = await resolveScreenshotPath(path, owner, ref.name);
            const { page } = await abortable(signal, activePage(ref));
            await abortable(signal, page.screenshot({ path: out, fullPage: fullPage ?? false }));
            return { session: ref.session, path: out };
        },
    }),
    stealthTool({
        name: "stealth_box",
        label: "Patchright box",
        description: "Get an element's bounding box {x,y,width,height,centerX,centerY} in viewport coordinates — " +
            "use it to compute targets for the mouse/drag tools (e.g. a slider handle).",
        parameters: Type.Object({
            selector: Type.String({ description: "Playwright selector for the element." }),
            timeoutMs: timeoutParam(15000),
            ...sessionParam,
        }),
        outputSchema: Type.Union([
            closed({ session: Str, found: Type.Literal(false) }),
            closed({ session: Str, found: Type.Literal(true), x: Num, y: Num, width: Num, height: Num, centerX: Num, centerY: Num }),
        ]),
        run: async ({ selector, timeoutMs }, { ref, signal }) => {
            const { page } = await abortable(signal, activePage(ref));
            const el = page.locator(selector).first();
            await abortable(signal, el.waitFor({ state: "visible", timeout: boundedMs(timeoutMs, 15000) }));
            const box = await abortable(signal, el.boundingBox());
            if (!box)
                return { session: ref.session, found: false };
            return {
                session: ref.session,
                found: true,
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
                centerX: box.x + box.width / 2,
                centerY: box.y + box.height / 2,
            };
        },
    }),
    stealthTool({
        name: "stealth_mouse_move",
        label: "Patchright mouse move",
        description: "Move the mouse to viewport coordinates (x,y) over N human-like steps. Trusted input.",
        parameters: Type.Object({
            x: Type.Number(),
            y: Type.Number(),
            steps: Type.Optional(Type.Number({ description: "Intermediate steps (smoother/slower). Default 20." })),
            ...sessionParam,
        }),
        outputSchema: closed({ session: Str, ok: Bool, x: Num, y: Num }),
        run: async ({ x, y, steps }, { ref, signal }) => {
            const { page } = await abortable(signal, activePage(ref));
            await abortable(signal, page.mouse.move(x, y, { steps: steps ?? 20 }));
            return { session: ref.session, ok: true, x, y };
        },
    }),
    stealthTool({
        name: "stealth_mouse_button",
        label: "Patchright mouse button",
        description: "Press or release a mouse button at the current cursor position (compose custom gestures).",
        parameters: Type.Object({
            action: Type.Union([Type.Literal("down"), Type.Literal("up")]),
            button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
            ...sessionParam,
        }),
        outputSchema: OkOut,
        run: async ({ action, button }, { ref, signal }) => {
            const { page } = await abortable(signal, activePage(ref));
            if (action === "down")
                await abortable(signal, page.mouse.down({ button: button ?? "left" }));
            else
                await abortable(signal, page.mouse.up({ button: button ?? "left" }));
            return { session: ref.session, ok: true, url: page.url() };
        },
    }),
    stealthTool({
        name: "stealth_drag",
        label: "Patchright drag",
        description: "Trusted press-move-release drag from (fromX,fromY) to (toX,toY) using real mouse input over N steps. " +
            "Use for DataDome / slider captchas. Get coordinates from stealth_box or stealth_screenshot.",
        parameters: Type.Object({
            fromX: Type.Number(),
            fromY: Type.Number(),
            toX: Type.Number(),
            toY: Type.Number(),
            steps: Type.Optional(Type.Number({ description: "Move steps (more = smoother/slower). Default 25." })),
            holdMs: Type.Optional(Type.Number({ description: "Pause after pressing, before moving. Default 0." })),
            settleMs: Type.Optional(Type.Number({ description: "Pause at target before releasing. Default 0." })),
            ...sessionParam,
        }),
        outputSchema: closed({
            session: Str,
            ok: Bool,
            from: closed({ x: Num, y: Num }),
            to: closed({ x: Num, y: Num }),
        }),
        run: async ({ fromX, fromY, toX, toY, steps, holdMs, settleMs }, { ref, signal }) => {
            const { page } = await abortable(signal, activePage(ref));
            await page.mouse.move(fromX, fromY, { steps: 8 });
            await page.mouse.down();
            try {
                if (holdMs)
                    await sleep(boundedMs(holdMs, 0), signal);
                await page.mouse.move(toX, toY, { steps: steps ?? 25 });
                if (settleMs)
                    await sleep(boundedMs(settleMs, 0), signal);
            }
            finally {
                await page.mouse.up().catch(() => { }); // never leave the button held down
            }
            return { session: ref.session, ok: true, from: { x: fromX, y: fromY }, to: { x: toX, y: toY } };
        },
    }),
    stealthTool({
        name: "stealth_hover",
        label: "Patchright hover",
        description: "Hover an element (by selector) or viewport coordinates (x,y).",
        parameters: Type.Object({
            selector: Type.Optional(Type.String({ description: "Element to hover." })),
            x: Type.Optional(Type.Number()),
            y: Type.Optional(Type.Number()),
            timeoutMs: timeoutParam(15000),
            ...sessionParam,
        }),
        outputSchema: OkOut,
        run: async ({ selector, x, y, timeoutMs }, { ref, signal }) => {
            const { page } = await abortable(signal, activePage(ref));
            if (selector)
                await abortable(signal, page.hover(selector, { timeout: boundedMs(timeoutMs, 15000) }));
            else if (x !== undefined && y !== undefined)
                await abortable(signal, page.mouse.move(x, y, { steps: 15 }));
            else
                throw new Error("pass a selector or both x and y");
            return { session: ref.session, ok: true, url: page.url() };
        },
    }),
    stealthTool({
        name: "stealth_cookies_get",
        label: "Patchright cookies get",
        description: "Export cookies — INCLUDING httpOnly cookies that document.cookie / stealth_evaluate cannot see. " +
            "Returns full attributes (domain, path, expires, httpOnly, secure, sameSite).",
        parameters: Type.Object({
            urls: Type.Optional(Type.Array(Type.String(), { description: "Limit to these URLs. Omit for all." })),
            ...sessionParam,
        }),
        outputSchema: closed({ session: Str, count: Num, cookies: Type.Array(Type.Object({ name: Str, value: Str })) }),
        network: true,
        run: async ({ urls }, { ref, signal }) => {
            const sess = await abortable(signal, ensureSession(ref));
            const cookies = urls && urls.length ? await sess.context.cookies(urls) : await sess.context.cookies();
            return { session: ref.session, count: cookies.length, cookies };
        },
    }),
    stealthTool({
        name: "stealth_cookies_set",
        label: "Patchright cookies set",
        description: "Import cookies (e.g. transfer a solved/logged-in session). Uses addCookies.",
        parameters: Type.Object({
            cookies: Type.Array(CookieSchema, { description: "Cookies to add. Each needs name+value and url OR domain+path." }),
            ...sessionParam,
        }),
        outputSchema: closed({ session: Str, added: Num }),
        run: async ({ cookies }, { ref, signal }) => {
            const sess = await abortable(signal, ensureSession(ref));
            await sess.context.addCookies(cookies);
            return { session: ref.session, added: cookies.length };
        },
    }),
    stealthTool({
        name: "stealth_cookies_clear",
        label: "Patchright cookies clear",
        description: "Clear all cookies in one of your browsers.",
        parameters: Type.Object({ ...sessionParam }),
        outputSchema: closed({ session: Str, cleared: Bool }),
        run: async (_p, { ref, signal }) => {
            const sess = await abortable(signal, ensureSession(ref));
            await sess.context.clearCookies();
            return { session: ref.session, cleared: true };
        },
    }),
    stealthTool({
        name: "stealth_status",
        label: "Patchright status",
        description: "List your open stealth browsers, or report one browser's current URL/title/tab count.",
        parameters: Type.Object({
            session: Type.Optional(Type.String({ description: "Report just this browser. Omit to list all of yours." })),
        }),
        outputSchema: Type.Union([
            closed({
                open: Num,
                sessions: Type.Array(closed({ session: Str, url: Type.Union([Str, Type.Null()]), tabs: Num, proxy: Type.Union([Str, Type.Null()]) })),
                channel: Str,
                headless: Bool,
            }),
            closed({ session: Str, open: Type.Literal(false) }),
            closed({ session: Str, open: Type.Literal(true), url: Str, title: Str, tabs: Num, config: ConfigOut }),
        ]),
        network: true,
        run: async ({ session }, { ref, owner }) => {
            if (session === undefined) {
                const mine = [...sessions.entries()].filter(([, s]) => s.agentId === owner.agentId);
                return {
                    open: mine.length,
                    sessions: mine.map(([name, s]) => ({
                        session: name,
                        url: s.page.isClosed() ? null : s.page.url(),
                        tabs: s.context.pages().length,
                        proxy: s.config.proxy,
                    })),
                    channel: CHANNEL,
                    headless: HEADLESS,
                };
            }
            const s = sessions.get(ref.name);
            if (!s)
                return { session: ref.session, open: false };
            const page = s.page.isClosed() ? s.context.pages().at(-1) : s.page;
            if (!page)
                return { session: ref.session, open: false };
            return {
                session: ref.session,
                open: true,
                url: page.url(),
                title: await page.title(),
                tabs: s.context.pages().length,
                config: s.config,
            };
        },
    }),
    stealthTool({
        name: "stealth_close",
        label: "Patchright close",
        description: "Close one of your browsers (releases its profile lock), or all of yours with all=true.",
        parameters: Type.Object({
            session: Type.Optional(Type.String({ description: "Browser to close. Omit for your default browser." })),
            all: Type.Optional(Type.Boolean({ description: "Close every browser your agent has open." })),
        }),
        outputSchema: closed({ closed: Type.Array(Str) }),
        run: async ({ all }, { ref, owner }) => {
            const pendingLaunch = launching.get(ref.name);
            if (pendingLaunch)
                await pendingLaunch.catch(() => { });
            const targets = all
                ? [...sessions.entries()].filter(([, s]) => s.agentId === owner.agentId)
                : sessions.has(ref.name)
                    ? [[ref.name, sessions.get(ref.name)]]
                    : [];
            for (const [name] of targets)
                sessions.delete(name);
            await Promise.allSettled(targets.map(([, s]) => closeContext(s.context)));
            return { closed: targets.map(([name]) => name) };
        },
    }),
];
const entry = defineToolPlugin({
    id: "patchright-stealth",
    name: "Patchright Stealth Browser",
    description: "Interactive stealth browser via Patchright (real Chrome, persistent profile, isolated per agent). " +
        "Use for bot-detected sites (DataDome/Cloudflare/Akamai). Separate from OpenClaw's native browser tool.",
    configSchema,
    tools: (tool) => toolDefs.map((def) => tool(def)),
});
// Close every Chrome this plugin started when the plugin instance is disposed
// (hot reload, replacement, gateway shutdown) so no orphan keeps a profile locked.
const baseRegister = entry.register;
entry.register = (api) => {
    baseRegister?.(api);
    registerCleanup(api);
};
export default entry;

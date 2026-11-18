import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import entry, {
  WORKSPACE_ORIGIN,
  checkChromeArgs,
  checkProxyServer,
  checkRemoteUrl,
  isBlockedAddress,
  resolveNavigationTarget,
  resolveScreenshotPath,
  resolveSessionName,
  toEvaluationSource,
  workspaceFileFor,
} from "./index.js";
import { realpath, writeFile } from "node:fs/promises";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

const TOOL_NAMES = [
  "stealth_open",
  "stealth_navigate",
  "stealth_content",
  "stealth_click",
  "stealth_fill",
  "stealth_type",
  "stealth_press",
  "stealth_wait",
  "stealth_evaluate",
  "stealth_screenshot",
  "stealth_box",
  "stealth_mouse_move",
  "stealth_mouse_button",
  "stealth_drag",
  "stealth_hover",
  "stealth_cookies_get",
  "stealth_cookies_set",
  "stealth_cookies_clear",
  "stealth_status",
  "stealth_close",
];

type Registered = { factory: (ctx: Record<string, unknown>) => any; opts?: { name?: string } };

function registerWithFakeApi() {
  const tools: Registered[] = [];
  const disposers: Array<() => unknown> = [];
  const api = {
    pluginConfig: {},
    config: { agents: { entries: { main: {}, buyer: {} } } },
    lifecycle: { onDispose: (fn: () => unknown) => disposers.push(fn) },
    registerTool: (factory: Registered["factory"], opts?: Registered["opts"]) => tools.push({ factory, opts }),
  };
  (entry as unknown as { register: (api: unknown) => void }).register(api);
  return { tools, disposers };
}

describe("patchright-stealth metadata", () => {
  it("declares all tools", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
  });

  it("makes session optional everywhere", () => {
    for (const tool of getToolPluginMetadata(entry)!.tools) {
      const required = (tool.parameters as { required?: string[] }).required ?? [];
      expect(required, tool.name).not.toContain("session");
    }
  });
});

describe("registration", () => {
  it("registers every tool as a factory and a dispose hook", () => {
    const { tools, disposers } = registerWithFakeApi();
    expect(tools.map((t) => t.opts?.name)).toEqual(TOOL_NAMES);
    expect(disposers).toHaveLength(1);
  });

  it("offers no tools without a trusted agent id", () => {
    const { tools } = registerWithFakeApi();
    expect(tools[0].factory({})).toBeNull();
  });

  it("builds tools with output schemas and network taint for page content", () => {
    const { tools } = registerWithFakeApi();
    const built = tools.map((t) => t.factory({ agentId: "main" }));
    for (const tool of built) expect(tool.outputSchema, tool.name).toBeTruthy();
    const tainted = built.filter((t) => t.resultContentSource === "network").map((t) => t.name);
    expect(tainted).toEqual(["stealth_navigate", "stealth_content", "stealth_evaluate", "stealth_cookies_get", "stealth_status"]);
  });
});

describe("resolveSessionName", () => {
  it("defaults to the agent's own profile", () => {
    expect(resolveSessionName("buyer", undefined)).toBe("buyer");
    expect(resolveSessionName("buyer", "buyer")).toBe("buyer");
  });

  it("keeps names already in the agent's namespace", () => {
    expect(resolveSessionName("buyer", "buyer-checkout")).toBe("buyer-checkout");
  });

  it("prefixes names outside the agent's namespace", () => {
    expect(resolveSessionName("main", "bookings")).toBe("main-bookings");
    expect(resolveSessionName("main", "buyer-checkout")).toBe("main-buyer-checkout");
  });

  it("sanitizes unsafe characters", () => {
    expect(resolveSessionName("main", "../etc")).toBe("main-.._etc");
    expect(resolveSessionName("main", "..")).toBe("main");
  });

  it("refuses names that land in a longer agent id's namespace", () => {
    expect(() => resolveSessionName("shop", "us-x", ["shop", "shop-us"])).toThrow(/namespace/);
    expect(resolveSessionName("shop", "eu-x", ["shop", "shop-us"])).toBe("shop-eu-x");
  });
});

describe("resolveScreenshotPath", () => {
  const shots = join(homedir(), ".openclaw", "media", "patchright");

  it("defaults to the media folder", async () => {
    const out = await resolveScreenshotPath(undefined, { agentId: "main" }, "main");
    expect(out.startsWith(shots)).toBe(true);
  });

  it("allows workspace-relative paths", async () => {
    const ws = await mkdtemp(join(tmpdir(), "ws-"));
    const out = await resolveScreenshotPath("shots/a.png", { agentId: "main", workspaceDir: ws }, "main");
    expect(out.endsWith(join("shots", "a.png"))).toBe(true);
  });

  it("rejects paths outside the workspace and media folder", async () => {
    const ws = await mkdtemp(join(tmpdir(), "ws-"));
    await expect(resolveScreenshotPath("/etc/x.png", { agentId: "main", workspaceDir: ws }, "main")).rejects.toThrow();
    await expect(resolveScreenshotPath("../x.png", { agentId: "main", workspaceDir: ws }, "main")).rejects.toThrow();
    await expect(resolveScreenshotPath("a.sh", { agentId: "main", workspaceDir: ws }, "main")).rejects.toThrow(/png/);
  });

  it("rejects symlinks that escape the workspace", async () => {
    const ws = await mkdtemp(join(tmpdir(), "ws-"));
    const outside = await mkdtemp(join(tmpdir(), "out-"));
    await mkdir(join(ws, "sub"));
    await symlink(outside, join(ws, "sub", "link"));
    await expect(resolveScreenshotPath("sub/link/x.png", { agentId: "main", workspaceDir: ws }, "main")).rejects.toThrow(/symlink/);
  });
});

describe("toEvaluationSource", () => {
  it("leaves expressions and statements alone", () => {
    expect(toEvaluationSource("document.title")).toBe("document.title");
    expect(toEvaluationSource("const a = 1; a + 1")).toBe("const a = 1; a + 1");
  });

  it("calls function literals", () => {
    expect(toEvaluationSource("() => 1")).toBe("(() => 1)()");
    expect(toEvaluationSource("async () => 1")).toBe("(async () => 1)()");
    expect(toEvaluationSource("function () { return 1 }")).toBe("(function () { return 1 })()");
  });

  it("leaves immediately invoked functions alone", () => {
    expect(toEvaluationSource("(() => 1)()")).toBe("(() => 1)()");
    expect(toEvaluationSource("(async () => 1)()")).toBe("(async () => 1)()");
  });
});

const closedNet = { allowPrivate: false, allowHosts: [] as string[] };

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local and reserved IPv4", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("blocks IPv6 loopback, ULA, link-local and embedded private IPv4", () => {
    for (const ip of ["::1", "[::1]", "::", "fd00::1", "fe80::1%en0", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "2002:c0a8:101::1", "ff02::1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "64:ff9b::808:808", "::ffff:8.8.8.8"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });
});

describe("checkRemoteUrl", () => {
  it("refuses non-http schemes", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "chrome://settings", "data:text/html,x"]) {
      expect(await checkRemoteUrl(url, closedNet), url).toMatch(/not allowed/);
    }
  });

  it("refuses local and private hosts in every spelling", async () => {
    for (const url of [
      "http://localhost:8080/",
      "http://LOCALHOST./",
      "http://app.localhost/",
      "http://127.0.0.1/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f.0.0.1/",
      "http://017700000001/",
      "http://[::1]:3000/",
      "http://[::ffff:127.0.0.1]/",
      "http://169.254.169.254/latest/meta-data/",
      "https://192.168.1.1/",
    ]) {
      expect(await checkRemoteUrl(url, closedNet), url).not.toBeNull();
    }
  });

  it("allows public IP literals", async () => {
    expect(await checkRemoteUrl("https://1.1.1.1/", closedNet)).toBeNull();
  });

  it("honours the operator allowlist and the allowPrivate switch", async () => {
    const net = { allowPrivate: false, allowHosts: ["localhost:5173", "10.0.0.5"] };
    expect(await checkRemoteUrl("http://localhost:5173/", net)).toBeNull();
    expect(await checkRemoteUrl("http://localhost:5174/", net)).not.toBeNull();
    expect(await checkRemoteUrl("http://10.0.0.5:9000/", net)).toBeNull();
    expect(await checkRemoteUrl("http://127.0.0.1/", { allowPrivate: true, allowHosts: [] })).toBeNull();
    expect(await checkRemoteUrl("file:///etc/passwd", { allowPrivate: true, allowHosts: [] })).not.toBeNull();
  });
});

describe("checkProxyServer", () => {
  it("refuses inline proxies on local addresses", async () => {
    expect(await checkProxyServer("http://127.0.0.1:8080", closedNet)).not.toBeNull();
    expect(await checkProxyServer("socks5://10.0.0.2:1080", closedNet)).not.toBeNull();
    expect(await checkProxyServer("localhost:3128", closedNet)).not.toBeNull();
    expect(await checkProxyServer("http://1.1.1.1:8080", closedNet)).toBeNull();
  });
});

describe("resolveNavigationTarget", () => {
  it("maps workspace files to the workspace origin and refuses everything outside", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "ws-")));
    await mkdir(join(ws, "cards"));
    await writeFile(join(ws, "cards", "deal card.html"), "<p>hi</p>");
    const fileUrl = `file://${join(ws, "cards", "deal card.html")}`;
    expect(await resolveNavigationTarget(fileUrl, ws, closedNet)).toBe(`${WORKSPACE_ORIGIN}/cards/deal%20card.html`);
    await expect(resolveNavigationTarget("file:///etc/hosts", ws, closedNet)).rejects.toThrow(/inside your workspace/);
    await expect(resolveNavigationTarget(fileUrl, undefined, closedNet)).rejects.toThrow(/workspace/);
    await expect(resolveNavigationTarget("http://127.0.0.1:9/", ws, closedNet)).rejects.toThrow(/blocked/);
    await expect(resolveNavigationTarget("view-source:https://example.com", ws, closedNet)).rejects.toThrow(/blocked/);
    expect(await resolveNavigationTarget("about:blank", ws, closedNet)).toBe("about:blank");
  });

  it("refuses workspace symlinks that point outside", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "ws-")));
    await symlink("/etc/hosts", join(ws, "hosts.html"));
    await expect(resolveNavigationTarget(`file://${join(ws, "hosts.html")}`, ws, closedNet)).rejects.toThrow(/inside your workspace/);
    expect(await workspaceFileFor(`${WORKSPACE_ORIGIN}/hosts.html`, ws)).toBeNull();
  });
});

describe("workspaceFileFor", () => {
  it("serves files inside the workspace only", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "ws-")));
    await writeFile(join(ws, "a.css"), "p{}");
    expect(await workspaceFileFor(`${WORKSPACE_ORIGIN}/a.css`, ws)).toBe(join(ws, "a.css"));
    expect(await workspaceFileFor(`${WORKSPACE_ORIGIN}/%2e%2e/%2e%2e/etc/hosts`, ws)).toBeNull();
    expect(await workspaceFileFor(`${WORKSPACE_ORIGIN}/missing.css`, ws)).toBeNull();
    expect(await workspaceFileFor(`${WORKSPACE_ORIGIN}/`, ws)).toBeNull();
    expect(await workspaceFileFor("https://example.com/a.css", ws)).toBeNull();
  });
});

describe("checkChromeArgs", () => {
  it("keeps display flags", () => {
    expect(checkChromeArgs(["--window-size=430,932", "--hide-scrollbars", "--force-device-scale-factor=2", "--lang=en-GB"])).toHaveLength(4);
  });

  it("refuses everything else", () => {
    for (const arg of [
      "--remote-debugging-port=9222",
      "--renderer-cmd-prefix=/bin/sh",
      "--disable-web-security",
      "--host-resolver-rules=MAP * 127.0.0.1",
      "--user-data-dir=/tmp/x",
      "--window-size=1;rm",
      "--hide-scrollbars=1",
    ]) {
      expect(() => checkChromeArgs([arg]), arg).toThrow();
    }
  });
});

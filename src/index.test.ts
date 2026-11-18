import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import entry, { resolveScreenshotPath, resolveSessionName, toEvaluationSource } from "./index.js";
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
});

import { describe, expect, it } from "vitest";
import entry from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

describe("patchright-stealth", () => {
  it("declares tool metadata", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual([
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
    ]);
  });
});

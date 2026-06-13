import { chromium } from "patchright";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

const PROFILE = join(homedir(), ".openclaw", "browser", "patchright-stealth-TEST");
const SHOTS = join(homedir(), ".openclaw", "media", "patchright");
await mkdir(SHOTS, { recursive: true });

async function run(headless) {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",
    headless,
    viewport: null,
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  // Baseline signals straight from the page.
  await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
  const webdriver = await page.evaluate(() => navigator.webdriver);
  const ua = await page.evaluate(() => navigator.userAgent);

  // Rebrowser detector: specifically probes the Runtime.enable / CDP leaks Patchright fixes.
  await page.goto("https://bot-detector.rebrowser.net/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000);
  await page.screenshot({ path: join(SHOTS, "check-rebrowser.png"), fullPage: true });
  const rebrowser = await page.evaluate(() => document.body.innerText.slice(0, 1500));

  // Sannysoft: broad fingerprint panel.
  await page.goto("https://bot.sannysoft.com/", { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(SHOTS, "check-sannysoft.png"), fullPage: true });

  await ctx.close();
  return { headless, webdriver, ua, rebrowser };
}

let r;
try {
  r = await run(false);
  console.log("MODE: headful (channel=chrome)");
} catch (e) {
  console.log("headful failed (" + e.message + "); retrying headless");
  r = await run(true);
  console.log("MODE: headless fallback");
}

console.log("navigator.webdriver:", r.webdriver);
console.log("userAgent:", r.ua);
console.log("--- rebrowser bot-detector results ---");
console.log(r.rebrowser);
console.log("--- screenshots saved under ~/.openclaw/media/patchright/ ---");

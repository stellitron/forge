// Captures the screenshots used by the README, docs and website from the browser preview.
//
//   npm run dev            (in another terminal)
//   npm run screenshots
//
// Uses your installed Chrome (set CHROME_PATH to override). The window is kept small so text in
// the images stays readable when they are shown at page width. Docs get the default Forge look
// (docs/images/); the website gets light and dark pairs in the Sage palette, which matches
// stellitron.com (site/assets/). The preview sends real requests to jsonplaceholder.typicode.com.
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.FORGE_URL ?? "http://localhost:1420";
const CHROME =
  process.env.CHROME_PATH ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find(existsSync);
if (!CHROME) throw new Error("Chrome not found. Set CHROME_PATH.");
try {
  await fetch(BASE);
} catch {
  throw new Error(`Nothing at ${BASE}. Start the preview with: npm run dev`);
}

const W = 1180;
const H = 720;
const browser = await puppeteer.launch({ executablePath: CHROME, defaultViewport: { width: W, height: H, deviceScaleFactor: 2 } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (page, text) => page.locator(`::-p-text(${text})`).click();

async function open(query) {
  const page = await browser.newPage();
  await page.goto(`${BASE}/?${query}`, { waitUntil: "networkidle0" });
  await sleep(600);
  return page;
}

async function sent(look) {
  const page = await open(`tour=0&${look}`);
  await click(page, "Users");
  await click(page, "List users");
  await sleep(300);
  await click(page, "Send");
  await page.waitForSelector("::-p-text(200)", { timeout: 15000 });
  await click(page, "Headers");
  await sleep(500);
  return page;
}

async function settings(look) {
  const page = await open(`tour=0&${look}`);
  await page.keyboard.down("Meta");
  await page.keyboard.press(",");
  await page.keyboard.up("Meta");
  await click(page, "AI model");
  await click(page, "Anthropic (Claude)");
  await sleep(400);
  return page;
}

async function shoot(page, file, height = H) {
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: W, height } });
  console.log("saved", file);
}

/** Crops to one part of the window, so it can be shown near actual size on a page. */
async function shootPart(page, selector, file, maxW, maxH) {
  const r = await page.evaluate((sel) => {
    const b = document.querySelector(sel).getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }, selector);
  await page.screenshot({ path: file, clip: { x: r.x, y: r.y, width: Math.min(r.width, maxW), height: Math.min(r.height, maxH) } });
  console.log("saved", file);
}

/** `want` lists the shots a page actually uses: request, data and settings. */
async function set(dir, look, suffix, crop = false, want = ["request", "data", "settings"]) {
  await mkdir(dir, { recursive: true });
  const req = await sent(look);
  if (crop) await shootPart(req, ".main", `${dir}/request${suffix}.png`, 920, 430);
  else await shoot(req, `${dir}/request${suffix}.png`, 560);
  if (want.includes("data")) {
  await req.locator("::-p-text(Data)").click();
  await sleep(500);
  if (crop) await shootPart(req, ".main .split > .pane:last-child", `${dir}/data${suffix}.png`, 600, 260);
  else await shoot(req, `${dir}/data${suffix}.png`, 420);
  }
  await req.close();
  if (!want.includes("settings")) return;
  const s = await settings(look);
  if (crop) await shootPart(s, ".settings-page", `${dir}/settings${suffix}.png`, 700, 470);
  else await shoot(s, `${dir}/settings${suffix}.png`, 620);
  await s.close();
}

// Docs: default look.
await set("docs/images", "theme=dark", "-dark", false, ["request", "data"]);
await set("docs/images", "theme=light", "-light", false, ["request", "settings"]);
const tour = await open("theme=dark");
for (let i = 0; i < 2; i++) await tour.keyboard.press("ArrowRight"), await sleep(250);
await sleep(3000);
await shoot(tour, "docs/images/onboarding.png");
await tour.close();

// Website: Sage palette, light and dark.
await set("site/assets", "theme=light&palette=sage", "-light", true, ["request", "data"]);
await set("site/assets", "theme=dark&palette=sage", "-dark", true, ["request", "data"]);

await browser.close();

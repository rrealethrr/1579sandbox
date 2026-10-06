// Drives the built app in headless Chromium and saves screenshots.
// Usage: node scripts/screenshots.mjs [outDir]
import { chromium } from "playwright-core";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const out = resolve(process.argv[2] ?? "screenshots");
const url = pathToFileURL(resolve("dist/index.html")).href;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2, colorScheme: "dark", ignoreHTTPSErrors: true });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
await page.goto(url);
await page.waitForTimeout(600);

const shot = async (name) => { await page.waitForTimeout(350); await page.screenshot({ path: `${out}/${name}.png` }); };
const sb = (fn, ...args) => page.evaluate(([f, a]) => window.sandbox[f](...a), [fn, args]);

await sb("loadExample", 2); await shot("combination");
await sb("select", "R2"); await shot("combination-editing");
await sb("select", ""); await sb("loadExample", 3); await shot("bridge");

// Draw a circuit by hand with the mouse: a loop, a source and two resistors.
await page.evaluate(() => { window.sandbox.doc = {}; });
await page.evaluate(() => { const s = window.sandbox; s.doc = {}; });
const box = await page.locator("#board").boundingBox();
const g = 40;
const origin = { x: 260, y: 260 };
const at = (gx, gy) => [origin.x + gx * g, origin.y + gy * g];
// fix the view so grid math is predictable
await page.evaluate(([x, y]) => { const s = window.sandbox; s.fitView(); }, [0, 0]);
await page.keyboard.press("w");
const view = await page.evaluate(() => {
  const m = document.querySelector("#world").getAttribute("transform").match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/);
  return { tx: +m[1], ty: +m[2], k: +m[3] };
});
const sp = (gx, gy) => [box.x + view.tx + gx * g * view.k, box.y + view.ty + gy * g * view.k];
const stroke = async (pts) => {
  await page.mouse.move(...sp(...pts[0]));
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(...sp(...p), { steps: 8 });
  await page.mouse.up();
};
await stroke([[-4, 0], [-4, -3], [4, -3], [4, 3], [-4, 3], [-4, 0]]);
await stroke([[0, -3], [0, 3]]);
await page.keyboard.press("b");
await page.mouse.click(...sp(-4, -0.5));
await page.keyboard.type("9");
await page.keyboard.press("Escape");
await page.keyboard.press("r");
await page.mouse.click(...sp(-2.5, -3));
await page.keyboard.type("1k");
await page.keyboard.press("Escape");
await page.mouse.click(...sp(0, 0.5));
await page.keyboard.press("Tab"); // R blank, type power instead
await page.keyboard.press("Tab");
await page.keyboard.press("Tab");
await page.keyboard.type("10m");
await page.keyboard.press("Escape");
await page.mouse.click(...sp(4, 0.5));
await page.keyboard.type("2k");
await page.keyboard.press("Escape");
await page.keyboard.press("v");
await page.mouse.move(...sp(8, 6));
await shot("hand-drawn");

await browser.close();
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("saved to", out);

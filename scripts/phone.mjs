// Portrait phone screenshots: node scripts/phone.mjs [outDir]
import { chromium } from "playwright-core";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const out = resolve(process.argv[2] ?? "screenshots");
const url = pathToFileURL(resolve("dist/index.html")).href;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: "dark", ignoreHTTPSErrors: true });
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto(url);
await p.waitForTimeout(500);
const shot = async (n) => { await p.waitForTimeout(300); await p.screenshot({ path: `${out}/${n}.png` }); };
const center = (sel, i) => p.evaluate(([s, i]) => { const r = document.querySelectorAll(s)[i].getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, [sel, i]);
await p.evaluate(() => window.sandbox.loadExample(2));
await shot("phone-portrait");
await p.touchscreen.tap(...await center(".part-R", 1));
await shot("phone-editing");
await p.touchscreen.tap(...await center("#ed-close", 0));
await p.touchscreen.tap(...await center("#peek", 0));
await shot("phone-results");
await p.touchscreen.tap(...await center("#peek", 0));
await p.evaluate(() => window.sandbox.loadExample(3));
await shot("phone-bridge");
// pinch: two touch pointers moving apart
const before = await p.evaluate(() => document.querySelector("#world").getAttribute("transform"));
await p.evaluate(() => {
  const b = document.querySelector("#board");
  const ev = (type, id, x, y) => b.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", clientX: x, clientY: y, bubbles: true }));
  const n0 = Object.keys(window.sandbox.doc).length;
  ev("pointerdown", 1, 150, 400); ev("pointerdown", 2, 240, 400);
  for (let i = 1; i <= 10; i++) { ev("pointermove", 1, 150 - i * 6, 400); ev("pointermove", 2, 240 + i * 6, 400); }
  ev("pointerup", 1, 90, 400); ev("pointerup", 2, 300, 400);
  window.__n = [n0, Object.keys(window.sandbox.doc).length];
});
console.log("pinch", before, "->", await p.evaluate(() => document.querySelector("#world").getAttribute("transform")), "items", await p.evaluate(() => window.__n));
await browser.close();
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }

#!/usr/bin/env node
// missing-lcp: load a page in Chromium the way Lighthouse's mobile run does, record every Largest Contentful Paint
// candidate Chrome reports, and when there is none, say which first-screen elements Chrome skipped and why.
//
// Chrome only reports LCP for content it treats as foreground. It skips an image or background that fills the whole
// viewport (treated as a background), anything transparent or off-screen when it is first painted, text clipped to a
// pixel, and near-empty "placeholder" images. A page whose first screen is only those reports no LCP at all, and
// Lighthouse fails it with NO_LCP.
import { chromium } from 'playwright';

const HELP = `usage: missing-lcp <url...> [--desktop] [--no-throttle] [--json] [--wait <ms>]

  --desktop      1350x940 desktop viewport instead of a 412x823 phone
  --no-throttle  skip Lighthouse's mobile throttling (4x CPU, 150 ms RTT, 1.6 Mbps down)
  --json         one JSON object per URL instead of the readable report
  --wait <ms>    how long to watch after the load event (default 3000)

exit code 1 when any URL records no LCP`;

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) { console.log(HELP); process.exit(args.length ? 0 : 2); }
const flag = (f) => args.includes(f);
const waitAt = args.indexOf('--wait'), wait = waitAt >= 0 ? +args[waitAt + 1] : 3000;
const urls = args.filter((a, i) => !a.startsWith('--') && !(waitAt >= 0 && i === waitAt + 1));

// Runs in the page before any of its own scripts: records LCP entries and two snapshots of the first screen, one on
// the first frame after first contentful paint (what Chrome saw when it first painted) and one after load.
function probe() {
  const W = window; W.__mlcp = { lcp: [], first: null, fcp: 0 };
  const describe = (el) => el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') : '(removed)';
  new PerformanceObserver((l) => { for (const e of l.getEntries()) W.__mlcp.lcp.push({ t: Math.round(e.startTime), size: e.size, el: describe(e.element), url: (e.url || '').slice(-80) }); }).observe({ type: 'largest-contentful-paint', buffered: true });
  W.__mlcp.snapshot = () => {
    const vw = innerWidth, vh = innerHeight, out = [];
    const opacity = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= +getComputedStyle(n).opacity; return o; };
    const consider = (el, kind) => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)), h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      const src = kind === 'image' ? (el.currentSrc || el.src || '') : kind === 'background' ? (s.backgroundImage.match(/url\(["']?([^"')]+)/) || [])[1] || '' : '';
      const res = src && performance.getEntriesByName(new URL(src, location.href).href)[0];
      out.push({ el: describe(el), kind, visibleArea: Math.round(w * h), full: w >= vw - 1 && h >= vh - 1, opacity: +opacity(el).toFixed(2), hidden: s.visibility === 'hidden' || s.display === 'none',
        clipped: (r.width <= 2 || r.height <= 2 || /inset\(50%\)/.test(s.clipPath) || /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(s.clip)), offscreen: r.width > 2 && r.height > 2 && w * h === 0,
        bitsPerPixel: res && res.encodedBodySize && w * h ? +((res.encodedBodySize * 8) / (w * h)).toFixed(3) : null, text: kind === 'text' ? el.textContent.trim().replace(/\s+/g, ' ').slice(0, 40) : undefined });
    };
    for (const el of document.querySelectorAll('img,video[poster],svg image')) consider(el, 'image');
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el);
      if (s.backgroundImage && s.backgroundImage.includes('url(')) consider(el, 'background');
      if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)) consider(el, 'text');
    }
    return out;
  };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint' && !W.__mlcp.first) { W.__mlcp.fcp = Math.round(e.startTime); requestAnimationFrame(() => { W.__mlcp.first = W.__mlcp.snapshot(); }); } }).observe({ type: 'paint', buffered: true });
}

// Why Chrome would not count an element, judged from what it looked like on its first frame.
function reasons(first, late) {
  const why = [];
  const at = first || late;
  if (late.full && (late.kind === 'image' || late.kind === 'background')) why.push(['fills-viewport', 'fills the whole viewport, so Chrome treats it as a background']);
  if (at.hidden) why.push(['hidden', 'visibility:hidden or display:none']);
  if (at.clipped) why.push(['clipped', 'clipped or squeezed to a pixel (visually hidden text never counts)']);
  if (first && first.offscreen && late.visibleArea > 0) why.push(['offscreen-at-first-paint', 'was outside the viewport when first painted (an entrance animation from off-screen?)']);
  if (first && first.opacity === 0 && late.opacity > 0) why.push(['transparent-at-first-paint', 'was at opacity 0 when first painted (a fade-in?)']);
  if (late.bitsPerPixel !== null && late.bitsPerPixel < 0.05) why.push(['low-entropy', `only ${late.bitsPerPixel} bits per displayed pixel; Chrome skips near-empty placeholder images`]);
  return why;
}
const FIX = {
  'fills-viewport': 'give the first screen one element Chrome counts: a visible headline or button, or keep the image a little smaller than the viewport',
  'offscreen-at-first-paint': 'start the entrance on screen: animate scale or tilt instead of sliding in from outside the viewport',
  'transparent-at-first-paint': 'start visible: animate transform, or fade from a low opacity rather than 0',
  clipped: 'a visually hidden headline never counts; show one real headline',
  hidden: 'reveal the content without visibility:hidden or display:none at first paint',
  'low-entropy': 'use a real image (or a visible headline) as the first-screen content',
};

const browser = await chromium.launch();
let missing = 0;
for (const url of urls) {
  const ctx = await browser.newContext(flag('--desktop') ? { viewport: { width: 1350, height: 940 } } : { viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  if (!flag('--no-throttle')) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }
  await page.addInitScript(probe);
  let result;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await page.waitForTimeout(wait);
    const { lcp, first, fcp, late } = await page.evaluate(() => ({ lcp: window.__mlcp.lcp, first: window.__mlcp.first, fcp: window.__mlcp.fcp, late: window.__mlcp.snapshot() }));
    const firstBy = new Map((first || []).map((c) => [c.el + c.kind, c]));
    const screen = late.filter((c) => c.visibleArea > 0 || (firstBy.get(c.el + c.kind) || {}).visibleArea > 0 || c.clipped)
      .map((c) => ({ ...c, why: reasons(firstBy.get(c.el + c.kind), c) }))
      .sort((a, b) => b.visibleArea - a.visibleArea).slice(0, 8);
    result = { url, fcp, lcp: lcp.length ? lcp[lcp.length - 1] : null, candidates: lcp, firstScreen: screen };
  } catch (e) { result = { url, error: String(e.message || e).split('\n')[0] }; }
  await ctx.close();
  if (!result.error && !result.lcp) missing++;
  if (flag('--json')) { console.log(JSON.stringify(result)); continue; }
  if (result.error) { console.log(`\n${url}\n  error: ${result.error}`); continue; }
  console.log(`\n${url}`);
  if (result.lcp) { console.log(`  LCP ${(result.lcp.t / 1000).toFixed(2)} s  ${result.lcp.el}  (${result.lcp.size} px²${result.lcp.url ? ', ' + result.lcp.url : ''})`); continue; }
  console.log(`  NO LCP. First contentful paint at ${(result.fcp / 1000).toFixed(2)} s, but nothing on the first screen qualified.`);
  const fixes = new Set();
  for (const c of result.firstScreen) {
    console.log(`  - ${c.kind} ${c.el}${c.text ? ` "${c.text}"` : ''}  ${c.visibleArea} px² visible`);
    for (const [code, text] of c.why) { console.log(`      ${text}`); fixes.add(FIX[code]); }
  }
  if (fixes.size) { console.log('  Fix:'); for (const f of fixes) console.log(`    · ${f}`); }
}
await browser.close();
process.exit(missing ? 1 : 0);

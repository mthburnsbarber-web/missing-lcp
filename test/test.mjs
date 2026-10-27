// Serves the fixtures on 127.0.0.1, runs the CLI on each and checks the verdicts.
// The photo is generated here (coloured noise, so Chrome cannot mistake it for an empty placeholder).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const photo = path.join(dir, 'photo.jpg');
if (!fs.existsSync(photo)) {
  const b = await chromium.launch(), p = await b.newPage();
  const data = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 900; c.height = 560; const g = c.getContext('2d'), img = g.createImageData(900, 560); for (let i = 0; i < img.data.length; i += 4) { img.data[i] = Math.random() * 255; img.data[i + 1] = Math.random() * 255; img.data[i + 2] = Math.random() * 255; img.data[i + 3] = 255; } g.putImageData(img, 0, 0); return c.toDataURL('image/jpeg', 0.7); });
  fs.writeFileSync(photo, Buffer.from(data.split(',')[1], 'base64')); await b.close();
}
const types = { '.html': 'text/html', '.css': 'text/css', '.jpg': 'image/jpeg' };
const server = http.createServer((q, r) => { const f = path.join(dir, path.basename(new URL(q.url, 'http://x').pathname)); if (!fs.existsSync(f)) { r.writeHead(404).end(); return; } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;
const cli = path.join(dir, '..', '..', 'missing-lcp.mjs');
const run = (page) => new Promise((ok) => execFile(process.execPath, [cli, base + page, '--json', '--no-throttle', '--wait', '1800'], (err, out) => ok(JSON.parse(out.trim().split('\n').pop()))));
let fail = 0; const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fail++; };
const codes = (r) => r.firstScreen.flatMap((c) => c.why.map(([code]) => code));
const a = await run('full-bleed.html');
check(!a.lcp, 'full-bleed hero: no LCP'); check(codes(a).includes('fills-viewport'), 'full-bleed hero: the image is named as filling the viewport'); check(codes(a).includes('clipped'), 'full-bleed hero: the visually hidden headline is named');
const b = await run('offscreen-intro.html');
check(!b.lcp, 'button sliding in from below: no LCP'); check(codes(b).includes('offscreen-at-first-paint'), 'button sliding in from below: named as off-screen at first paint');
const c = await run('fixed.html');
check(!!c.lcp && /a\.cta|span|a/.test(c.lcp.el), `button dealt in where it sits: LCP recorded (${c.lcp ? c.lcp.el + ' at ' + c.lcp.t + ' ms' : 'none'})`);
server.close(); process.exit(fail ? 1 : 0);

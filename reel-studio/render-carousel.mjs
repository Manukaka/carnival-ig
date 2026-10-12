// Usage: node render-carousel.mjs spec.json out/dir  -> out/dir/01.jpg ... (1080x1350)
import { chromium } from 'playwright';
import path from 'node:path'; import fs from 'node:fs';
const [spec, dir] = process.argv.slice(2);
fs.mkdirSync(dir, { recursive: true });
const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1080, height: 1350 } });
await p.addInitScript(`window.SPEC = ${fs.readFileSync(spec, 'utf8')};`);
await p.goto('file://' + path.resolve('engine/carousel.html'));
await p.evaluate(() => window.ready);
const n = await p.evaluate(() => window.COUNT); const files = [];
for (let i = 0; i < n; i++) { await p.evaluate(i => window.show(i), i); const f = path.join(dir, String(i + 1).padStart(2, '0') + '.jpg'); await p.screenshot({ path: f, type: 'jpeg', quality: 92 }); files.push(f); }
await b.close(); console.log(JSON.stringify({ slides: files }));

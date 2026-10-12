// Usage: node render.mjs templates/brand-intro.html out/reel.mp4 [fps=30] [audio.wav]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path'; import fs from 'node:fs';
const [tpl, out, fpsArg, audio] = process.argv.slice(2);
const fps = Number(fpsArg || 30);
fs.mkdirSync(path.dirname(out), { recursive: true });
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
await page.goto('file://' + path.resolve(tpl));
await page.evaluate(() => window.ready);
const dur = await page.evaluate(() => window.DURATION);
const n = Math.round(dur * fps);
const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-'];
if (audio) args.push('-i', audio);
args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps));
if (audio) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
args.push('-movflags', '+faststart', out);
const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
for (let i = 0; i < n; i++) {
  await page.evaluate(t => window.seek(t), i / fps);
  const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
  if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
}
ff.stdin.end();
await new Promise(r => ff.on('close', r));
await browser.close();
console.log(`rendered ${n} frames (${dur}s) -> ${out}`);

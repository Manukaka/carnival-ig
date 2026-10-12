// Usage:
//   node render.mjs spec.json out.mp4 [fps=30] [audio.wav|auto] [mood]
//   node render.mjs templates/x.html out.mp4 [fps] [audio.wav]
// With a .json spec the engine (engine/engine.html) builds the reel; "auto" generates matching music.
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path'; import fs from 'node:fs';
const [input, out, fpsArg, audioArg, mood] = process.argv.slice(2);
const fps = Number(fpsArg || 30);
const isSpec = input.endsWith('.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
if (isSpec) {
  const spec = fs.readFileSync(input, 'utf8');
  await page.addInitScript(`window.SPEC = ${spec};`);
  await page.goto('file://' + path.resolve('engine/engine.html'));
} else await page.goto('file://' + path.resolve(input));
page.on('pageerror', e => console.error('PAGE ERROR', e.message));
await page.evaluate(() => window.ready);
const dur = await page.evaluate(() => window.DURATION);
const cuts = await page.evaluate(() => window.CUTS || []);
let audio = audioArg;
if (audioArg === 'auto') {
  audio = out.replace(/\.mp4$/, '.wav');
  const lastCut = cuts.length ? cuts[cuts.length - 1] : dur - 2;
  execFileSync('python3', ['music.py', audio, String(dur), `hits=0.15,${lastCut}`, `whoosh=${cuts.join(',')}`, `mood=${mood || 'warm'}`]);
}
const n = Math.round(dur * fps);
const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-'];
if (audio) args.push('-i', audio);
args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', String(fps));
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
console.log(JSON.stringify({ frames: n, seconds: dur, cuts, out }));

// Long-timeline stress test (the "test with 30+ minute projects early" risk).
// A 30-minute source flashes white and beeps for 0.1 s at every multiple of 10 s. The edit cuts it
// into 360 back-to-back 5-second clips. Near the end we check picture and sound still land on time.
// Run with: npm run test:long   (about two minutes; not part of npm test)

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Engine, type ExportPreset, type Project } from '../src/index.js';
import { ffmpeg } from '../src/ffmpeg.js';

const LEN = 1800;
let dir: string;
let engine: Engine;

const project = (): Project => ({
  version: 1,
  settings: { width: 320, height: 180, fps: 30, sampleRate: 48000 },
  media: [{ id: 'long', path: 'long.mp4', proxyPath: null, duration: LEN, type: 'video' }],
  tracks: [{ id: 'v1', kind: 'video', clips: Array.from({ length: LEN / 5 }, (_, i) => ({ id: `c${i}`, mediaId: 'long', start: i * 5, in: i * 5, out: i * 5 + 5 })) }],
  markers: [],
  comments: [],
});

const tiny: ExportPreset = { id: 'tiny', label: 'test', width: 320, height: 180, fit: 'contain', crf: 35, x264Preset: 'ultrafast', audioBitrate: '96k', loudness: -16 };

/** First time (s, relative to `from`) the mono signal rises above 0.05. */
function onset(samples: Float32Array, rate: number, channels: number): number {
  for (let i = 0; i < samples.length; i += channels) if (Math.abs(samples[i]) > 0.05) return i / channels / rate;
  return NaN;
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'long-test-'));
  // aevalsrc is evaluated per sample, so beeps start exactly on the 10 s marks
  // (a volume filter's enable= only switches per 1024-sample block).
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=320x180:r=30:d=${LEN}`,
    '-f', 'lavfi', '-i', `aevalsrc='if(lt(mod(t\\,10)\\,0.1)\\,0.5*sin(2*PI*1000*t)\\,0)':s=48000:d=${LEN}`,
    '-vf', "drawbox=c=white:t=fill:enable='lt(mod(t,10),0.1)'",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(dir, 'long.mp4')]);
  engine = new Engine({ baseDir: dir, cacheDir: path.join(dir, 'cache') });
});

after(() => rm(dir, { recursive: true, force: true }));

test('preview frames stay frame-accurate and fast at 29:50 of a 360-cut timeline', async () => {
  const at = async (t: number) => {
    const started = Date.now();
    const f = await engine.getFrameAt(project(), t, { width: 64, format: 'rgba' });
    return { lum: f.data[(18 * 64 + 32) * 4], ms: Date.now() - started };
  };
  await at(5); // first call reads the file cold
  const on = await at(1790.034);
  const off = await at(1790.134);
  const before = await at(1789.966);
  assert.ok(on.lum > 200, `flash at 1790.03 expected, got ${on.lum}`);
  assert.ok(off.lum < 30 && before.lum < 30, `dark around the flash, got ${before.lum}/${off.lum}`);
  assert.ok(Math.max(on.ms, off.ms) < 1000, `frame took ${Math.max(on.ms, off.ms)} ms`);
  console.log(`  warm preview frame at 29:50: ${on.ms} ms`);
});

test('playback audio is sample-accurate at 29:50', async () => {
  const a = await engine.getAudio(project(), 1789.5, 1790.5);
  const t = onset(a.data, a.sampleRate, 2);
  assert.ok(Math.abs(t - 0.5) < 0.003, `beep at ${(1789.5 + t).toFixed(4)}s, expected 1790.0`);
});

test('a full 30-minute export keeps picture and sound in sync to the end', async () => {
  const out = path.join(dir, 'export.mp4');
  const started = Date.now();
  await engine.exportProject(project(), tiny, undefined, { output: out });
  const seconds = (Date.now() - started) / 1000;
  const probe = await engine.probeMedia(out);
  assert.ok(Math.abs(probe.duration - LEN) < 0.2, `duration ${probe.duration}`);

  for (const mark of [10, 900, 1790]) {
    const from = mark - 1;
    const pcm = await ffmpeg(['-v', 'error', '-ss', String(from), '-t', '2', '-i', out, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { captureStdout: true });
    const audio = new Float32Array(pcm.stdout.buffer, pcm.stdout.byteOffset, pcm.stdout.byteLength / 4);
    const aT = from + onset(audio, 48000, 1);
    const raw = await ffmpeg(['-v', 'error', '-ss', String(from), '-t', '2', '-i', out, '-an', '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', '-'], { captureStdout: true });
    let frame = -1;
    for (let i = 0; i * 64 < raw.stdout.length; i++) if (raw.stdout[i * 64 + 36] > 128) { frame = i; break; }
    const vT = from + frame / 30;
    console.log(`  mark ${mark}s: picture ${vT.toFixed(3)}s, sound ${aT.toFixed(3)}s`);
    assert.ok(Math.abs(vT - mark) < 0.04, `picture flash at ${vT.toFixed(3)}s, expected ${mark}`);
    assert.ok(Math.abs(aT - mark) < 0.04, `beep at ${aT.toFixed(3)}s, expected ${mark}`);
    assert.ok(Math.abs(vT - aT) < 0.045, `A/V offset ${((vT - aT) * 1000).toFixed(0)} ms at ${mark}s`);
  }
  console.log(`  exported 30 min with 360 cuts in ${seconds.toFixed(0)} s`);
});

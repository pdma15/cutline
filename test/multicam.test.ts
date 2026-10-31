import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Engine, EngineError, validateProject, type MediaClip, type Project } from '../src/index.js';
import { ffmpeg } from '../src/ffmpeg.js';
import { CAMERAS, TURNS, makeMulticamMedia, multicamProject } from '../scripts/make-multicam.js';

let dir: string;
let engine: Engine;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'multicam-test-'));
  await makeMulticamMedia(dir);
  engine = new Engine({ baseDir: dir, cacheDir: path.join(dir, 'cache') });
  await engine.openProject(multicamProject());
});

after(() => rm(dir, { recursive: true, force: true }));

describe('multicam sync', () => {
  test('finds each camera offset to within a millisecond', async () => {
    const sync = await engine.syncMulticam(['camA', 'camB', 'wide']);
    assert.equal(sync.reference, 'camA');
    for (const cam of CAMERAS) {
      const a = sync.angles.find((x) => x.mediaId === cam.id)!;
      assert.ok(Math.abs(a.offset - cam.from) < 0.001, `${cam.id}: expected ${cam.from}, got ${a.offset}`);
      assert.ok(a.confidence > 0.4, `${cam.id} confidence ${a.confidence}`);
    }
  });

  test('any angle can be the reference', async () => {
    const sync = await engine.syncMulticam(['camA', 'camB', 'wide'], { reference: 'camB' });
    assert.ok(Math.abs(sync.angles.find((a) => a.mediaId === 'camA')!.offset + 2.37) < 0.001);
  });

  test('needs two angles with audio', async () => {
    await assert.rejects(engine.syncMulticam(['camA']), (e: EngineError) => e.code === 'SYNC_FAILED');
  });

  test('measures clock drift on long takes', async () => {
    // cam2 starts 3 s in and its clock runs 100 ppm fast: 0.36 s of drift per hour.
    const R = 8000, LEN = 150;
    let seed = 7;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const scene = new Float32Array(LEN * R);
    for (let t = 0.5; t < LEN - 1; ) {
      const d = 0.08 + rand() * 0.25, a = Math.floor(t * R), b = Math.floor((t + d) * R);
      for (let i = a; i < b; i++) scene[i] = (rand() * 2 - 1) * 0.5 * Math.sin((Math.PI * (i - a)) / (b - a));
      t += d + 0.05 + rand() * 0.4;
    }
    const at = (s: number) => { const x = s * R, i = Math.floor(x); return i + 1 < scene.length ? scene[i] + (scene[i + 1] - scene[i]) * (x - i) : 0; };
    const cam2 = Float32Array.from({ length: (LEN - 10) * R }, (_, i) => at(3 + (i * (1 + 1e-4)) / R));
    for (const [name, pcm] of [['d1', scene], ['d2', cam2]] as const) {
      const raw = path.join(dir, `${name}.raw`);
      await writeFile(raw, Buffer.from(Int16Array.from(pcm, (v) => Math.round(v * 32767)).buffer));
      await ffmpeg(['-v', 'error', '-f', 's16le', '-ar', String(R), '-ac', '1', '-i', raw, '-c:a', 'aac', path.join(dir, `${name}.m4a`)]);
    }
    const e = new Engine({ baseDir: dir, cacheDir: path.join(dir, 'cache') });
    await e.importMedia('d1.m4a', 'd1');
    await e.importMedia('d2.m4a', 'd2');
    const a = (await e.syncMulticam(['d1', 'd2'])).angles[1];
    assert.ok(Math.abs(a.offset - 3) < 0.002, `offset ${a.offset}`);
    assert.ok(a.driftPerHour !== null && Math.abs(a.driftPerHour - 0.36) < 0.05, `drift ${a.driftPerHour}`);
  });
});

describe('auto-switch', () => {
  test('cuts to whoever is talking, wide when nobody is', async () => {
    const sync = await engine.syncMulticam(['camA', 'camB', 'wide']);
    const { segments } = await engine.autoSwitch(sync, { wide: 'wide' });
    // camA is the reference and started at scene time 0, so reference time = scene time.
    for (const turn of TURNS) {
      const mid = (turn.from + turn.to) / 2;
      const seg = segments.find((s) => s.start <= mid && s.end > mid)!;
      assert.equal(seg.mediaId, turn.who === 'A' ? 'camA' : 'camB', `at ${mid}s`);
    }
    assert.equal(segments.find((s) => s.start <= 22 && s.end > 22)?.mediaId, 'wide');
    // No flicker: every shot is at least 2 s except where only one angle was rolling.
    for (const s of segments.slice(1, -1)) assert.ok(s.end - s.start >= 2 - 1e-6, `short shot ${JSON.stringify(s)}`);
    // Contiguous.
    for (let i = 1; i < segments.length; i++) assert.ok(Math.abs(segments[i].start - segments[i - 1].end) < 1e-6);
  });

  test('builds clips that render the right camera', async () => {
    const sync = await engine.syncMulticam(['camA', 'camB', 'wide']);
    const { clips } = await engine.autoSwitch(sync, { wide: 'wide', audioFrom: 'wide' });
    const p: Project = multicamProject();
    p.tracks[0].clips = clips.video;
    p.tracks[1].clips = clips.audio;
    assert.deepEqual(validateProject(p), []);
    for (const c of [...clips.video, ...clips.audio] as MediaClip[]) {
      const { duration } = await engine.probeMedia(`footage/${c.mediaId}.mp4`);
      assert.ok(c.in >= 0 && c.out <= duration + 1e-3, `${c.id} ${c.in}-${c.out} outside ${duration}`);
    }
    assert.ok(clips.video.every((c) => c.muted));
    assert.equal(clips.audio[0].mediaId, 'wide');

    const colour = async (t: number) => {
      const f = await engine.getFrameAt(p, t, { width: 64, format: 'rgba' });
      const i = (18 * 64 + 32) * 4;
      return [f.data[i], f.data[i + 1], f.data[i + 2]];
    };
    const [r1, , b1] = await colour(2.5); // A talking -> camA (dark red)
    assert.ok(r1 > 100 && b1 < 30, `camA expected, got ${[r1, b1]}`);
    const [r2, , b2] = await colour(6.5); // B talking -> camB (navy)
    assert.ok(b2 > 100 && r2 < 30, `camB expected, got ${[r2, b2]}`);
  });
});

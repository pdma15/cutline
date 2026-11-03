import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Engine, EngineError, validateProject, type Project, type Transcriber } from '../src/index.js';
import { ffmpeg } from '../src/ffmpeg.js';

let dir: string;
let engine: Engine;

const colourClip = (name: string, colour: string, seconds: number, tone: string) =>
  ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=320x180:r=30:d=${seconds}`, '-f', 'lavfi', '-i', `sine=f=440:r=48000:d=${seconds}`,
    // lavfi's sine is 1/8 full scale; scale it so `tone` is the peak level.
    '-af', `volume='8*(${tone})':eval=frame`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, name)]);

/** red 0-2, blue 2-4 (crossfades in over 0.5 s), black gap 4-5, green PiP 0.5-1.5. */
const project = (): Project => ({
  version: 1,
  settings: { width: 320, height: 180, fps: 30, sampleRate: 48000 },
  media: [
    { id: 'red', path: 'red.mp4', proxyPath: null, duration: 4, type: 'video' },
    { id: 'blue', path: 'blue.mp4', proxyPath: null, duration: 4, type: 'video' },
    { id: 'green', path: 'green.mp4', proxyPath: null, duration: 4, type: 'video' },
  ],
  tracks: [
    {
      id: 'v1', kind: 'video', clips: [
        { id: 'c1', mediaId: 'red', start: 0, in: 0, out: 2 },
        { id: 'c2', mediaId: 'blue', start: 2, in: 0, out: 2, transitionIn: { type: 'crossfade', duration: 0.5 } },
      ],
    },
    { id: 'v2', kind: 'video', clips: [{ id: 'c3', mediaId: 'green', start: 0.5, in: 0, out: 1, muted: true, effects: [{ type: 'transform', x: 0.25, y: -0.25, scale: 0.25 }] }] },
    { id: 'a1', kind: 'audio', clips: [] },
    { id: 't1', kind: 'text', clips: [{ id: 'c4', start: 4, duration: 1, text: 'The end' }] },
  ],
  markers: [],
  comments: [],
});

/** Reads an RGB pixel from a raw RGBA frame. */
async function pixel(t: number, x: number, y: number): Promise<[number, number, number]> {
  const f = await engine.getFrameAt(project(), t, { width: 320, format: 'rgba' });
  const i = (Math.round(y * f.height) * f.width + Math.round(x * f.width)) * 4;
  return [f.data[i], f.data[i + 1], f.data[i + 2]];
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'engine-test-'));
  // red has audio throughout; blue is silent from 1 s, so the timeline is quiet from 3 s.
  await colourClip('red.mp4', 'red', 4, '0.5');
  await colourClip('blue.mp4', 'blue', 4, 'if(lt(t,1),0.5,0)');
  await colourClip('green.mp4', 'lime', 4, '0.5');
  engine = new Engine({ cacheDir: path.join(dir, 'cache'), baseDir: dir });
  await engine.openProject(project());
});

after(() => rm(dir, { recursive: true, force: true }));

describe('contract', () => {
  test('accepts a valid project', () => assert.deepEqual(validateProject(project()), []));

  test('reports broken projects', () => {
    const p: any = project();
    p.version = 2;
    p.tracks[0].clips[0].mediaId = 'nope';
    p.tracks[0].clips[1].out = -1;
    const errs = validateProject(p);
    assert.equal(errs.length, 3, errs.join('\n'));
  });
});

describe('media', () => {
  test('probeMedia reads streams', async () => {
    const p = await engine.probeMedia('red.mp4');
    assert.equal(p.type, 'video');
    assert.equal(p.video?.width, 320);
    assert.equal(p.video?.fps, 30);
    assert.equal(p.audio?.sampleRate, 48000);
    assert.ok(Math.abs(p.duration - 4) < 0.1);
  });

  test('missing files give NOT_FOUND', async () => {
    await assert.rejects(engine.probeMedia('missing.mp4'), (e: EngineError) => e.code === 'NOT_FOUND');
  });

  test('thumbnails, waveform, proxy', async () => {
    assert.equal((await engine.getThumbnails('red', 3)).length, 3);
    const w = await engine.getWaveform('blue');
    assert.ok(w.max.length >= 390 && w.max.length <= 410, `got ${w.max.length} peaks`);
    assert.ok(w.max[50] > 0.1 && w.max[300] < 0.01, 'loud then silent');
    const proxy = await engine.makeProxy('red');
    assert.equal((await engine.probeMedia(proxy)).video?.height, 180);
  });
});

describe('render', () => {
  test('composites tracks at the right times', async () => {
    const [r, g, b] = await pixel(0.2, 0.5, 0.5);
    assert.ok(r > 200 && g < 50 && b < 50, `red expected, got ${[r, g, b]}`);
    const pip = await pixel(1, 0.75, 0.25);
    assert.ok(pip[1] > 200 && pip[0] < 50, `green PiP expected, got ${pip}`);
    const blue = await pixel(3, 0.5, 0.5);
    assert.ok(blue[2] > 200 && blue[0] < 50, `blue expected, got ${blue}`);
    const gap = await pixel(4.5, 0.1, 0.1);
    assert.ok(gap.every((c) => c < 20), `black gap expected, got ${gap}`);
  });

  test('crossfade blends the two clips', async () => {
    const [r, , b] = await pixel(2.25, 0.5, 0.5);
    assert.ok(r > 60 && r < 200 && b > 60 && b < 200, `blend expected, got r=${r} b=${b}`);
  });

  test('getAudio returns the requested range', async () => {
    const a = await engine.getAudio(project(), 0, 1);
    assert.equal(a.data.length, 48000 * 2);
    assert.ok(Math.max(...a.data.subarray(0, 4800).map(Math.abs)) > 0.1);
  });

  test('exportProject writes the full timeline with progress', async () => {
    const seen: number[] = [];
    const out = await engine.exportProject(project(), 'school', (f) => seen.push(f), { output: path.join(dir, 'out.mp4') });
    const p = await engine.probeMedia(out);
    assert.equal(p.video?.width, 1280);
    assert.equal(p.video?.height, 720);
    assert.ok(Math.abs(p.duration - 5) < 0.15, `duration ${p.duration}`);
    assert.equal(seen.at(-1), 1);
    assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1]), 'progress never goes backwards');
  });

  test('exports can be cancelled', async () => {
    const ac = new AbortController();
    const job = engine.exportProject(project(), '4k', undefined, { output: path.join(dir, 'cancel.mp4'), signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    await assert.rejects(job, (e: EngineError) => e.code === 'ABORTED');
  });

  test('unknown presets are rejected', async () => {
    await assert.rejects(engine.exportProject(project(), 'vhs'), (e: EngineError) => e.code === 'UNKNOWN_PRESET');
  });
});

describe('ai', () => {
  test('transcribe needs a configured model', async () => {
    await assert.rejects(new Engine({ cacheDir: path.join(dir, 'c2'), baseDir: dir }).transcribe('red'), (e: EngineError) => e.code === 'AI_NOT_CONFIGURED');
  });

  test('analyse finds silences and cuts', async () => {
    const a = await engine.analyse(project());
    assert.equal(a.duration, 5);
    const quiet = a.silences.find((s) => s.start > 2.8 && s.start < 3.2);
    assert.ok(quiet && quiet.end > 4.9, `silence from 3 s expected, got ${JSON.stringify(a.silences)}`);
    assert.deepEqual(a.cuts, [0.5, 1.5, 2, 4]);
    assert.ok(a.pacing.hookScore >= 0 && a.pacing.hookScore <= 100);
  });

  test('transcripts power search and filler detection', async () => {
    const fake: Transcriber = {
      name: 'fake',
      async transcribe() {
        const text = 'so um today we test the water rocket uh it flies'.split(' ');
        return { language: 'en', words: text.map((w, i) => ({ text: w, start: i * 0.15, end: i * 0.15 + 0.12 })) };
      },
    };
    const ai = new Engine({ cacheDir: path.join(dir, 'c3'), baseDir: dir, transcriber: fake });
    await ai.openProject(project());
    const t = await ai.transcribe('red');
    assert.equal(t.words[0].speaker, 'S1');

    const hits = await ai.searchFootage('water rocket');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].mediaId, 'red');
    assert.ok(Math.abs(hits[0].time - 6 * 0.15) < 1e-9);

    const a = await ai.analyse(project());
    assert.deepEqual(a.fillers.map((f) => f.word), ['um', 'uh']);

    // A fresh engine on the same cache picks the transcript up without re-running the model.
    const again = new Engine({ cacheDir: path.join(dir, 'c3'), baseDir: dir });
    await again.openProject(project());
    assert.equal((await again.searchFootage('rocket')).length, 1);
  });
});

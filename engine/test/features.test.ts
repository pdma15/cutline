import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Engine, EngineError, isTextClip, validateProject, type Project, type Transcriber } from '../src/index.js';
import { claudeFromEnv, type Describer, type Matcher, type Translator } from '../src/claude.js';
import { ffmpeg } from '../src/ffmpeg.js';
import { CAMERAS, TURNS, makeMulticamMedia, multicamProject } from '../scripts/make-multicam.js';

let dir: string;

/** A white square sliding left to right across a dark 16:9 frame over 6 s (centre x 0.125 -> 0.875). */
const moving = (): Project => ({
  version: 1,
  settings: { width: 1280, height: 720, fps: 30, sampleRate: 48000 },
  media: [{ id: 'm', path: 'move.mp4', proxyPath: null, duration: 6, type: 'video' }],
  tracks: [
    { id: 'v1', kind: 'video', clips: [{ id: 'c', mediaId: 'm', start: 0, in: 0, out: 6 }] },
    { id: 't1', kind: 'text', clips: [{ id: 'title', start: 0, duration: 2, text: 'Hi', style: { fontSize: 40 } }] },
  ],
  markers: [],
  comments: [],
});

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'features-test-'));
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x202020:s=1280x720:r=30:d=6', '-f', 'lavfi', '-i', 'color=c=white:s=120x120:r=30:d=6',
    '-filter_complex', "[0][1]overlay=x='100+t*160':y=300", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(dir, 'move.mp4')]);
});

after(() => rm(dir, { recursive: true, force: true }));

describe('auto-reframe', () => {
  test('follows the subject into a 9:16 frame', async () => {
    const engine = new Engine({ baseDir: dir, cacheDir: path.join(dir, 'c-rf') });
    const vertical = await engine.autoReframe(moving());
    assert.deepEqual(validateProject(vertical), []);
    assert.equal(vertical.settings.width, 1080);
    assert.equal(vertical.settings.height, 1920);
    const fx = (vertical.tracks[0].clips[0] as any).effects.find((e: any) => e.type === 'reframe');
    assert.ok(fx.keyframes.length >= 2 && fx.keyframes.length < 30, `${fx.keyframes.length} keyframes`);

    for (const t of [1, 3, 5]) {
      const f = await engine.getFrameAt(vertical, t, { width: 90, format: 'rgba' });
      const row = Math.round(f.height / 2);
      const lit: number[] = [];
      for (let x = 0; x < f.width; x++) if (f.data[(row * f.width + x) * 4] > 150) lit.push(x);
      assert.ok(lit.length > 5, `subject visible at ${t}s`);
      const centre = (lit[0] + lit[lit.length - 1]) / 2 / f.width;
      assert.ok(Math.abs(centre - 0.5) < 0.2, `subject near centre at ${t}s, got ${centre.toFixed(2)}`);
    }
    // Text keeps its size relative to the frame (same pixel area here -> 1.5x for a 720p source).
    const title = vertical.tracks[1].clips[0];
    assert.ok(isTextClip(title) && title.style?.fontSize === 60);
  });

  test('a plain centre crop would have lost the subject', async () => {
    const engine = new Engine({ baseDir: dir, cacheDir: path.join(dir, 'c-rf') });
    const p = moving();
    const f = await engine.getFrameAt(p, 1, { width: 90, format: 'rgba' });
    // Sanity: the square is at x≈0.25 of the 16:9 frame, outside the middle 9:16 window (0.34-0.66).
    const row = Math.round(f.height * 0.5);
    let first = -1;
    for (let x = 0; x < f.width; x++) if (f.data[(row * f.width + x) * 4] > 150) { first = x; break; }
    assert.ok(first >= 0 && first / f.width < 0.34);
  });
});

describe('visual footage search', () => {
  const scenes: Record<number, string> = {
    0: 'A white box sits on the left of a dark empty studio',
    2: 'A contestant falls backwards into a swimming pool with a big splash',
    4: 'A man in a red jacket holds a golden trophy above his head',
  };
  const describer: Describer = { name: 'fake', describe: async (frames) => frames.map((f) => ({ time: f.time, text: scenes[f.time] ?? 'nothing' })) };

  test('indexes frames and finds them by what is on screen', async () => {
    const engine = new Engine({ baseDir: dir, cacheDir: path.join(dir, 'c-vis'), describer });
    await engine.openProject(moving());
    const frames = await engine.indexFootage('m', { interval: 2 });
    assert.deepEqual(frames.map((f) => f.time), [0, 2, 4]);
    const hits = await engine.searchFootage('someone falling into the pool');
    assert.equal(hits[0]?.source, 'visual');
    assert.equal(hits[0].time, 2);
    assert.equal(hits[0].end, 4);
    assert.equal((await engine.searchFootage('trophy'))[0].time, 4);
    assert.equal((await engine.searchFootage('helicopter')).length, 0);

    // Cached: a new engine with no describer can still search.
    const again = new Engine({ baseDir: dir, cacheDir: path.join(dir, 'c-vis'), describer: undefined });
    await again.openProject(moving());
    assert.equal((await again.searchFootage('splash'))[0].time, 2);
  });

  test('semantic search asks the matcher', async () => {
    let seen: Array<{ id: number; text: string }> = [];
    const matcher: Matcher = { name: 'fake', match: async (_q, moments) => ((seen = moments), [{ id: moments.findIndex((m) => m.text.includes('splash')), score: 0.9 }]) };
    const engine = new Engine({ baseDir: dir, cacheDir: path.join(dir, 'c-vis'), describer, matcher });
    await engine.openProject(moving());
    const hits = await engine.searchFootage('someone gets wet', { semantic: true });
    assert.equal(seen.length, 3);
    assert.ok(seen[0].text.startsWith('[visual]'));
    assert.equal(hits[0].time, 2);
  });

  test('needs a describer', async () => {
    const engine = new Engine({ baseDir: dir, cacheDir: path.join(dir, 'c-none'), describer: undefined });
    await engine.openProject(moving());
    await assert.rejects(engine.indexFootage('m'), (e: EngineError) => e.code === 'AI_NOT_CONFIGURED' || !!process.env.ANTHROPIC_API_KEY);
  });
});

describe('captions', () => {
  const words = 'Hello everyone. Today we are going to launch a water rocket in the school yard and see how high it flies.'.split(' ');
  const transcriber: Transcriber = {
    name: 'fake',
    transcribe: async () => ({ words: words.map((text, i) => ({ text, start: 0.5 + i * 0.3, end: 0.5 + i * 0.3 + 0.25 })) }),
  };
  const translator: Translator = { name: 'fake', translate: async (lines, lang) => lines.map((l) => `[${lang}] ${l}`) };

  test('auto-captions, translation and SRT', async () => {
    const engine = new Engine({ baseDir: dir, cacheDir: path.join(dir, 'c-cap'), transcriber, translator });
    const p = moving();
    p.tracks[0].clips = [{ id: 'c', mediaId: 'm', start: 10, in: 0, out: 6 }]; // placed at 10 s on the timeline
    await engine.openProject(p);
    await engine.transcribe('m').catch(() => {}); // move.mp4 has no audio; inject directly below
    (engine as any).transcripts.set('m', { mediaId: 'm', words: (await transcriber.transcribe('')).words.map((w) => ({ ...w, speaker: 'S1' })) });

    const caps = await engine.autoCaptions(p);
    assert.equal(caps[0].text, 'Hello everyone.');
    assert.ok(Math.abs(caps[0].start - 10.5) < 1e-6, 'timeline time = clip start + source time');
    assert.ok(caps.every((c) => c.text.length <= 42));
    assert.ok(caps.every((c, i) => i === 0 || c.start >= caps[i - 1].start + caps[i - 1].duration - 1e-6), 'no overlaps');
    // Only words inside the clip's in/out (0-6 s of source) are captioned.
    assert.ok(caps.every((c) => c.start + c.duration <= 16 + 1e-6));

    p.tracks[1].clips = caps;
    const srt = engine.subtitles(p);
    assert.match(srt, /^1\n00:00:10,500 --> 00:00:1\d,\d{3}\nHello everyone\.\n/);
    assert.match(engine.subtitles(p, { format: 'vtt' }), /^WEBVTT\n\n00:00:10\.500 --> /);

    const es = await engine.translateCaptions(p, 'Spanish');
    const orig = es.tracks.find((t) => t.id === 't1')!;
    const tr = es.tracks.find((t) => t.id === 't1-spanish')!;
    assert.equal(orig.hidden, true);
    assert.equal(tr.clips.length, caps.length);
    assert.equal((tr.clips[0] as any).text, '[Spanish] Hello everyone.');
    assert.match(engine.subtitles(es), /\[Spanish\] Hello everyone\./);
    await engine.getFrameAt(es, 11, { width: 160 }); // renders with the translated track
  });
});

describe('speaker labels', () => {
  test('names each word by whose mic was loudest', async () => {
    const mdir = path.join(dir, 'interview');
    await makeMulticamMedia(mdir);
    // One "word" every 0.25 s through each turn, in camA source time (camA started at scene 0).
    const wordsAt = TURNS.flatMap((t) => Array.from({ length: Math.floor((t.to - t.from) / 0.25) - 1 }, (_, i) => ({ text: t.who, start: t.from + 0.1 + i * 0.25, end: t.from + 0.3 + i * 0.25 })));
    const transcriber: Transcriber = { name: 'fake', transcribe: async () => ({ words: wordsAt }) };
    const engine = new Engine({ baseDir: mdir, cacheDir: path.join(mdir, 'cache'), transcriber });
    await engine.openProject(multicamProject());
    const sync = await engine.syncMulticam(CAMERAS.map((c) => c.id));
    const t = await engine.labelSpeakers('camA', sync, { wide: 'wide', names: { camA: 'Host', camB: 'Guest' } });
    const right = t.words.filter((w) => (w.text === 'A' ? 'Host' : 'Guest') === w.speaker).length;
    assert.ok(right / t.words.length > 0.95, `${right}/${t.words.length} words labelled correctly`);
  });
});

describe('claude integration (fake client)', () => {
  test('sends images with fallbacks and parses structured output', async () => {
    const calls: any[] = [];
    const fake = {
      beta: {
        messages: {
          create: async (req: any) => {
            calls.push(req);
            const isDescribe = req.messages[0].content.some((b: any) => b.type === 'image');
            const body = isDescribe
              ? { frames: req.messages[0].content.filter((b: any) => b.type === 'text' && b.text.startsWith('Frame at')).map((b: any) => ({ time: parseFloat(b.text.slice(9)), description: 'a dog runs on a beach' })) }
              : { lines: JSON.parse(req.messages[0].content[0].text).lines.map((l: string) => l.toUpperCase()) };
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(body) }] };
          },
        },
      },
    };
    const ai = claudeFromEnv(fake as any)!;
    const out = await ai.describe([{ time: 0, jpeg: Buffer.from([0xff, 0xd8, 0xff]) }, { time: 5, jpeg: Buffer.from([0xff, 0xd8, 0xff]) }]);
    assert.deepEqual(out.map((o) => o.time), [0, 5]);
    const req = calls[0];
    assert.equal(req.model, 'claude-opus-5-5');
    assert.equal(req.fallbacks, 'default');
    assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(req.output_config.format.type, 'json_schema');
    assert.equal(req.messages[0].content.filter((b: any) => b.type === 'image').length, 2);
    assert.equal(req.messages[0].content[1].source.media_type, 'image/jpeg');

    assert.deepEqual(await ai.translate(['hola', 'adiós'], 'English'), ['HOLA', 'ADIÓS']);
  });

  test('turns refusals into EngineError', async () => {
    const fake = { beta: { messages: { create: async () => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }) } } };
    await assert.rejects(claudeFromEnv(fake as any)!.translate(['x'], 'French'), (e: EngineError) => e.code === 'AI_REFUSED');
  });
});

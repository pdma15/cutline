// Merge-day checks: the App's project JSON goes through the server to the real engine.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import type http from 'node:http';
import { Engine, validateProject } from '../engine/src/index.js';
import { ffmpeg } from '../engine/src/ffmpeg.js';
import { createCutlineServer } from './server.js';
import { toEngineProject } from './normalize.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let dir: string;
let server: http.Server;
let base: string;

/** The App's own demo project, as script.js builds it, plus a title on a video clip and a volume change. */
const appDemo = () => ({
  version: 1, name: 'A little adventure', settings: { width: 1920, height: 1080, fps: 30, sampleRate: 48000 },
  media: [
    { id: 'm1', path: 'Mountain morning.mp4', type: 'video', duration: 8, proxyPath: null, demo: true },
    { id: 'm2', path: 'The scenic route.mp4', type: 'video', duration: 10, proxyPath: null, demo: true },
    { id: 'm3', path: 'Golden hour.jpg', type: 'image', duration: 6, proxyPath: null, demo: true },
    { id: 'm4', path: 'A softer pace.mp3', type: 'audio', duration: 24, proxyPath: null, demo: true },
  ],
  tracks: [
    { id: 'v1', kind: 'video', clips: [
      { id: 'c1', mediaId: 'm1', start: 0, in: 0, out: 8, effects: [], text: 'Morning', volume: 1, transitionIn: null },
      { id: 'c2', mediaId: 'm2', start: 8, in: 0, out: 10, effects: [{ type: 'colour', exposure: 0.2, saturation: 1.1 }], transitionIn: { type: 'crossfade', duration: 0.5 } },
      { id: 'c3', mediaId: 'm3', start: 18, in: 0, out: 6, effects: [] },
    ] },
    { id: 'a1', kind: 'audio', clips: [{ id: 'c4', mediaId: 'm4', start: 0, in: 0, out: 24, effects: [], volume: 0.35 }] },
    { id: 't1', kind: 'text', clips: [{ id: 'c5', start: 1, in: 0, out: 4, text: 'Science project', effects: [] }] },
  ],
  markers: [], comments: [{ id: 'k1', time: 4.2, author: 'Editor', text: 'Tighten this', resolved: false }], approved: false,
});

const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cutline-server-'));
  server = await createCutlineServer({ workspace: path.join(dir, 'ws'), sites: { '/': path.join(root, 'app') } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

describe('format bridge', () => {
  test('App projects become valid engine projects', () => {
    const { project, missing } = toEngineProject(appDemo(), (m) => `/tmp/${m.id}`);
    assert.deepEqual(missing, []);
    assert.deepEqual(validateProject(project), []);
    const clips = project.tracks.flatMap((t) => t.clips) as any[];
    assert.ok(!('text' in clips.find((c) => c.id === 'c1')), 'a video clip with a title must not look like a text clip');
    assert.deepEqual(clips.find((c) => c.id === 'c4').effects, [{ type: 'volume', gain: 0.35 }]);
    assert.equal(clips.find((c) => c.id === 'c5').duration, 4);
    assert.equal(clips.find((c) => c.id === 'c1-title').text, 'Morning');
    assert.equal(clips.find((c) => c.id === 'c1').transitionIn, undefined);
  });

  test('media without a file is reported, and its clips left out', () => {
    const { project, missing } = toEngineProject(appDemo(), (m) => (m.id === 'm2' ? null : `/tmp/${m.id}`));
    assert.deepEqual(missing, ['m2']);
    assert.ok(!project.tracks.flatMap((t) => t.clips).some((c: any) => c.mediaId === 'm2'));
  });
});

describe('server', () => {
  test('serves the App with the real-engine adapter', async () => {
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /real-engine\.js/);
    assert.equal((await fetch(base + '/real-engine.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await (await fetch(base + '/api/health')).json()).engine, true);
    assert.ok([403, 404].includes((await fetch(base + '/..%2fpackage.json')).status), 'no path traversal');
  });

  test('landing page at /, editor at /editor/', async () => {
    const ws = path.join(dir, 'ws-sites');
    const s = await createCutlineServer({ workspace: ws, sites: { '/': path.join(root, 'landing-page'), '/editor': path.join(root, 'app') } });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      const landing = await (await fetch(b + '/')).text();
      assert.match(landing, /goToEditor/);
      assert.match(landing, /"editor\/"/, 'redirect target is relative so it works under any host');
      assert.equal((await fetch(b + '/assets/cutline-logo.png')).headers.get('content-type'), 'image/png');
      const editor = await fetch(b + '/editor', { redirect: 'manual' });
      assert.equal(editor.status, 301);
      assert.match(await (await fetch(b + '/editor/')).text(), /real-engine\.js/);
      assert.equal((await fetch(b + '/editor/script.js')).status, 200);
      assert.equal((await (await fetch(b + '/api/health')).json()).engine, true);
    } finally {
      await new Promise((r) => s.close(r));
    }
  });

  test('renders the App demo project, titles included', async () => {
    const res = await post('/api/frame', { project: appDemo(), time: 2, width: 320 });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await res.arrayBuffer());
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    // Compare against a frame with the titles removed: the title must change pixels.
    const plain = appDemo();
    delete (plain.tracks[0].clips[0] as any).text;
    plain.tracks[2].clips = [];
    const png2 = Buffer.from(await (await post('/api/frame', { project: plain, time: 2, width: 320 })).arrayBuffer());
    assert.notDeepEqual(png, png2);
  });

  test('import, analyse and export a real school video', async () => {
    const src = path.join(dir, 'Science fair.mp4');
    await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=6',
      '-af', "volume='if(between(t,2,4),0,0.5)':eval=frame", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
    const up = await fetch(base + '/api/media/abc-123?name=Science%20fair.mp4', { method: 'PUT', body: await readFile(src) });
    assert.equal(up.status, 200);
    const info = await up.json();
    assert.equal(info.type, 'video');
    assert.ok(Math.abs(info.duration - 6) < 0.1);

    const p: any = appDemo();
    p.media.push({ id: 'abc-123', path: 'Science fair.mp4', type: 'video', duration: info.duration, proxyPath: null });
    p.tracks[0].clips = [{ id: 'k', mediaId: 'abc-123', start: 0, in: 0, out: 6, effects: [], text: 'My experiment' }];
    p.tracks[1].clips = [];
    p.tracks[2].clips = [];

    const analysis = await (await post('/api/call', { fn: 'analyse', args: [p] })).json();
    assert.equal(analysis.demo, false);
    assert.ok(analysis.analysis.silences.some((s: any) => s.start > 1.8 && s.start < 2.3), JSON.stringify(analysis.analysis.silences));

    const started = await post('/api/export', { project: p, preset: 'school' });
    assert.equal(started.status, 202);
    const { job } = await started.json();
    let status: any;
    for (let i = 0; i < 300; i++) {
      status = await (await fetch(`${base}/api/export/${job}`)).json();
      if (status.done) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(status.error, undefined);
    assert.equal(status.name, 'A_little_adventure-school.mp4');
    const file = await fetch(base + status.url);
    assert.match(file.headers.get('content-disposition') ?? '', /attachment/);
    const out = path.join(dir, 'downloaded.mp4');
    await writeFile(out, Buffer.from(await file.arrayBuffer()));
    const probe = await new Engine({ cacheDir: path.join(dir, 'c') }).probeMedia(out);
    assert.equal(probe.video?.width, 1280);
    assert.ok(Math.abs(probe.duration - 6) < 0.15, `duration ${probe.duration}`);
  });

  test('export names the files that still need reimporting', async () => {
    const p: any = appDemo();
    p.media.push({ id: 'gone', path: 'Holiday.mov', type: 'video', duration: 5, proxyPath: null });
    p.tracks[0].clips.push({ id: 'g', mediaId: 'gone', start: 24, in: 0, out: 5, effects: [] });
    const res = await post('/api/export', { project: p, preset: 'school' });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /Holiday\.mov/);
  });

  test('AI features explain what they need', async () => {
    const res = await post('/api/call', { fn: 'transcribe', args: ['m1'] });
    if (process.env.WHISPER_CPP_BIN) return;
    assert.equal(res.status, 501);
    assert.equal((await res.json()).code, 'AI_NOT_CONFIGURED');
  });
});

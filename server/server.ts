// Cutline local server: serves the Editor App and connects it to the real engine.
// Listens on 127.0.0.1 only — media never leaves this computer.
//
//   npm start            -> http://localhost:4100

import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Engine, EngineError, PRESETS } from '../engine/src/index.js';
import { ensureDemoMedia } from './demo-media.js';
import { toEngineProject } from './normalize.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAFE_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.woff2': 'font/woff2',
};

export interface ServerOptions {
  /** Where imported media, caches and exports live. */
  workspace: string;
  /** Static sites: URL prefix -> folder. '/' is the editor. */
  sites: Record<string, string>;
}

interface ExportJob {
  progress: number;
  done: boolean;
  error?: string;
  file?: string;
  name: string;
  controller: AbortController;
}

class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'BAD_REQUEST') {
    super(message);
  }
}

const STATUS: Record<string, number> = {
  INVALID_PROJECT: 400, UNKNOWN_PRESET: 400, EMPTY_PROJECT: 400, USAGE: 400, UNKNOWN_MEDIA: 404, NOT_FOUND: 404,
  UNSUPPORTED: 415, MISSING_MEDIA: 409, AI_NOT_CONFIGURED: 501, AI_REFUSED: 422, ABORTED: 499,
};

export async function createCutlineServer(opts: ServerOptions): Promise<http.Server> {
  const mediaDir = path.join(opts.workspace, 'media');
  const exportDir = path.join(opts.workspace, 'exports');
  await mkdir(mediaDir, { recursive: true });
  await mkdir(exportDir, { recursive: true });
  const demo = await ensureDemoMedia(path.join(opts.workspace, 'demo-media'));
  const engine = new Engine({ baseDir: opts.workspace, cacheDir: path.join(opts.workspace, '.cache') });
  const jobs = new Map<string, ExportJob>();

  /** The workspace copy of an App media item: demo stand-ins by id, imports as media/<id>.<ext>. */
  const files = new Map<string, string>();
  for (const f of await readdir(mediaDir)) {
    const id = f.replace(/\.[^.]+$/, '');
    if (SAFE_ID.test(id) && !f.includes('.partial')) files.set(id, path.join(mediaDir, f));
  }
  const fileFor = (m: any) => (m.demo ? demo.get(m.id) ?? null : files.get(m.id) ?? null);

  /** Normalises the App project and registers its media with the engine. */
  const engineProject = async (app: unknown, requireAll = false) => {
    if (!app || typeof app !== 'object') throw new HttpError(400, 'missing project');
    const { project, missing } = toEngineProject(app, fileFor);
    if (requireAll && missing.length) {
      const names = (app as any).media.filter((m: any) => missing.includes(m.id)).map((m: any) => m.path).join(', ');
      throw new HttpError(409, `Reimport these files first so the engine can read them: ${names}`, 'MISSING_MEDIA');
    }
    await engine.openProject(project);
    return { project, missing };
  };

  const readJson = async (req: http.IncomingMessage, limit = 10_000_000): Promise<any> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new HttpError(413, 'request too large');
      chunks.push(c);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      throw new HttpError(400, 'invalid JSON');
    }
  };

  const send = (res: http.ServerResponse, status: number, body: unknown, type = 'application/json') => {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(type === 'application/json' ? JSON.stringify(body) : String(body));
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    res.end(data);
  };

  const serveStatic = async (res: http.ServerResponse, root: string, rel: string) => {
    const file = path.resolve(root, '.' + path.posix.normalize('/' + decodeURIComponent(rel)));
    if (!file.startsWith(path.resolve(root))) throw new HttpError(403, 'forbidden');
    const target = existsSync(file) && (await stat(file)).isDirectory() ? path.join(file, 'index.html') : file;
    if (!existsSync(target)) throw new HttpError(404, 'not found', 'NOT_FOUND');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    createReadStream(target).pipe(res);
  };

  const routes = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;

    if (p === '/api/health') {
      return send(res, 200, { engine: true, version: 1, presets: Object.keys(PRESETS), ai: { transcribe: !!process.env.WHISPER_CPP_BIN, claude: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) } });
    }

    // Import: the App sends the file it just read; we keep a copy the engine can open.
    const mediaMatch = /^\/api\/media\/([^/]+)$/.exec(p);
    if (mediaMatch && req.method === 'PUT') {
      const id = mediaMatch[1];
      if (!SAFE_ID.test(id)) throw new HttpError(400, 'invalid media id');
      const ext = (path.extname(url.searchParams.get('name') ?? '').toLowerCase().match(/^\.[a-z0-9]{1,8}$/) ?? [''])[0];
      const old = files.get(id);
      const dest = path.join(mediaDir, `${id}${ext}`);
      const partial = `${dest}.partial`;
      await pipeline(req, createWriteStream(partial));
      if (old && old !== dest) await rm(old, { force: true });
      await rename(partial, dest);
      files.set(id, dest);
      try {
        const probe = await engine.probeMedia(dest);
        return send(res, 200, { id, type: probe.type, duration: probe.type === 'image' ? null : probe.duration, video: probe.video, audio: probe.audio });
      } catch (e) {
        files.delete(id);
        await rm(dest, { force: true });
        throw e;
      }
    }

    if (req.method !== 'POST' && p.startsWith('/api/') && !p.startsWith('/api/export/')) throw new HttpError(405, 'use POST');

    if (p === '/api/frame') {
      const { project: app, time, width } = await readJson(req);
      const { project, missing } = await engineProject(app);
      const frame = await engine.getFrameAt(project, Number(time) || 0, { width: Math.min(1920, Number(width) || 960) });
      res.setHeader('X-Missing-Media', missing.join(','));
      return send(res, 200, frame.data, 'image/png');
    }

    if (p === '/api/audio') {
      const { project: app, from, to } = await readJson(req);
      const { project } = await engineProject(app);
      const audio = await engine.getAudio(project, Number(from), Number(to));
      res.setHeader('X-Sample-Rate', String(audio.sampleRate));
      return send(res, 200, Buffer.from(audio.data.buffer, audio.data.byteOffset, audio.data.byteLength), 'application/octet-stream');
    }

    if (p === '/api/call') {
      const { fn, args = [] } = await readJson(req);
      switch (fn) {
        case 'getThumbnails': {
          const [mediaId, count] = args;
          const paths = await engine.getThumbnails(mediaId, Math.min(50, Number(count) || 8));
          const { readFile } = await import('node:fs/promises');
          return send(res, 200, await Promise.all(paths.map(async (f) => `data:image/jpeg;base64,${(await readFile(f)).toString('base64')}`)));
        }
        case 'getWaveform':
          return send(res, 200, await engine.getWaveform(args[0]));
        case 'makeProxy':
          return send(res, 200, { mediaId: args[0], proxy: !!(await engine.makeProxy(args[0])) });
        case 'transcribe': {
          const t = await engine.transcribe(args[0]);
          return send(res, 200, t.words.map((w) => ({ text: w.text, start: w.start, end: w.end, speaker: w.speaker, mediaId: t.mediaId })));
        }
        case 'searchFootage': {
          const hits = await engine.searchFootage(String(args[0] ?? ''), { semantic: !!args[1]?.semantic });
          return send(res, 200, hits.map((h) => ({ mediaId: h.mediaId, time: h.time, end: h.end, label: h.text, source: h.source, score: h.score })));
        }
        case 'analyse': {
          const { project } = await engineProject(args[0]);
          const a = await engine.analyse(project);
          const flags = [
            ...a.pacing.slowSections.map((s) => ({ time: s.start, end: s.end, label: s.reason === 'mostly silent' ? 'Mostly silent here' : 'Long shot without a cut' })),
            ...a.fillers.map((f) => ({ time: f.start, end: f.end, label: `Filler word: “${f.word}”` })),
          ].sort((x, y) => x.time - y.time);
          return send(res, 200, { demo: false, hookScore: a.pacing.hookScore, flags, analysis: a });
        }
        default:
          throw new HttpError(404, `unknown engine function ${fn}`, 'NOT_FOUND');
      }
    }

    if (p === '/api/export' && req.method === 'POST') {
      const { project: app, preset } = await readJson(req);
      if (!PRESETS[preset]) throw new HttpError(400, `unknown preset ${preset}`, 'UNKNOWN_PRESET');
      const { project } = await engineProject(app, true);
      const id = Math.random().toString(36).slice(2, 10);
      const safeName = String((app as any).name ?? 'cutline').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60) || 'cutline';
      const job: ExportJob = { progress: 0, done: false, name: `${safeName}-${preset}.mp4`, controller: new AbortController() };
      jobs.set(id, job);
      engine.exportProject(project, preset, (f) => (job.progress = Math.round(f * 100)), { output: path.join(exportDir, `${id}-${job.name}`), signal: job.controller.signal })
        .then((file) => Object.assign(job, { file, done: true, progress: 100 }))
        .catch((e) => Object.assign(job, { error: e instanceof Error ? e.message : String(e), done: true }));
      return send(res, 202, { job: id });
    }

    const jobMatch = /^\/api\/export\/([a-z0-9]+)(\/file|\/cancel)?$/.exec(p);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) throw new HttpError(404, 'no such export', 'NOT_FOUND');
      if (jobMatch[2] === '/cancel') {
        job.controller.abort();
        return send(res, 200, { cancelled: true });
      }
      if (jobMatch[2] === '/file') {
        if (!job.file) throw new HttpError(409, 'export not finished');
        const s = await stat(job.file);
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': s.size, 'Content-Disposition': `attachment; filename="${job.name}"` });
        return void createReadStream(job.file).pipe(res);
      }
      return send(res, 200, { progress: job.progress, done: job.done, error: job.error, url: job.file ? `/api/export/${jobMatch[1]}/file` : undefined, name: job.name });
    }

    if (p.startsWith('/api/')) throw new HttpError(404, 'not found', 'NOT_FOUND');

    // Static sites, longest prefix first.
    const prefix = Object.keys(opts.sites).sort((a, b) => b.length - a.length).find((k) => p === k || p.startsWith(k.endsWith('/') ? k : `${k}/`));
    if (!prefix) throw new HttpError(404, 'not found', 'NOT_FOUND');
    if (p === prefix && !prefix.endsWith('/')) {
      res.writeHead(301, { Location: `${prefix}/` });
      return void res.end();
    }
    return serveStatic(res, opts.sites[prefix], p.slice(prefix.length));
  };

  return http.createServer((req, res) => {
    routes(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : e instanceof EngineError ? STATUS[e.code] ?? 500 : 500;
      const code = e instanceof HttpError || e instanceof EngineError ? e.code : 'INTERNAL';
      const message = e instanceof Error ? e.message : String(e);
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: message, code });
      else res.destroy();
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(here, '..');
  const port = Number(process.env.PORT) || 4100;
  // The landing page plays first at /, then sends visitors to the editor at /editor/.
  const hasLanding = existsSync(path.join(root, 'landing-page', 'index.html'));
  const sites: Record<string, string> = hasLanding
    ? { '/': path.join(root, 'landing-page'), '/editor': path.join(root, 'app') }
    : { '/': path.join(root, 'app') };
  const server = await createCutlineServer({ workspace: process.env.CUTLINE_WORKSPACE ?? path.join(root, 'workspace'), sites });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Cutline is running: http://localhost:${port}`);
    if (hasLanding) console.log(`Straight to the editor: http://localhost:${port}/editor/`);
    console.log('Press Ctrl+C to stop.');
  });
}

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  analyseTimeline, notConfigured, parseSilences, searchTranscripts, transcriptFileName, whisperCppFromEnv,
  type Analysis, type SearchHit, type Transcriber, type Transcript,
} from './ai.js';
import { projectDuration, validateProject, type Media, type Project } from './contract.js';
import { EngineError, ffmpeg } from './ffmpeg.js';
import { fileKey, probeMedia, progressParser, proxy, thumbnails, waveform, type ProbeResult, type Waveform } from './media.js';
import { buildGraph, type Graph, type GraphOptions, type ResolvedMedia } from './render.js';

type GraphRequest = Omit<GraphOptions, 'resolve' | 'resolvePath' | 'tmpDir' | 'fontsDir'>;

export interface ExportPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  fit: 'contain' | 'cover';
  crf: number;
  x264Preset: string;
  audioBitrate: string;
  /** Integrated loudness target, LUFS. */
  loudness: number;
  maxrate?: string;
  bufsize?: string;
}

export const PRESETS: Record<string, ExportPreset> = {
  youtube: { id: 'youtube', label: 'YouTube 16:9 1080p', width: 1920, height: 1080, fit: 'contain', crf: 18, x264Preset: 'medium', audioBitrate: '192k', loudness: -14 },
  shorts: { id: 'shorts', label: 'Shorts 9:16 1080x1920', width: 1080, height: 1920, fit: 'cover', crf: 20, x264Preset: 'medium', audioBitrate: '192k', loudness: -14 },
  '4k': { id: '4k', label: '4K UHD 16:9', width: 3840, height: 2160, fit: 'contain', crf: 18, x264Preset: 'medium', audioBitrate: '256k', loudness: -14 },
  school: { id: 'school', label: 'School MP4 (small, 720p)', width: 1280, height: 720, fit: 'contain', crf: 28, x264Preset: 'medium', audioBitrate: '128k', loudness: -16, maxrate: '2M', bufsize: '4M' },
};

export interface EngineOptions {
  /** Where thumbnails, waveforms, proxies, transcripts and exports go. */
  cacheDir?: string;
  /** Folder relative media paths resolve against (normally the project file's folder). */
  baseDir?: string;
  transcriber?: Transcriber;
  /** Folder libass searches for fonts used by text clips. */
  fontsDir?: string;
  /** Render previews from proxies when a media item has one. */
  useProxies?: boolean;
}

export interface FrameOptions {
  /** Preview width in pixels; height follows the project aspect. Defaults to project width. */
  width?: number;
  format?: 'png' | 'rgba';
}

export interface Frame {
  width: number;
  height: number;
  format: 'png' | 'rgba';
  data: Buffer;
}

export interface AudioBuffer {
  sampleRate: number;
  channels: 2;
  /** Interleaved stereo float samples. */
  data: Float32Array;
}

export interface ExportOptions {
  output?: string;
  signal?: AbortSignal;
}

const DEFAULT_FONT_DIRS = ['/System/Library/Fonts/Supplemental', '/usr/share/fonts', 'C:\\Windows\\Fonts'];

export class Engine {
  readonly cacheDir: string;
  baseDir: string;
  private transcriber?: Transcriber;
  private fontsDir?: string;
  private useProxies: boolean;
  private media = new Map<string, Media>();
  private probes = new Map<string, ProbeResult>();
  private transcripts = new Map<string, Transcript>();

  constructor(opts: EngineOptions = {}) {
    this.cacheDir = path.resolve(opts.cacheDir ?? path.join(os.tmpdir(), 'pro-video-engine'));
    this.baseDir = path.resolve(opts.baseDir ?? process.cwd());
    this.transcriber = opts.transcriber ?? whisperCppFromEnv();
    this.fontsDir = opts.fontsDir ?? DEFAULT_FONT_DIRS.find((d) => existsSync(d));
    this.useProxies = opts.useProxies ?? false;
  }

  // ---------- project & media registry ----------

  /** Registers a project's media so mediaId-based calls work. Loads any cached transcripts. */
  async openProject(project: Project, baseDir?: string): Promise<void> {
    const errs = validateProject(project);
    if (errs.length) throw new EngineError('INVALID_PROJECT', errs.join('\n'));
    if (baseDir) this.baseDir = path.resolve(baseDir);
    for (const m of project.media) await this.register(m);
  }

  /** Probes a file and returns a media entry ready to put in project.media. */
  async importMedia(file: string, id?: string): Promise<Media> {
    const abs = this.resolvePath(file);
    const probe = await this.probe(abs);
    const m: Media = { id: id ?? `m${this.media.size + 1}`, path: file, proxyPath: null, duration: probe.duration, type: probe.type };
    await this.register(m);
    return m;
  }

  private async register(m: Media): Promise<void> {
    this.media.set(m.id, m);
    if (this.transcripts.has(m.id)) return;
    const abs = this.resolvePath(m.path);
    if (!existsSync(abs)) return;
    const cached = path.join(this.cacheDir, transcriptFileName(await fileKey(abs)));
    if (existsSync(cached)) this.transcripts.set(m.id, { ...JSON.parse(await readFile(cached, 'utf8')), mediaId: m.id });
  }

  resolvePath(p: string): string {
    return path.isAbsolute(p) ? p : path.join(this.baseDir, p);
  }

  private getMedia(mediaId: string): Media {
    const m = this.media.get(mediaId);
    if (!m) throw new EngineError('UNKNOWN_MEDIA', `unknown mediaId ${mediaId}; call openProject() or importMedia() first`);
    return m;
  }

  private async probe(abs: string): Promise<ProbeResult> {
    let p = this.probes.get(abs);
    if (!p) {
      p = await probeMedia(abs);
      this.probes.set(abs, p);
    }
    return p;
  }

  private async resolveAll(project: Project, preferProxies: boolean): Promise<(id: string) => ResolvedMedia | undefined> {
    const out = new Map<string, ResolvedMedia>();
    for (const m of project.media) {
      const original = this.resolvePath(m.path);
      const file = preferProxies && m.proxyPath && existsSync(this.resolvePath(m.proxyPath)) ? this.resolvePath(m.proxyPath) : original;
      const probe = await this.probe(original);
      out.set(m.id, { media: m, file, hasVideo: !!probe.video, hasAudio: !!probe.audio });
    }
    return (id) => out.get(id);
  }

  private async withGraph<T>(project: Project, opts: GraphRequest, preferProxies: boolean, fn: (g: Graph) => Promise<T>): Promise<T> {
    const errs = validateProject(project);
    if (errs.length) throw new EngineError('INVALID_PROJECT', errs.join('\n'));
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pve-'));
    try {
      const g = await buildGraph(project, {
        ...opts,
        tmpDir,
        fontsDir: this.fontsDir,
        resolve: await this.resolveAll(project, preferProxies),
        resolvePath: (p) => this.resolvePath(p),
      });
      return await fn(g);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  // ---------- contract functions ----------

  probeMedia(file: string): Promise<ProbeResult> {
    return this.probe(this.resolvePath(file));
  }

  async getThumbnails(mediaId: string, count: number): Promise<string[]> {
    const abs = this.resolvePath(this.getMedia(mediaId).path);
    return thumbnails(abs, await this.probe(abs), Math.max(1, Math.floor(count)), this.cacheDir);
  }

  async getWaveform(mediaId: string): Promise<Waveform> {
    const abs = this.resolvePath(this.getMedia(mediaId).path);
    return waveform(abs, await this.probe(abs), this.cacheDir);
  }

  /** Returns the proxy path and sets proxyPath on the registered media entry. */
  async makeProxy(mediaId: string, onProgress?: (fraction: number) => void): Promise<string> {
    const m = this.getMedia(mediaId);
    const abs = this.resolvePath(m.path);
    const out = await proxy(abs, await this.probe(abs), this.cacheDir, onProgress);
    m.proxyPath = out;
    return out;
  }

  /** One composited frame at a timeline time, for the preview window. */
  async getFrameAt(project: Project, time: number, opts: FrameOptions = {}): Promise<Frame> {
    const { width: PW, height: PH, fps } = project.settings;
    const width = Math.round((opts.width ?? PW) / 2) * 2;
    const height = Math.round((width * PH) / PW / 2) * 2;
    const format = opts.format ?? 'png';
    const t = Math.max(0, time);
    const data = await this.withGraph(project, { from: t, to: t + 1 / fps, audio: false, width, height }, this.useProxies, async (g) => {
      const outArgs = format === 'png' ? ['-c:v', 'png', '-f', 'image2pipe'] : ['-pix_fmt', 'rgba', '-f', 'rawvideo'];
      const { stdout } = await ffmpeg(['-v', 'error', ...g.args, '-map', g.video!, '-frames:v', '1', ...outArgs, '-'], { captureStdout: true });
      return stdout;
    });
    if (!data.length) throw new EngineError('RENDER_FAILED', `no frame produced at ${t}s`);
    return { width, height, format, data };
  }

  /** Mixed stereo audio for a timeline range, for playback. */
  async getAudio(project: Project, from: number, to: number): Promise<AudioBuffer> {
    const { sampleRate } = project.settings;
    const data = await this.withGraph(project, { from: Math.max(0, from), to, video: false }, this.useProxies, async (g) => {
      const { stdout } = await ffmpeg(['-v', 'error', ...g.args, '-map', g.audio!, '-ac', '2', '-ar', String(sampleRate), '-f', 'f32le', '-c:a', 'pcm_f32le', '-'], { captureStdout: true });
      return stdout;
    });
    const copy = new Float32Array(data.byteLength / 4);
    new Uint8Array(copy.buffer).set(data.subarray(0, copy.byteLength));
    return { sampleRate, channels: 2, data: copy };
  }

  /** Writes the timeline's mixed audio to a WAV file. */
  async exportAudio(project: Project, from: number, to: number, output: string): Promise<string> {
    await this.withGraph(project, { from: Math.max(0, from), to, video: false }, false, (g) =>
      ffmpeg(['-v', 'error', ...g.args, '-map', g.audio!, '-c:a', 'pcm_s16le', output]));
    return output;
  }

  async transcribe(mediaId: string): Promise<Transcript> {
    const cachedHit = this.transcripts.get(mediaId);
    if (cachedHit) return cachedHit;
    if (!this.transcriber) throw notConfigured();
    const m = this.getMedia(mediaId);
    const abs = this.resolvePath(m.path);
    const probe = await this.probe(abs);
    if (!probe.audio) throw new EngineError('UNSUPPORTED', `${mediaId} has no audio to transcribe`);
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'pve-tr-'));
    try {
      const wav = path.join(tmp, 'audio.wav');
      await ffmpeg(['-v', 'error', '-i', abs, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
      const r = await this.transcriber.transcribe(wav);
      const t: Transcript = { mediaId, language: r.language, words: r.words.map((w) => ({ ...w, speaker: w.speaker ?? 'S1' })) };
      const file = path.join(this.cacheDir, transcriptFileName(await fileKey(abs)));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(t));
      this.transcripts.set(mediaId, t);
      return t;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /** Searches every transcribed media item. Results are source-file times. */
  async searchFootage(query: string, limit = 20): Promise<SearchHit[]> {
    const known = [...this.transcripts.values()].filter((t) => this.media.has(t.mediaId));
    return searchTranscripts(known, query, limit);
  }

  /** Silences, filler words (needs transcripts), cuts and pacing flags. */
  async analyse(project: Project, opts: { noiseDb?: number; minSilence?: number } = {}): Promise<Analysis> {
    await this.openProject(project);
    const duration = projectDuration(project);
    if (duration <= 0) return analyseTimeline(project, 0, [], this.transcripts);
    const silencedetect = `silencedetect=n=${opts.noiseDb ?? -35}dB:d=${opts.minSilence ?? 0.6}`;
    const stderr = await this.withGraph(project, { from: 0, to: duration, video: false, audioFilters: [silencedetect] }, false, async (g) =>
      (await ffmpeg(['-v', 'info', ...g.args, '-map', g.audio!, '-f', 'null', '-'])).stderr);
    return analyseTimeline(project, duration, parseSilences(stderr, duration), this.transcripts);
  }

  async exportProject(project: Project, preset: string | ExportPreset, onProgress?: (fraction: number) => void, opts: ExportOptions = {}): Promise<string> {
    const p = typeof preset === 'string' ? PRESETS[preset] : preset;
    if (!p) throw new EngineError('UNKNOWN_PRESET', `unknown preset ${preset}; choose one of ${Object.keys(PRESETS).join(', ')}`);
    const duration = projectDuration(project);
    if (duration <= 0) throw new EngineError('EMPTY_PROJECT', 'nothing on the timeline to export');
    const output = path.resolve(opts.output ?? path.join(this.cacheDir, 'exports', `export-${p.id}-${Date.now()}.mp4`));
    await mkdir(path.dirname(output), { recursive: true });
    const partial = output.replace(/(\.\w+)?$/, '.partial$1');
    const { fps } = project.settings;

    await this.withGraph(project, { from: 0, to: duration, width: p.width, height: p.height, fit: p.fit, loudness: p.loudness }, false, async (g) => {
      const rate = p.maxrate ? ['-maxrate', p.maxrate, '-bufsize', p.bufsize ?? p.maxrate] : [];
      const args = ['-v', 'error', ...g.args, '-map', g.video!, '-map', g.audio!,
        '-c:v', 'libx264', '-preset', p.x264Preset, '-crf', String(p.crf), ...rate, '-pix_fmt', 'yuv420p', '-r', String(fps),
        '-c:a', 'aac', '-b:a', p.audioBitrate, '-ar', '48000', '-t', String(duration),
        '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', partial];
      await ffmpeg(args, { onStdoutLine: progressParser(duration, onProgress), signal: opts.signal });
    });
    await rename(partial, output);
    onProgress?.(1);
    return output;
  }
}

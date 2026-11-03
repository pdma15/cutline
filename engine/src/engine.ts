import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  analyseTimeline, notConfigured, parseSilences, searchDescriptions, searchTranscripts, transcriptFileName, whisperCppFromEnv,
  type Analysis, type SearchHit, type Transcriber, type Transcript,
} from './ai.js';
import { clipLength, projectDuration, validateProject, type Media, type Project } from './contract.js';
import { EngineError, ffmpeg } from './ffmpeg.js';
import { captionsFromTranscripts, subtitles, type CaptionOptions } from './captions.js';
import { claudeFromEnv, type Describer, type FrameDescription, type Matcher, type Translator } from './claude.js';
import { fileKey, probeMedia, progressParser, proxy, thumbnails, waveform, type ProbeResult, type Waveform } from './media.js';
import {
  audioFeatures, autoSwitchSegments, multicamClips, readPcm, speakerForWords, syncAngles,
  type AudioFeatures, type MulticamSync, type SwitchOptions, type SwitchSegment,
} from './multicam.js';
import { effectOf, isTextClip, type MediaClip, type TextClip } from './contract.js';
import { keyframesFromTrack, trackSubject, type SubjectTrack } from './reframe.js';
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
  /** Describes frames for visual search. Defaults to Claude when ANTHROPIC_API_KEY is set. */
  describer?: Describer;
  /** Translates captions. Defaults to Claude when ANTHROPIC_API_KEY is set. */
  translator?: Translator;
  /** Semantic matching for searchFootage({semantic: true}). Defaults to Claude when ANTHROPIC_API_KEY is set. */
  matcher?: Matcher;
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

/**
 * Splits the timeline into frame ranges of at most a minute, cutting earlier when a range would
 * open more than 32 clips at once (fast-cut edits), so every FFmpeg graph stays small.
 */
export function exportChunks(project: Project, totalFrames: number, fps: number, maxSeconds = 60, maxClips = 32): Array<[number, number]> {
  const spans = project.tracks.flatMap((t) => (t.kind === 'text' ? [] : t.clips.map((c) => [c.start, c.start + clipLength(c)] as const)));
  const maxFrames = Math.max(1, Math.round(maxSeconds * fps));
  const out: Array<[number, number]> = [];
  for (let f0 = 0; f0 < totalFrames; ) {
    let f1 = Math.min(totalFrames, f0 + maxFrames);
    const count = (a: number, b: number) => spans.filter(([s, e]) => s < b / fps && e > a / fps).length;
    while (f1 - f0 > fps && count(f0, f1) > maxClips) f1 = f0 + Math.max(Math.round(fps), Math.floor((f1 - f0) / 2));
    out.push([f0, f1]);
    f0 = f1;
  }
  return out;
}

const DEFAULT_FONT_DIRS = ['/System/Library/Fonts/Supplemental', '/usr/share/fonts', 'C:\\Windows\\Fonts'];

export class Engine {
  readonly cacheDir: string;
  baseDir: string;
  private transcriber?: Transcriber;
  private describer?: Describer;
  private translator?: Translator;
  private matcher?: Matcher;
  private visual = new Map<string, { mediaId: string; span: number; describer: string; frames: FrameDescription[] }>();
  private fontsDir?: string;
  private useProxies: boolean;
  private media = new Map<string, Media>();
  private probes = new Map<string, ProbeResult>();
  private transcripts = new Map<string, Transcript>();
  private features = new Map<string, AudioFeatures>();

  constructor(opts: EngineOptions = {}) {
    this.cacheDir = path.resolve(opts.cacheDir ?? path.join(os.tmpdir(), 'pro-video-engine'));
    this.baseDir = path.resolve(opts.baseDir ?? process.cwd());
    this.transcriber = opts.transcriber ?? whisperCppFromEnv();
    const claude = claudeFromEnv();
    this.describer = opts.describer ?? claude;
    this.translator = opts.translator ?? claude;
    this.matcher = opts.matcher ?? claude;
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
    const abs = this.resolvePath(m.path);
    if (!existsSync(abs)) return;
    const key = await fileKey(abs);
    const cached = path.join(this.cacheDir, transcriptFileName(key));
    if (!this.transcripts.has(m.id) && existsSync(cached)) this.transcripts.set(m.id, { ...JSON.parse(await readFile(cached, 'utf8')), mediaId: m.id });
    const visual = path.join(this.cacheDir, 'visual', `${key}.json`);
    if (!this.visual.has(m.id) && existsSync(visual)) this.visual.set(m.id, { ...JSON.parse(await readFile(visual, 'utf8')), mediaId: m.id });
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

  /**
   * Samples a frame every `interval` seconds and has the describer write what's on screen, so
   * searchFootage can find visual moments. Cached per file; costs one model call per `batch` frames.
   */
  async indexFootage(mediaId: string, opts: { interval?: number; batch?: number; onProgress?: (f: number) => void } = {}): Promise<FrameDescription[]> {
    const have = this.visual.get(mediaId);
    if (have) return have.frames;
    if (!this.describer) throw new EngineError('AI_NOT_CONFIGURED', 'no frame describer configured: set ANTHROPIC_API_KEY, or pass a describer to new Engine()');
    const abs = this.resolvePath(this.getMedia(mediaId).path);
    const probe = await this.probe(abs);
    if (probe.type === 'audio') throw new EngineError('UNSUPPORTED', `${mediaId} has no picture to index`);
    const interval = opts.interval ?? 5;
    const batch = opts.batch ?? 8;
    const { stdout } = await ffmpeg(['-v', 'error', '-i', abs, '-vf', `fps=1/${interval},scale=512:-2`, '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', '-'], { captureStdout: true });
    // Split the MJPEG stream at each start-of-image marker.
    const starts: number[] = [];
    for (let i = 0; i + 2 < stdout.length; i++) if (stdout[i] === 0xff && stdout[i + 1] === 0xd8 && stdout[i + 2] === 0xff) starts.push(i);
    const frames = starts.map((s, i) => ({ time: i * interval, jpeg: stdout.subarray(s, starts[i + 1] ?? stdout.length) }));
    const out: FrameDescription[] = [];
    for (let i = 0; i < frames.length; i += batch) {
      out.push(...(await this.describer.describe(frames.slice(i, i + batch))));
      opts.onProgress?.(Math.min(1, (i + batch) / frames.length));
    }
    const entry = { mediaId, span: interval, describer: this.describer.name, frames: out.sort((a, b) => a.time - b.time) };
    const file = path.join(this.cacheDir, 'visual', `${await fileKey(abs)}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(entry));
    this.visual.set(mediaId, entry);
    return entry.frames;
  }

  /**
   * Searches what was said (transcripts) and what was seen (indexFootage). Results are source-file times.
   * With `semantic: true` and a matcher configured, a model ranks the moments instead of keyword matching,
   * so "someone falls in the water" also finds "slips into the pool".
   */
  async searchFootage(query: string, opts: number | { limit?: number; semantic?: boolean } = {}): Promise<SearchHit[]> {
    const { limit = 20, semantic = false } = typeof opts === 'number' ? { limit: opts } : opts;
    const transcripts = [...this.transcripts.values()].filter((t) => this.media.has(t.mediaId));
    const visual = [...this.visual.values()].filter((v) => this.media.has(v.mediaId));
    if (!semantic) {
      return [...searchTranscripts(transcripts, query, limit), ...searchDescriptions(visual, query, limit)]
        .sort((a, b) => b.score - a.score || a.time - b.time)
        .slice(0, limit);
    }
    if (!this.matcher) throw new EngineError('AI_NOT_CONFIGURED', 'semantic search needs a matcher: set ANTHROPIC_API_KEY, or pass a matcher to new Engine()');
    // Moments: each frame description, and the transcript in ~10-word chunks.
    const moments: Array<Omit<SearchHit, 'score'>> = [];
    for (const v of visual) for (const f of v.frames) moments.push({ mediaId: v.mediaId, time: f.time, end: f.time + v.span, text: f.text, source: 'visual' });
    for (const t of transcripts) {
      for (let i = 0; i < t.words.length; i += 10) {
        const ws = t.words.slice(i, i + 10);
        moments.push({ mediaId: t.mediaId, time: ws[0].start, end: ws[ws.length - 1].end, text: ws.map((w) => w.text).join(' '), source: 'transcript' });
      }
    }
    const ranked = await this.matcher.match(query, moments.map((m, id) => ({ id, text: `[${m.source}] ${m.text}` })));
    return ranked.sort((a, b) => b.score - a.score).slice(0, limit).map((r) => ({ ...moments[r.id], score: Math.round(r.score * 100) / 100 }));
  }

  // ---------- captions ----------

  /** Caption text clips for everything said on the timeline (needs transcripts). */
  async autoCaptions(project: Project, opts: CaptionOptions = {}): Promise<TextClip[]> {
    await this.openProject(project);
    return captionsFromTranscripts(project, this.transcripts, opts);
  }

  /**
   * Returns a copy of the project with a translated copy of a text track. The translation is shown
   * and the original is hidden, so exporting gives the translated version.
   */
  async translateCaptions(project: Project, language: string, opts: { trackId?: string } = {}): Promise<Project> {
    if (!this.translator) throw new EngineError('AI_NOT_CONFIGURED', 'no translator configured: set ANTHROPIC_API_KEY, or pass a translator to new Engine()');
    const out: Project = structuredClone(project);
    const src = out.tracks.find((t) => t.kind === 'text' && (opts.trackId ? t.id === opts.trackId : !t.hidden));
    if (!src) throw new EngineError('NOT_FOUND', opts.trackId ? `no text track ${opts.trackId}` : 'no visible text track to translate');
    const clips = src.clips.filter(isTextClip);
    const translated: string[] = [];
    for (let i = 0; i < clips.length; i += 50) translated.push(...(await this.translator.translate(clips.slice(i, i + 50).map((c) => c.text), language)));
    const slug = language.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    out.tracks.push({ id: `${src.id}-${slug}`, kind: 'text', clips: clips.map((c, i) => ({ ...structuredClone(c), id: `${c.id}-${slug}`, text: translated[i] })) });
    src.hidden = true;
    return out;
  }

  /** SRT or WebVTT text for a caption track. */
  subtitles(project: Project, opts: { trackId?: string; format?: 'srt' | 'vtt' } = {}): string {
    return subtitles(project, opts);
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

  // ---------- auto-reframe ----------

  /** Where the action is in a video over time (smoothed). Cached per file. */
  async trackSubject(mediaId: string): Promise<SubjectTrack> {
    const abs = this.resolvePath(this.getMedia(mediaId).path);
    const probe = await this.probe(abs);
    if (probe.type !== 'video') throw new EngineError('UNSUPPORTED', `${mediaId} is not a video`);
    const cached = path.join(this.cacheDir, 'subjects', `${await fileKey(abs)}.json`);
    if (existsSync(cached)) return JSON.parse(await readFile(cached, 'utf8'));
    const track = await trackSubject(abs, probe.duration);
    await mkdir(path.dirname(cached), { recursive: true });
    await writeFile(cached, JSON.stringify(track));
    return track;
  }

  /**
   * Returns a copy of the project at a new aspect (default 1080x1920 for Shorts) where every
   * full-frame video clip gets a `reframe` effect that pans to follow its subject.
   */
  async autoReframe(project: Project, opts: { width?: number; height?: number } = {}): Promise<Project> {
    await this.openProject(project);
    const out: Project = structuredClone(project);
    out.settings = { ...out.settings, width: opts.width ?? 1080, height: opts.height ?? 1920 };
    const sizeScale = Math.sqrt((out.settings.width * out.settings.height) / (project.settings.width * project.settings.height));
    for (const track of out.tracks) {
      for (const c of track.clips) {
        if (isTextClip(c)) {
          // Keep text the same visual size relative to the new frame.
          if (c.style?.fontSize) c.style.fontSize = Math.round(c.style.fontSize * sizeScale);
          continue;
        }
        if (track.kind !== 'video' || effectOf(c, 'transform') || this.getMedia(c.mediaId).type !== 'video') continue;
        const keyframes = keyframesFromTrack(await this.trackSubject(c.mediaId), c.in, c.out);
        c.effects = [...(c.effects ?? []).filter((e) => e.type !== 'reframe'), { type: 'reframe', keyframes }];
      }
    }
    return out;
  }

  // ---------- speaker labels ----------

  /**
   * Fills in `speaker` on a transcript using per-person mics from a multicam sync.
   * `speakers` are the angles with a close mic on one person (default: every angle except `wide`);
   * `names` maps them to display names, e.g. { camA: 'Host', camB: 'Guest' }.
   */
  async labelSpeakers(mediaId: string, sync: MulticamSync, opts: { speakers?: string[]; wide?: string; names?: Record<string, string> } = {}): Promise<Transcript> {
    const t = await this.transcribe(mediaId);
    const speakers = opts.speakers ?? sync.angles.map((a) => a.mediaId).filter((id) => id !== opts.wide);
    const features = new Map<string, AudioFeatures>();
    for (const id of speakers) features.set(id, (await this.audioFeaturesFor(id)).features);
    const labels = speakerForWords(t.words, mediaId, sync, features, { speakers, names: opts.names });
    const labelled: Transcript = { ...t, words: t.words.map((w, i) => ({ ...w, speaker: labels[i] })) };
    const abs = this.resolvePath(this.getMedia(mediaId).path);
    await writeFile(path.join(this.cacheDir, transcriptFileName(await fileKey(abs))), JSON.stringify(labelled));
    this.transcripts.set(mediaId, labelled);
    return labelled;
  }

  // ---------- multicam ----------

  private async audioFeaturesFor(mediaId: string): Promise<{ file: string; features: AudioFeatures; duration: number }> {
    const abs = this.resolvePath(this.getMedia(mediaId).path);
    const probe = await this.probe(abs);
    if (!probe.audio) throw new EngineError('UNSUPPORTED', `${mediaId} has no audio, so it cannot be synced or auto-switched`);
    const key = await fileKey(abs);
    let f = this.features.get(key);
    if (!f) {
      const cached = path.join(this.cacheDir, 'features', `${key}.json`);
      if (existsSync(cached)) {
        const j = JSON.parse(await readFile(cached, 'utf8'));
        f = { duration: j.duration, onset: Float32Array.from(j.onset), level: Float32Array.from(j.level) };
      } else {
        f = audioFeatures(await readPcm(abs));
        await mkdir(path.dirname(cached), { recursive: true });
        const r = (a: Float32Array) => Array.from(a, (v) => Math.round(v * 1000) / 1000);
        await writeFile(cached, JSON.stringify({ duration: f.duration, onset: r(f.onset), level: r(f.level) }));
      }
      this.features.set(key, f);
    }
    return { file: abs, features: f, duration: probe.duration || f.duration };
  }

  /** Lines up camera angles by their audio. offset = where each angle's time 0 falls in reference time. */
  async syncMulticam(mediaIds: string[], opts: { reference?: string; maxOffset?: number } = {}): Promise<MulticamSync> {
    const inputs = [];
    for (const id of mediaIds) inputs.push({ mediaId: id, ...(await this.audioFeaturesFor(id)) });
    return syncAngles(inputs, opts);
  }

  /** Cuts between synced angles to follow whoever is speaking. Returns segments and ready-to-insert clips. */
  async autoSwitch(sync: MulticamSync, opts: SwitchOptions & { timelineStart?: number; audioFrom?: string; idPrefix?: string } = {}): Promise<{
    segments: SwitchSegment[];
    clips: { video: MediaClip[]; audio: MediaClip[] };
  }> {
    const features = new Map<string, AudioFeatures>();
    for (const a of sync.angles) features.set(a.mediaId, (await this.audioFeaturesFor(a.mediaId)).features);
    const segments = autoSwitchSegments(sync, features, opts);
    return { segments, clips: multicamClips(sync, segments, opts) };
  }

  async exportProject(project: Project, preset: string | ExportPreset, onProgress?: (fraction: number) => void, opts: ExportOptions = {}): Promise<string> {
    const p = typeof preset === 'string' ? PRESETS[preset] : preset;
    if (!p) throw new EngineError('UNKNOWN_PRESET', `unknown preset ${preset}; choose one of ${Object.keys(PRESETS).join(', ')}`);
    const duration = projectDuration(project);
    if (duration <= 0) throw new EngineError('EMPTY_PROJECT', 'nothing on the timeline to export');
    const output = path.resolve(opts.output ?? path.join(this.cacheDir, 'exports', `export-${p.id}-${Date.now()}.mp4`));
    await mkdir(path.dirname(output), { recursive: true });
    const partial = output.replace(/(\.\w+)?$/, '.partial$1');
    const { fps, sampleRate } = project.settings;
    const errs = validateProject(project);
    if (errs.length) throw new EngineError('INVALID_PROJECT', errs.join('\n'));

    // Long timelines with many cuts are rendered in chunks: one FFmpeg graph per chunk only opens the
    // clips inside it. Video chunks are joined without re-encoding; audio chunks are raw PCM so they join
    // sample-exactly, then the whole soundtrack is loudness-normalised and encoded once.
    const totalFrames = Math.round(duration * fps);
    const chunks = exportChunks(project, totalFrames, fps);
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'pve-export-'));
    try {
      const done = new Array<number>(chunks.length).fill(0);
      const report = () => onProgress?.(Math.min(0.99, (0.95 * done.reduce((a, b) => a + b, 0)) / totalFrames));
      const rate = p.maxrate ? ['-maxrate', p.maxrate, '-bufsize', p.bufsize ?? p.maxrate] : [];
      const workers = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
      let next = 0;
      const work = async () => {
        while (next < chunks.length) {
          const i = next++;
          const [f0, f1] = chunks[i];
          const from = f0 / fps;
          const to = f1 / fps;
          const samples = Math.round(to * sampleRate) - Math.round(from * sampleRate);
          await this.withGraph(project, { from, to, width: p.width, height: p.height, fit: p.fit, audioSamples: samples }, false, async (g) => {
            const frames = f1 - f0;
            await ffmpeg(['-v', 'error', ...g.args,
              '-map', g.video!, '-frames:v', String(frames), '-c:v', 'libx264', '-preset', p.x264Preset, '-crf', String(p.crf), ...rate, '-pix_fmt', 'yuv420p', '-r', String(fps),
              '-progress', 'pipe:1', '-nostats', path.join(tmp, `v${i}.mp4`),
              '-map', g.audio!, '-c:a', 'pcm_f32le', '-ar', String(sampleRate), '-ac', '2', '-rf64', 'auto', path.join(tmp, `a${i}.wav`)],
            {
              signal: opts.signal,
              onStdoutLine: (line) => {
                const m = /^frame=(\d+)/.exec(line);
                if (m) {
                  done[i] = Math.min(frames, Number(m[1]));
                  report();
                }
              },
            });
            done[i] = frames;
            report();
          });
        }
      };
      await Promise.all(Array.from({ length: Math.min(workers, chunks.length) }, work));

      const list = (prefix: string, ext: string) => chunks.map((_, i) => `file '${path.join(tmp, `${prefix}${i}.${ext}`).replace(/'/g, "'\\''")}'`).join('\n');
      await writeFile(path.join(tmp, 'v.txt'), list('v', 'mp4'));
      await writeFile(path.join(tmp, 'a.txt'), list('a', 'wav'));
      await ffmpeg(['-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'v.txt'), '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'a.txt'),
        '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
        '-af', `loudnorm=I=${p.loudness}:TP=-1.5:LRA=11,aresample=48000`, '-c:a', 'aac', '-b:a', p.audioBitrate, '-ar', '48000',
        '-t', String(totalFrames / fps), '-movflags', '+faststart', partial], { signal: opts.signal });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    await rename(partial, output);
    onProgress?.(1);
    return output;
  }
}

// AI features. Every model is optional: Simple mode must work offline with none configured.

import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { clipLength, clipRate, isTextClip, type MediaClip, type Project } from './contract.js';
import { EngineError, run } from './ffmpeg.js';

export interface Word {
  text: string;
  start: number;
  end: number;
  speaker: string;
}

export interface Transcript {
  mediaId: string;
  language?: string;
  words: Word[];
}

/** Turns a 16 kHz mono WAV into timed words. Plug in any model behind this. */
export interface Transcriber {
  name: string;
  transcribe(wavFile: string): Promise<{ language?: string; words: Array<Omit<Word, 'speaker'> & { speaker?: string }> }>;
}

/**
 * whisper.cpp (https://github.com/ggerganov/whisper.cpp), run locally.
 * Set WHISPER_CPP_BIN to the whisper-cli binary and WHISPER_MODEL to a ggml model file.
 * Speaker labels are not produced by Whisper, so every word is "S1".
 */
export function whisperCppFromEnv(): Transcriber | undefined {
  const bin = process.env.WHISPER_CPP_BIN;
  const model = process.env.WHISPER_MODEL;
  if (!bin || !model) return undefined;
  return {
    name: 'whisper.cpp',
    async transcribe(wav) {
      const base = wav.replace(/\.wav$/, '');
      // -ml 1 -sow: one word per segment, split on word boundaries.
      await run(bin, ['-m', model, '-f', wav, '-ml', '1', '-sow', '-oj', '-of', base, '-np']);
      const json = JSON.parse(await readFile(`${base}.json`, 'utf8'));
      await rm(`${base}.json`, { force: true });
      const words = (json.transcription ?? [])
        .map((s: any) => ({ text: String(s.text).trim(), start: s.offsets.from / 1000, end: s.offsets.to / 1000 }))
        .filter((w: Word) => w.text);
      return { language: json.result?.language, words };
    },
  };
}

export const notConfigured = () =>
  new EngineError('AI_NOT_CONFIGURED', 'no transcriber configured: set WHISPER_CPP_BIN and WHISPER_MODEL, or pass a transcriber to new Engine()');

// ---------- footage search ----------

export interface SearchHit {
  mediaId: string;
  /** Source-file time of the match, seconds. */
  time: number;
  end: number;
  text: string;
  score: number;
  source: 'transcript';
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').trim();
const tokens = (s: string) => norm(s).split(/\s+/).filter(Boolean);

/** Finds spoken passages matching the query. Scores by how many query words appear close together. */
export function searchTranscripts(transcripts: Iterable<Transcript>, query: string, limit = 20): SearchHit[] {
  const q = [...new Set(tokens(query))];
  if (!q.length) return [];
  const span = Math.max(4, q.length * 3);
  const hits: SearchHit[] = [];
  for (const t of transcripts) {
    const words = t.words.map((w) => norm(w.text));
    let lastEnd = -1;
    for (let i = 0; i < words.length; i++) {
      if (!q.includes(words[i]) || i <= lastEnd) continue;
      const seen = new Set<string>();
      let j = i;
      for (let n = i; n < Math.min(words.length, i + span); n++) {
        if (q.includes(words[n])) {
          seen.add(words[n]);
          j = n;
        }
      }
      const score = seen.size / q.length;
      if (score < Math.min(1, 0.6 + 0.4 / q.length)) continue;
      const ctxFrom = Math.max(0, i - 3);
      const ctxTo = Math.min(words.length - 1, j + 3);
      hits.push({
        mediaId: t.mediaId,
        time: t.words[i].start,
        end: t.words[j].end,
        text: t.words.slice(ctxFrom, ctxTo + 1).map((w) => w.text).join(' '),
        score: Math.round(score * 100) / 100,
        source: 'transcript',
      });
      lastEnd = j;
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.time - b.time).slice(0, limit);
}

// ---------- analysis ----------

export interface Span {
  start: number;
  end: number;
}

export interface Filler extends Span {
  word: string;
  clipId: string;
}

export interface SlowSection extends Span {
  reason: 'mostly silent' | 'long shot without a cut';
}

export interface Analysis {
  duration: number;
  /** Timeline time. */
  silences: Span[];
  fillers: Filler[];
  /** Timeline times where the picture cuts. */
  cuts: number[];
  pacing: {
    /** 0..100, how strongly the first 15 seconds hold attention. Heuristic. */
    hookScore: number;
    hook: { window: number; speechRatio: number; cuts: number; firstSound: number | null };
    slowSections: SlowSection[];
  };
}

const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'hmm', 'mm', 'mhm']);
const FILLER_PAIRS = new Set(['you know', 'i mean', 'kind of', 'sort of']);

export function parseSilences(stderr: string, duration: number): Span[] {
  const out: Span[] = [];
  let open: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (e && open !== null) {
      out.push({ start: open, end: Number(e[1]) });
      open = null;
    }
  }
  if (open !== null) out.push({ start: open, end: duration });
  return out;
}

const overlap = (a: Span, b: Span) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

export function analyseTimeline(project: Project, duration: number, silences: Span[], transcripts: Map<string, Transcript>): Analysis {
  const mediaClips: Array<{ clip: MediaClip; kind: string }> = project.tracks.flatMap((t) =>
    t.kind === 'text' ? [] : t.clips.filter((c): c is MediaClip => !isTextClip(c)).map((clip) => ({ clip, kind: t.kind })),
  );

  const fillers: Filler[] = [];
  for (const { clip } of mediaClips) {
    const tr = transcripts.get(clip.mediaId);
    if (!tr) continue;
    const toTimeline = (t: number) => clip.start + (t - clip.in) / clipRate(clip);
    const ws = tr.words.filter((w) => w.start >= clip.in && w.end <= clip.out);
    ws.forEach((w, i) => {
      const one = norm(w.text);
      const two = i + 1 < ws.length ? `${one} ${norm(ws[i + 1].text)}` : '';
      if (FILLERS.has(one)) fillers.push({ word: w.text, clipId: clip.id, start: toTimeline(w.start), end: toTimeline(w.end) });
      else if (FILLER_PAIRS.has(two)) fillers.push({ word: `${w.text} ${ws[i + 1].text}`, clipId: clip.id, start: toTimeline(w.start), end: toTimeline(ws[i + 1].end) });
    });
  }
  fillers.sort((a, b) => a.start - b.start);

  const cutSet = new Set<number>();
  for (const { clip, kind } of mediaClips) {
    if (kind !== 'video') continue;
    for (const t of [clip.start, clip.start + clipLength(clip)]) if (t > 0.01 && t < duration - 0.01) cutSet.add(Math.round(t * 1000) / 1000);
  }
  const cuts = [...cutSet].sort((a, b) => a - b);

  const hookLen = Math.min(15, duration);
  const hookSpan = { start: 0, end: hookLen };
  const silentInHook = silences.reduce((s, x) => s + overlap(x, hookSpan), 0);
  const speechRatio = hookLen > 0 ? Math.max(0, 1 - silentInHook / hookLen) : 0;
  const hookCuts = cuts.filter((c) => c < hookLen).length;
  const leading = silences.find((s) => s.start <= 0.05);
  const firstSound = leading ? (leading.end < duration ? leading.end : null) : 0;
  const hookScore = Math.round(
    100 * (0.5 * speechRatio + 0.3 * Math.min(1, hookCuts / 3) + 0.2 * (firstSound !== null ? Math.max(0, 1 - firstSound / 2) : 0)),
  );

  const slow: SlowSection[] = [];
  const win = 10;
  for (let t = 0; t + win <= duration + 1e-6; t += win / 2) {
    const span = { start: t, end: t + win };
    if (silences.reduce((s, x) => s + overlap(x, span), 0) > win / 2) slow.push({ ...span, reason: 'mostly silent' });
  }
  const bounds = [0, ...cuts, duration];
  for (let i = 0; i + 1 < bounds.length; i++) if (bounds[i + 1] - bounds[i] > 12) slow.push({ start: bounds[i], end: bounds[i + 1], reason: 'long shot without a cut' });
  const merged: SlowSection[] = [];
  for (const s of slow.sort((a, b) => a.reason.localeCompare(b.reason) || a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && last.reason === s.reason && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }

  return {
    duration,
    silences,
    fillers,
    cuts,
    pacing: {
      hookScore,
      hook: { window: hookLen, speechRatio: Math.round(speechRatio * 100) / 100, cuts: hookCuts, firstSound },
      slowSections: merged.sort((a, b) => a.start - b.start),
    },
  };
}

export const transcriptFileName = (key: string) => path.join('transcripts', `${key}.json`);

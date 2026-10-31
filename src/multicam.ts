// Multicam: line cameras up by their audio, then cut to whoever is speaking.
//
// Sync is two passes:
//   1. Coarse: cross-correlate onset envelopes (100 Hz) with an FFT. Onsets — where the sound gets
//      louder — survive different mics, gains and room noise, and the FFT keeps hours of footage fast.
//   2. Fine: correlate raw 8 kHz audio over a short window within ±30 ms of the coarse answer,
//      giving sub-millisecond offsets. Done at two points to measure clock drift on long takes.
//
// Times: an angle's `offset` is where its source time 0 falls in reference time, so
// referenceTime = sourceTime + offset.

import type { MediaClip } from './contract.js';
import { EngineError, ffmpeg, sec } from './ffmpeg.js';

export const ENVELOPE_RATE = 100;
export const LEVEL_RATE = 10;
const PCM_RATE = 8000;

export interface AudioFeatures {
  duration: number;
  /** Positive changes in log loudness, 100 per second. */
  onset: Float32Array;
  /** RMS level in dBFS, 10 per second. */
  level: Float32Array;
}

export interface SyncedAngle {
  mediaId: string;
  /** Reference time of this angle's source time 0, seconds. */
  offset: number;
  duration: number;
  /** Pearson correlation of the onset envelopes at the chosen offset, 0..1. Below ~0.3 is doubtful. */
  confidence: number;
  /** Seconds of clock drift per hour, if the overlap was long enough to measure. */
  driftPerHour: number | null;
}

export interface MulticamSync {
  reference: string;
  angles: SyncedAngle[];
  /** Reference-time range covered by at least one angle. */
  start: number;
  end: number;
}

// ---------- audio ----------

export async function readPcm(file: string, from = 0, duration?: number): Promise<Float32Array> {
  const range = [...(from > 0 ? ['-ss', sec(from)] : []), ...(duration !== undefined ? ['-t', sec(duration)] : [])];
  const { stdout } = await ffmpeg(['-v', 'error', ...range, '-i', file, '-vn', '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', '-c:a', 'pcm_s16le', '-'], {
    captureStdout: true,
  });
  const n = Math.floor(stdout.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = stdout.readInt16LE(i * 2) / 32768;
  return out;
}

export function audioFeatures(pcm: Float32Array): AudioFeatures {
  const hop = PCM_RATE / ENVELOPE_RATE;
  const frames = Math.floor(pcm.length / hop);
  const logE = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) s += pcm[i] * pcm[i];
    logE[f] = Math.log10(1e-7 + s / hop);
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, logE[f] - logE[f - 1]);

  const per = ENVELOPE_RATE / LEVEL_RATE;
  const level = new Float32Array(Math.floor(frames / per));
  for (let l = 0; l < level.length; l++) {
    let s = 0;
    for (let f = l * per; f < (l + 1) * per; f++) s += Math.pow(10, logE[f]);
    level[l] = 10 * Math.log10(1e-7 + s / per);
  }
  return { duration: pcm.length / PCM_RATE, onset, level };
}

// ---------- FFT ----------

/** In-place iterative radix-2 FFT. `inverse` does not scale. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

const normalise = (x: Float32Array): Float64Array => {
  let mean = 0;
  for (const v of x) mean += v;
  mean /= x.length || 1;
  let sd = 0;
  for (const v of x) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / (x.length || 1)) || 1;
  return Float64Array.from(x, (v) => (v - mean) / sd);
};

/** Pearson correlation of a[i + lag] against b[i] over their overlap. */
function pearsonAt(a: ArrayLike<number>, b: ArrayLike<number>, lag: number, from = 0, to = Infinity): number {
  const i0 = Math.max(0, -lag, from);
  const i1 = Math.min(b.length, a.length - lag, to);
  const n = i1 - i0;
  if (n < 2) return 0;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = i0; i < i1; i++) {
    const x = a[i + lag];
    const y = b[i];
    sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  const cov = sab - (sa * sb) / n;
  const den = Math.sqrt((saa - (sa * sa) / n) * (sbb - (sb * sb) / n));
  return den > 0 ? cov / den : 0;
}

/**
 * Best lag L (in frames) such that b[i] lines up with a[i + L].
 * Lags with less than minOverlap frames of overlap are ignored.
 */
export function bestLag(a: Float32Array, b: Float32Array, minOverlap: number, maxLag = Infinity): { lag: number; r: number } {
  let n = 1;
  while (n < a.length + b.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n);
  const br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(normalise(a));
  br.set(normalise(b));
  fft(ar, ai, false);
  fft(br, bi, false);
  for (let k = 0; k < n; k++) {
    // A * conj(B)
    const r = ar[k] * br[k] + ai[k] * bi[k];
    const i = ai[k] * br[k] - ar[k] * bi[k];
    ar[k] = r;
    ai[k] = i;
  }
  fft(ar, ai, true);
  let best = 0;
  let bestVal = -Infinity;
  for (let lag = -(b.length - 1); lag <= a.length - 1; lag++) {
    if (Math.abs(lag) > maxLag) continue;
    const overlap = Math.min(a.length, lag + b.length) - Math.max(0, lag);
    if (overlap < minOverlap) continue;
    const v = ar[(lag + n) % n];
    if (v > bestVal) {
      bestVal = v;
      best = lag;
    }
  }
  if (bestVal === -Infinity) throw new EngineError('SYNC_FAILED', 'clips do not overlap enough to sync');
  return { lag: best, r: Math.max(0, pearsonAt(a, b, best)) };
}

/**
 * Fine envelope: |x| smoothed over 2 ms with the slow (50 ms) trend removed. Unlike the raw waveform it
 * still lines up between mics at different distances and under a little clock drift.
 */
function fineEnvelope(x: Float32Array): Float32Array {
  const smooth = (v: Float32Array, w: number) => {
    const out = new Float32Array(v.length);
    let acc = 0;
    for (let i = 0; i < v.length; i++) {
      acc += v[i] - (i >= w ? v[i - w] : 0);
      out[i] = acc / Math.min(i + 1, w);
    }
    // centre the window
    const shift = Math.floor(w / 2);
    return Float32Array.from(out, (_, i) => out[Math.min(out.length - 1, i + shift)]);
  };
  const env = smooth(Float32Array.from(x, Math.abs), 16);
  const trend = smooth(env, 400);
  return Float32Array.from(env, (v, i) => v - trend[i]);
}

/** Refines an offset to sub-millisecond accuracy by correlating fine envelopes in a window around reference time t0. */
export async function refineOffset(refFile: string, camFile: string, coarse: number, t0: number, window: number, search = 0.03): Promise<{ offset: number; r: number }> {
  const ref = fineEnvelope(await readPcm(refFile, t0, window));
  const camFrom = t0 - coarse - search;
  const cam = fineEnvelope(await readPcm(camFile, Math.max(0, camFrom), window + 2 * search));
  const shift = Math.round(Math.max(0, camFrom) * PCM_RATE) - Math.round(camFrom * PCM_RATE); // samples lost at file start
  const maxLag = Math.round(search * PCM_RATE);
  // ref[i] lines up with cam[i + maxLag - shift + l] when the true offset is coarse - l / RATE.
  const rs = new Float64Array(2 * maxLag + 1);
  let best = 0;
  for (let l = -maxLag; l <= maxLag; l++) {
    rs[l + maxLag] = pearsonAt(cam, ref, maxLag - shift + l);
    if (rs[l + maxLag] > rs[best + maxLag]) best = l;
  }
  // Parabolic interpolation between samples.
  const [y0, y1, y2] = [rs[best + maxLag - 1], rs[best + maxLag], rs[best + maxLag + 1]];
  const frac = y0 !== undefined && y2 !== undefined && y0 - 2 * y1 + y2 < 0 ? (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2) : 0;
  return { offset: coarse - (best + frac) / PCM_RATE, r: y1 };
}

export interface SyncInput {
  mediaId: string;
  file: string;
  features: AudioFeatures;
  /** Container duration. Decoded audio can run a few ms longer (codec padding). */
  duration: number;
}

export async function syncAngles(inputs: SyncInput[], opts: { reference?: string; maxOffset?: number; refine?: boolean } = {}): Promise<MulticamSync> {
  if (inputs.length < 2) throw new EngineError('SYNC_FAILED', 'multicam needs at least two angles');
  for (const i of inputs) if (!i.features.onset.length) throw new EngineError('SYNC_FAILED', `${i.mediaId} has no audio to sync on`);
  const ref = inputs.find((i) => i.mediaId === opts.reference) ?? inputs[0];
  const maxLag = opts.maxOffset !== undefined ? opts.maxOffset * ENVELOPE_RATE : Infinity;

  const angles: SyncedAngle[] = [];
  for (const cam of inputs) {
    if (cam === ref) {
      angles.push({ mediaId: cam.mediaId, offset: 0, duration: cam.duration, confidence: 1, driftPerHour: null });
      continue;
    }
    const a = ref.features.onset;
    const b = cam.features.onset;
    const minOverlap = Math.min(5 * ENVELOPE_RATE, Math.floor(0.5 * Math.min(a.length, b.length)));
    const { lag, r } = bestLag(a, b, minOverlap, maxLag);
    let offset = lag / ENVELOPE_RATE;
    let driftPerHour: number | null = null;

    if (opts.refine !== false) {
      const ov0 = Math.max(0, offset);
      const ov1 = Math.min(ref.duration, offset + cam.duration);
      const win = Math.min(8, (ov1 - ov0) / 3);
      if (win >= 2) {
        const early = await refineOffset(ref.file, cam.file, offset, ov0 + win * 0.25, win);
        if (early.r > 0.2) offset = early.offset;
        if (ov1 - ov0 > 120) {
          const late = await refineOffset(ref.file, cam.file, offset, ov1 - win * 1.25, win);
          const span = ov1 - ov0 - win * 1.5;
          if (late.r > 0.2 && early.r > 0.2) driftPerHour = Math.round(((late.offset - early.offset) / span) * 3600 * 1000) / 1000;
        }
      }
    }
    angles.push({ mediaId: cam.mediaId, offset: Math.round(offset * 1e5) / 1e5, duration: cam.duration, confidence: Math.round(r * 100) / 100, driftPerHour });
  }
  const start = Math.min(...angles.map((x) => x.offset));
  const end = Math.max(...angles.map((x) => x.offset + x.duration));
  return { reference: ref.mediaId, angles, start, end };
}

// ---------- auto-switch ----------

export interface SwitchOptions {
  /** Angle to use when nobody or everybody is talking. */
  wide?: string;
  /** Shortest allowed shot, seconds. Default 2. */
  minShot?: number;
  /** How far above its own noise floor a mic must be to count as speech, dB. Default 8. */
  speechDb?: number;
  /** If the top two mics are within this many dB, treat it as crosstalk and go wide. Default 3. */
  crosstalkDb?: number;
  /** Cut this many seconds before the speaker starts. Default 0.2. */
  anticipate?: number;
  /** Limit to angles that are people's close-ups (default: all except wide). */
  speakers?: string[];
}

export interface SwitchSegment {
  start: number;
  end: number;
  mediaId: string;
  reason: 'speaker' | 'wide' | 'hold';
}

const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};

/** Picks an angle for every moment in reference time, then smooths it into watchable shots. */
export function autoSwitchSegments(sync: MulticamSync, features: Map<string, AudioFeatures>, o: SwitchOptions = {}): SwitchSegment[] {
  const minShot = o.minShot ?? 2;
  const speechDb = o.speechDb ?? 8;
  const crosstalkDb = o.crosstalkDb ?? 3;
  const speakers = sync.angles.filter((a) => (o.speakers ? o.speakers.includes(a.mediaId) : a.mediaId !== o.wide));
  const wide = sync.angles.find((a) => a.mediaId === o.wide);

  const f0 = Math.floor(sync.start * LEVEL_RATE);
  const f1 = Math.ceil(sync.end * LEVEL_RATE);
  const covers = (a: SyncedAngle, f: number) => f / LEVEL_RATE >= a.offset && f / LEVEL_RATE < a.offset + a.duration;
  const levelAt = (a: SyncedAngle, f: number) => features.get(a.mediaId)!.level[Math.floor(f - a.offset * LEVEL_RATE)] ?? -140;
  const floor = new Map(speakers.map((a) => [a.mediaId, percentile(Array.from(features.get(a.mediaId)!.level), 0.2)]));

  // 1. raw pick per frame
  const raw: Array<{ id: string; reason: SwitchSegment['reason'] } | null> = [];
  let prev: string | null = null;
  for (let f = f0; f < f1; f++) {
    const live = speakers.filter((a) => covers(a, f)).map((a) => ({ id: a.mediaId, above: levelAt(a, f) - floor.get(a.mediaId)! })).sort((x, y) => y.above - x.above);
    const top = live[0];
    const widePossible = wide && covers(wide, f);
    let pick: { id: string; reason: SwitchSegment['reason'] } | null;
    if (top && top.above >= speechDb && !(live[1] && live[1].above >= speechDb && top.above - live[1].above < crosstalkDb && widePossible)) pick = { id: top.id, reason: 'speaker' };
    else if (widePossible) pick = { id: wide!.mediaId, reason: 'wide' };
    else if (prev && live.some((l) => l.id === prev)) pick = { id: prev, reason: 'hold' };
    else if (top) pick = { id: top.id, reason: 'hold' };
    else pick = null;
    raw.push(pick);
    if (pick) prev = pick.id;
  }

  // 2. majority vote over ±0.5 s to kill flicker
  const half = Math.round(LEVEL_RATE / 2);
  const voted = raw.map((p, i) => {
    if (!p) return p;
    const counts = new Map<string, number>();
    for (let j = Math.max(0, i - half); j <= Math.min(raw.length - 1, i + half); j++) {
      const q = raw[j];
      if (q) counts.set(q.id, (counts.get(q.id) ?? 0) + 1);
    }
    const winner = [...counts].sort((x, y) => y[1] - x[1])[0][0];
    return winner === p.id ? p : raw.slice(Math.max(0, i - half), i + half + 1).find((q) => q?.id === winner)!;
  });

  // 3. run-length into segments
  let segs: SwitchSegment[] = [];
  voted.forEach((p, i) => {
    if (!p) return;
    const t = (f0 + i) / LEVEL_RATE;
    const last = segs[segs.length - 1];
    if (last && last.mediaId === p.id && Math.abs(last.end - t) < 1e-6) {
      last.end = t + 1 / LEVEL_RATE;
      if (p.reason === 'speaker') last.reason = 'speaker';
    }
    else segs.push({ start: t, end: t + 1 / LEVEL_RATE, mediaId: p.id, reason: p.reason });
  });

  // 4. absorb shots shorter than minShot into a neighbour that can cover them
  const canCover = (id: string, s: SwitchSegment) => {
    const a = sync.angles.find((x) => x.mediaId === id)!;
    return a.offset <= s.start + 1e-6 && a.offset + a.duration >= s.end - 1e-6;
  };
  // Shots no neighbour can cover (e.g. only one camera was rolling) are left as they are.
  const stuck = new Set<SwitchSegment>();
  // Pauses and wide shots go first, so a short answer isn't swallowed by the gaps around it.
  const len = (s: SwitchSegment) => s.end - s.start;
  const rank = (s: SwitchSegment) => (s.reason === 'speaker' ? 1000 : 0) + len(s);
  for (;;) {
    let idx = -1;
    for (let i = 0; i < segs.length; i++) if (!stuck.has(segs[i]) && len(segs[i]) < minShot - 1e-6 && (idx < 0 || rank(segs[i]) < rank(segs[idx]))) idx = i;
    if (idx < 0) break;
    const s = segs[idx];
    const L = segs[idx - 1];
    const R = segs[idx + 1];
    const touches = (n: SwitchSegment) => Math.abs(n.end - s.start) < 1e-6 || Math.abs(n.start - s.end) < 1e-6;
    const adjacent = (n?: SwitchSegment) => n && touches(n) && canCover(n.mediaId, s);
    const options = [L, R].filter(adjacent) as SwitchSegment[];
    if (!options.length) {
      stuck.add(s);
      continue;
    }
    if (options.length === 2 && L.mediaId !== R.mediaId && s.reason !== 'speaker') {
      // A pause between two different speakers: split it, cutting halfway through.
      L.end = R.start = (s.start + s.end) / 2;
    } else {
      const into = options.length === 2 && L.mediaId === R.mediaId ? L : options.sort((x, y) => len(y) - len(x))[0];
      if (into === L) L.end = s.end;
      else R.start = s.start;
    }
    segs.splice(idx, 1);
    // join neighbours that are now the same angle
    segs = segs.reduce<SwitchSegment[]>((acc, x) => {
      const last = acc[acc.length - 1];
      if (last && last.mediaId === x.mediaId && Math.abs(last.end - x.start) < 1e-6) {
        last.end = x.end;
        if (x.reason === 'speaker') last.reason = 'speaker';
      } else acc.push(x);
      return acc;
    }, []);
  }

  // 5. cut slightly before the new speaker starts
  const lead = o.anticipate ?? 0.2;
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i];
    const p = segs[i - 1];
    if (Math.abs(p.end - s.start) > 1e-6) continue;
    const t = Math.max(p.start + 0.5, s.start - lead);
    if (t < s.start && canCover(s.mediaId, { ...s, start: t })) p.end = s.start = Math.round(t * 1000) / 1000;
  }
  // Frame rounding can step a few ms past the footage; clamp to what each angle recorded.
  const out = segs.map((s) => {
    const a = sync.angles.find((x) => x.mediaId === s.mediaId)!;
    return { ...s, start: Math.round(Math.max(s.start, a.offset) * 1000) / 1000, end: Math.round(Math.min(s.end, a.offset + a.duration) * 1000) / 1000 };
  });
  // Close small gaps (< 1 s) by starting the next shot earlier where its angle has footage.
  for (let i = 1; i < out.length; i++) {
    const gap = out[i].start - out[i - 1].end;
    if (gap > 1e-6 && gap < 1 && canCover(out[i].mediaId, { ...out[i], start: out[i - 1].end })) out[i].start = out[i - 1].end;
  }
  return out;
}

/**
 * Turns segments into timeline clips. Video clips are muted; one audio clip per `audioFrom` angle
 * plays under the whole edit so the sound doesn't jump at each cut.
 */
export function multicamClips(sync: MulticamSync, segments: SwitchSegment[], o: { timelineStart?: number; audioFrom?: string; idPrefix?: string } = {}): { video: MediaClip[]; audio: MediaClip[] } {
  const t0 = o.timelineStart ?? 0;
  const base = segments.length ? segments[0].start : sync.start;
  const id = o.idPrefix ?? 'mc';
  const offset = (m: string) => sync.angles.find((a) => a.mediaId === m)!.offset;
  const round = (n: number) => Math.round(n * 1e5) / 1e5;
  const video: MediaClip[] = segments.map((s, i) => ({
    id: `${id}-v${i + 1}`, mediaId: s.mediaId, start: round(t0 + s.start - base), in: round(s.start - offset(s.mediaId)), out: round(s.end - offset(s.mediaId)), muted: true,
  }));
  const audio: MediaClip[] = [];
  const src = sync.angles.find((a) => a.mediaId === (o.audioFrom ?? sync.reference));
  if (src && segments.length) {
    const end = segments[segments.length - 1].end;
    const from = Math.max(base, src.offset);
    const to = Math.min(end, src.offset + src.duration);
    if (to > from) audio.push({ id: `${id}-a1`, mediaId: src.mediaId, start: round(t0 + from - base), in: round(from - src.offset), out: round(to - src.offset) });
  }
  return { video, audio };
}

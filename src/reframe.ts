// Auto-reframe: follow the subject when a shot is cropped to a different aspect (16:9 -> 9:16).
//
// No model needed. Each low-res frame gets a weight map of motion (what changed since the last
// frame) plus detail (edges), and the subject is the weighted centre of that map. The path is then
// smoothed like a camera operator would: ignore small wobbles, ease towards big moves, and jump on
// scene cuts — forwards and backwards, so the frame doesn't trail the subject. It is a heuristic — it finds "where the action is", not faces specifically.

import { ffmpeg, sec } from './ffmpeg.js';

const AW = 160; // analysis frame size
const AH = 90;

export interface SubjectTrack {
  /** Samples per second. */
  fps: number;
  /** Source-time of each sample, seconds. */
  t: number[];
  /** Subject centre per sample, fractions of the source frame (already smoothed). */
  x: number[];
  y: number[];
  /** Sample indices where a scene cut was detected. */
  cuts: number[];
}

export async function trackSubject(file: string, duration: number, fps = 5): Promise<SubjectTrack> {
  const { stdout } = await ffmpeg(['-v', 'error', '-i', file, '-vf', `fps=${fps},scale=${AW}:${AH}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { captureStdout: true });
  const size = AW * AH;
  const n = Math.floor(stdout.length / size);
  const raw: Array<{ x: number; y: number; strength: number }> = [];
  const cuts: number[] = [];
  let prev: Uint8Array | null = null;
  for (let f = 0; f < n; f++) {
    const img = stdout.subarray(f * size, (f + 1) * size);
    const col = new Float64Array(AW);
    const row = new Float64Array(AH);
    let diff = 0;
    for (let y = 1; y < AH - 1; y++) {
      for (let x = 1; x < AW - 1; x++) {
        const i = y * AW + x;
        const edge = Math.abs(img[i + 1] - img[i - 1]) + Math.abs(img[i + AW] - img[i - AW]);
        const motion = prev ? Math.abs(img[i] - prev[i]) : 0;
        diff += motion;
        const w = 0.5 * edge + 3 * motion;
        col[x] += w;
        row[y] += w;
      }
    }
    if (prev && diff / size > 40) cuts.push(f);
    // Squaring sharpens the profile towards the strongest region instead of the frame's average.
    const centroid = (p: Float64Array) => {
      let s = 0, sw = 0;
      for (let i = 0; i < p.length; i++) {
        const w = p[i] * p[i];
        s += w * i;
        sw += w;
      }
      return sw > 0 ? (s / sw + 0.5) / p.length : 0.5;
    };
    const total = col.reduce((a, b) => a + b, 0);
    raw.push({ x: centroid(col), y: centroid(row), strength: total / size });
    prev = img;
  }

  // Operator-style smoothing: dead zone, then ease towards the target; reset on cuts.
  // We have the whole clip, so run it forwards and backwards and average: no lag behind the subject.
  const cutSet = new Set(cuts);
  const dead = 0.06;
  const ease = Math.min(1, 1.2 / fps); // reaches the target in roughly a second
  const pass = (key: 'x' | 'y', order: number[]) => {
    const out = new Array<number>(raw.length);
    let c = raw[order[0]]?.[key] ?? 0.5;
    for (let k = 0; k < order.length; k++) {
      const f = order[k];
      // A cut sits between f-1 and f: reset when entering either side of it.
      const atCut = cutSet.has(f) || (k > 0 && cutSet.has(order[k - 1]) && order[k - 1] > f);
      const r = raw[f];
      if (atCut) c = r[key];
      else if (r.strength > 0.5 && Math.abs(r[key] - c) > dead) c += (r[key] - c) * ease;
      out[f] = c;
    }
    return out;
  };
  const fwd = raw.map((_, i) => i);
  const bwd = [...fwd].reverse();
  const both = (key: 'x' | 'y') => {
    const a = pass(key, fwd);
    const b = pass(key, bwd);
    return a.map((v, i) => (v + b[i]) / 2);
  };
  const x = both('x');
  const y = both('y');
  const t = raw.map((_, f) => Math.min(duration, f / fps));
  return { fps, t, x, y, cuts };
}

/** Ramer–Douglas–Peucker on (t, x) and (t, y) together: keeps the keyframes needed to stay within `tol`. */
export function keyframesFromTrack(track: SubjectTrack, from: number, to: number, tol = 0.01): Array<{ t: number; x: number; y: number }> {
  const pts = track.t.map((t, i) => ({ t, x: track.x[i], y: track.y[i] })).filter((p) => p.t >= from - 1 / track.fps && p.t <= to + 1 / track.fps);
  if (pts.length <= 2) return pts.length ? pts : [{ t: from, x: 0.5, y: 0.5 }];
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  // Cuts are hard jumps; keep both sides so the pan doesn't smear across them.
  for (const c of track.cuts) {
    const i = pts.findIndex((p) => Math.abs(p.t - track.t[c]) < 1e-6);
    if (i > 0) keep[i] = keep[i - 1] = 1;
  }
  const stack: Array<[number, number]> = [];
  const anchors = [...keep.keys()].filter((i) => keep[i]);
  for (let i = 0; i + 1 < anchors.length; i++) stack.push([anchors[i], anchors[i + 1]]);
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, worstErr = tol;
    for (let i = a + 1; i < b; i++) {
      const f = (pts[i].t - pts[a].t) / (pts[b].t - pts[a].t || 1);
      const err = Math.max(Math.abs(pts[a].x + (pts[b].x - pts[a].x) * f - pts[i].x), Math.abs(pts[a].y + (pts[b].y - pts[a].y) * f - pts[i].y));
      if (err > worstErr) {
        worst = i;
        worstErr = err;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return pts.filter((_, i) => keep[i]).map((p) => ({ t: r3(p.t), x: r3(p.x), y: r3(p.y) }));
}

/**
 * FFmpeg expression for a piecewise-linear keyframe value over local time `t`.
 * `toLocal` maps a keyframe's source time to the filter's local time.
 */
export function piecewiseExpr(keys: Array<{ t: number; v: number }>, toLocal: (t: number) => number): string {
  if (keys.length === 1) return String(keys[0].v);
  const k = keys.map((p) => ({ t: toLocal(p.t), v: p.v }));
  const parts = [`lt(t,${sec(k[0].t)})*${k[0].v}`];
  for (let i = 0; i + 1 < k.length; i++) {
    const a = k[i], b = k[i + 1];
    const span = b.t - a.t;
    if (span <= 0) continue;
    parts.push(`gte(t,${sec(a.t)})*lt(t,${sec(b.t)})*(${a.v}+${b.v - a.v}*(t-${sec(a.t)})/${sec(span)})`);
  }
  parts.push(`gte(t,${sec(k[k.length - 1].t)})*${k[k.length - 1].v}`);
  return parts.join('+');
}

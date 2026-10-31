// Turns a project (or a window of it) into one FFmpeg filtergraph.
// Every renderer — preview frame, playback audio, export, analysis — goes through buildGraph,
// so what the App previews is exactly what gets exported.

import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  clipLength, clipRate, effectOf, isTextClip,
  type Media, type MediaClip, type Project, type TextClip,
} from './contract.js';
import { filterPath, sec } from './ffmpeg.js';

export interface ResolvedMedia {
  media: Media;
  /** Absolute path of the file to read (original or proxy). */
  file: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface GraphOptions {
  from: number;
  to: number;
  video?: boolean;
  audio?: boolean;
  /** Output canvas; defaults to project settings. */
  width?: number;
  height?: number;
  /** contain = letterbox, cover = fill and crop (e.g. 16:9 footage in a 9:16 Short). */
  fit?: 'contain' | 'cover';
  /** Target integrated loudness in LUFS, or null to leave levels alone. */
  loudness?: number | null;
  fontsDir?: string;
  /** Extra audio filters after the mix (e.g. silencedetect). */
  audioFilters?: string[];
  tmpDir: string;
  /** Resolves a clip's mediaId; return undefined if missing. */
  resolve: (mediaId: string) => ResolvedMedia | undefined;
  /** Resolves a path written in the project (e.g. a LUT) to an absolute path. */
  resolvePath: (p: string) => string;
}

export interface Graph {
  /** Input arguments followed by -filter_complex; add -map and output args after. */
  args: string[];
  video?: string;
  audio?: string;
  /** Temp files to delete after the run. */
  tmpFiles: string[];
  duration: number;
}

const EPS = 1e-4;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** atempo accepts 0.5..100 per instance; chain it for slower rates. */
function atempo(rate: number): string[] {
  const out: string[] = [];
  let r = rate;
  while (r < 0.5) {
    out.push('atempo=0.5');
    r /= 0.5;
  }
  if (Math.abs(r - 1) > 1e-6) out.push(`atempo=${r}`);
  return out;
}

interface Placed {
  clip: MediaClip;
  res: ResolvedMedia;
  /** Timeline start and render end (end includes any crossfade tail). */
  ts: number;
  te: number;
  /** Unextended end. */
  end: number;
  tail: number;
}

/** Lays out a track's clips, extending a clip into its source handle when the next clip crossfades from it. */
function placeTrack(clips: MediaClip[], resolve: GraphOptions['resolve']): Placed[] {
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const placed: Placed[] = [];
  sorted.forEach((clip, i) => {
    const res = resolve(clip.mediaId);
    if (!res) return;
    const end = clip.start + clipLength(clip);
    let tail = 0;
    const next = sorted[i + 1];
    if (next?.transitionIn?.type === 'crossfade' && Math.abs(next.start - end) < 0.05) {
      tail = next.transitionIn.duration;
      if (res.media.type !== 'image') tail = Math.max(0, Math.min(tail, (res.media.duration - clip.out) / clipRate(clip)));
    }
    placed.push({ clip, res, ts: clip.start, te: end + tail, end, tail });
  });
  return placed;
}

const assTime = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

/** #RRGGBB -> ASS &HBBGGRR& */
const assColour = (hex: string | undefined, fallback: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  const h = m ? m[1] : fallback;
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
};

const assText = (s: string) => s.replace(/\\/g, '\\​').replace(/[{}]/g, (c) => (c === '{' ? '(' : ')')).replace(/\r?\n/g, '\\N');

/** Builds an ASS subtitle script for text clips, in timeline time at output resolution. */
export function buildAss(clips: TextClip[], W: number, H: number, fontScale: number): string {
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Outline,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,5,20,20,20,1',
    'Style: Box,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,12,0,5,20,20,20,1',
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const c of clips) {
    const st = c.style ?? {};
    const x = Math.round((st.x ?? 0.5) * W);
    const yFrac = st.y ?? ({ top: 0.12, center: 0.5, bottom: 0.85 } as const)[st.position ?? 'bottom'];
    const y = Math.round(yFrac * H);
    const size = Math.round((st.fontSize ?? 64) * fontScale);
    const tags = [`\\an5`, `\\fs${size}`, `\\1c${assColour(st.color, 'FFFFFF')}`];
    if (st.font) tags.push(`\\fn${st.font.replace(/[\\{}]/g, '')}`);
    if (st.bold) tags.push('\\b1');
    if (st.box) tags.push(`\\3c${assColour(st.boxColor, '000000')}`);
    switch (c.animation) {
      case 'fade':
        tags.push(`\\pos(${x},${y})`, '\\fad(250,250)');
        break;
      case 'pop':
        tags.push(`\\pos(${x},${y})`, '\\fscx40\\fscy40\\t(0,180,\\fscx100\\fscy100)');
        break;
      case 'slide-up':
        tags.push(`\\move(${x},${y + Math.round(H * 0.05)},${x},${y},0,300)`, '\\fad(200,200)');
        break;
      default:
        tags.push(`\\pos(${x},${y})`);
    }
    lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.start + c.duration)},${st.box ? 'Box' : 'Outline'},,0,0,0,,{${tags.join('')}}${assText(c.text)}`);
  }
  return lines.join('\n') + '\n';
}

export async function buildGraph(project: Project, o: GraphOptions): Promise<Graph> {
  const { fps, sampleRate: sr } = project.settings;
  const W = even(o.width ?? project.settings.width);
  const H = even(o.height ?? project.settings.height);
  const D = Math.max(o.to - o.from, 1 / fps);
  const wantVideo = o.video ?? true;
  const wantAudio = o.audio ?? true;
  const fit = o.fit ?? 'contain';

  const inputs: string[] = [];
  let nInputs = 0;
  const addInput = (...args: string[]) => {
    inputs.push(...args);
    return nInputs++;
  };
  const filters: string[] = [];
  const tmpFiles: string[] = [];
  const audioLabels: string[] = [];

  let vCur = '';
  if (wantVideo) {
    const base = addInput('-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=${sec(D)}`);
    filters.push(`[${base}:v]format=yuv420p,setsar=1[base]`);
    vCur = '[base]';
  }
  let aBase = '';
  if (wantAudio) {
    const base = addInput('-t', sec(D), '-f', 'lavfi', '-i', `anullsrc=r=${sr}:cl=stereo`);
    filters.push(`[${base}:a]aformat=sample_fmts=fltp:channel_layouts=stereo[abase]`);
    aBase = '[abase]';
  }

  let k = 0;
  const addClip = (p: Placed, kind: 'video' | 'audio', trackMuted: boolean) => {
    const { clip, res } = p;
    const a = Math.max(p.ts, o.from);
    const b = Math.min(p.te, o.to);
    if (b - a <= EPS) return;
    const useVideo = wantVideo && kind === 'video' && res.hasVideo;
    const useAudio = wantAudio && !trackMuted && !clip.muted && res.hasAudio && res.media.type !== 'image';
    if (!useVideo && !useAudio) return;

    const rate = clipRate(clip);
    const L = a - p.ts; // clip-local time at window start
    const len = b - a;
    const isImage = res.media.type === 'image';
    const idx = isImage
      ? addInput('-loop', '1', '-framerate', String(fps), '-t', sec(len + 2 / fps), '-i', res.file)
      : addInput('-ss', sec(clip.in + L * rate), '-t', sec((len + 2 / fps) * rate), '-i', res.file);
    const id = k++;
    const fade = effectOf(clip, 'fade');
    const fadeIn = Math.max(clip.transitionIn?.duration ?? 0, fade?.in ?? 0);
    const fadeOut = fade?.out ?? 0;
    const clipLen = p.end - p.ts;

    if (useVideo) {
      const vf: string[] = ['setpts=PTS-STARTPTS'];
      if (rate !== 1) vf.push(`setpts=PTS/${rate}`);
      vf.push(`fps=${fps}`);
      const crop = effectOf(clip, 'crop');
      if (crop) {
        const [l, r, t, bt] = [crop.left ?? 0, crop.right ?? 0, crop.top ?? 0, crop.bottom ?? 0];
        vf.push(`crop=iw*${1 - l - r}:ih*${1 - t - bt}:iw*${l}:ih*${t}`);
      }
      const tr = effectOf(clip, 'transform');
      const s = tr?.scale ?? 1;
      const tw = even(W * s);
      const th = even(H * s);
      // Placed clips (picture-in-picture) keep their whole frame; only full-frame clips fill and crop.
      if (fit === 'cover' && !tr) vf.push(`scale=${tw}:${th}:force_original_aspect_ratio=increase`, `crop=min(iw\\,${tw}):min(ih\\,${th})`);
      else vf.push(`scale=${tw}:${th}:force_original_aspect_ratio=decrease:force_divisible_by=2`);
      vf.push('setsar=1');
      const col = effectOf(clip, 'colour');
      if (col) {
        if (col.exposure) vf.push(`exposure=exposure=${col.exposure}`);
        if ((col.contrast ?? 1) !== 1 || (col.saturation ?? 1) !== 1) vf.push(`eq=contrast=${col.contrast ?? 1}:saturation=${col.saturation ?? 1}`);
        if (col.temperature && col.temperature !== 6500) vf.push(`colortemperature=temperature=${col.temperature}`);
        if (col.lut) vf.push(`lut3d=file=${filterPath(o.resolvePath(col.lut))}`);
      }
      vf.push('format=yuva420p');
      if (tr?.opacity !== undefined && tr.opacity < 1) vf.push(`colorchannelmixer=aa=${Math.max(0, tr.opacity)}`);
      if (fadeIn || fadeOut) {
        vf.push(`setpts=PTS-STARTPTS+${sec(L)}/TB`);
        if (fadeIn) vf.push(`fade=t=in:st=0:d=${sec(fadeIn)}:alpha=1`);
        if (fadeOut) vf.push(`fade=t=out:st=${sec(Math.max(0, clipLen - fadeOut))}:d=${sec(fadeOut)}:alpha=1`);
      }
      vf.push(`setpts=PTS-STARTPTS+${sec(a - o.from)}/TB`);
      filters.push(`[${idx}:v]${vf.join(',')}[v${id}]`);
      const x = `(W-w)/2+${(tr?.x ?? 0) * W}`;
      const y = `(H-h)/2+${(tr?.y ?? 0) * H}`;
      const t0 = a - o.from - EPS;
      const t1 = b - o.from - EPS;
      filters.push(`${vCur}[v${id}]overlay=x='${x}':y='${y}':eof_action=pass:format=auto:enable='gte(t,${sec(t0)})*lt(t,${sec(t1)})'[o${id}]`);
      vCur = `[o${id}]`;
    }

    if (useAudio) {
      const af: string[] = [`aresample=${sr}`, 'aformat=sample_fmts=fltp:channel_layouts=stereo', 'asetpts=PTS-STARTPTS', ...atempo(rate), `atrim=duration=${sec(len)}`];
      const gain = effectOf(clip, 'volume')?.gain;
      if (gain !== undefined && gain !== 1) af.push(`volume=${Math.max(0, gain)}`);
      const aIn = fadeIn;
      const aOut = p.tail > 0 ? p.tail : fadeOut;
      const aOutStart = p.tail > 0 ? clipLen : clipLen - fadeOut;
      if (aIn || aOut) {
        af.push(`asetpts=PTS-STARTPTS+${sec(L)}/TB`);
        if (aIn) af.push(`afade=t=in:st=0:d=${sec(aIn)}`);
        if (aOut) af.push(`afade=t=out:st=${sec(Math.max(0, aOutStart))}:d=${sec(aOut)}`);
        af.push('asetpts=PTS-STARTPTS');
      }
      const delayMs = Math.round((a - o.from) * 1000);
      if (delayMs > 0) af.push(`adelay=delays=${delayMs}:all=1`);
      filters.push(`[${idx}:a]${af.join(',')}[a${id}]`);
      audioLabels.push(`[a${id}]`);
    }
  };

  // Video tracks later in the array draw on top. Audio from every track is mixed.
  for (const track of project.tracks) {
    if (track.kind === 'text') continue;
    const media = track.clips.filter((c): c is MediaClip => !isTextClip(c));
    const hidden = track.kind === 'video' && track.hidden;
    for (const p of placeTrack(media, o.resolve)) {
      if (hidden) {
        if (wantAudio) addClip(p, 'audio', !!track.muted);
      } else addClip(p, track.kind as 'video' | 'audio', !!track.muted);
    }
  }

  let video: string | undefined;
  if (wantVideo) {
    const texts = project.tracks
      .filter((t) => t.kind === 'text' && !t.hidden)
      .flatMap((t) => t.clips.filter(isTextClip))
      .filter((c) => c.start < o.to && c.start + c.duration > o.from);
    if (texts.length) {
      const fontScale = Math.sqrt((W * H) / (project.settings.width * project.settings.height));
      const assFile = path.join(o.tmpDir, `text-${randomUUID()}.ass`);
      await writeFile(assFile, buildAss(texts, W, H, fontScale));
      tmpFiles.push(assFile);
      const fonts = o.fontsDir ? `:fontsdir=${filterPath(o.fontsDir)}` : '';
      // ASS times are timeline times, so shift into timeline time and back.
      filters.push(`${vCur}setpts=PTS+${sec(o.from)}/TB,ass=${filterPath(assFile)}${fonts},setpts=PTS-STARTPTS[txt]`);
      vCur = '[txt]';
    }
    filters.push(`${vCur}format=yuv420p[vout]`);
    video = '[vout]';
  }

  let audio: string | undefined;
  if (wantAudio) {
    const all = [aBase, ...audioLabels];
    const extra = [...(o.loudness != null ? [`loudnorm=I=${o.loudness}:TP=-1.5:LRA=11`, `aresample=${sr}`] : []), ...(o.audioFilters ?? [])];
    const post = extra.map((f) => `,${f}`).join('');
    filters.push(`${all.join('')}amix=inputs=${all.length}:normalize=0:duration=first:dropout_transition=0,atrim=duration=${sec(D)}${post}[aout]`);
    audio = '[aout]';
  }

  return { args: [...inputs, '-filter_complex', filters.join(';')], video, audio, tmpFiles, duration: D };
}

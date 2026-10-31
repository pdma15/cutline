// The shared contract between the Engine and the Editor App.
// Mirrors project-format.md. Do not change one without the other.

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
}

export type MediaType = 'video' | 'audio' | 'image';

export interface Media {
  id: string;
  /** Relative to the project file's folder, or absolute. */
  path: string;
  proxyPath: string | null;
  duration: number;
  type: MediaType;
}

export interface ColourEffect {
  type: 'colour';
  /** Stops, -3..3. 0 = unchanged. */
  exposure?: number;
  /** Multiplier, 1 = unchanged. */
  contrast?: number;
  /** Multiplier, 1 = unchanged, 0 = greyscale. */
  saturation?: number;
  /** White balance in Kelvin, 6500 = unchanged. */
  temperature?: number;
  /** Path to a .cube LUT. */
  lut?: string;
}

/** Fractions of the source frame to cut off each side, 0..1. */
export interface CropEffect {
  type: 'crop';
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

/** Placement on the canvas. Used for picture-in-picture. */
export interface TransformEffect {
  type: 'transform';
  /** Offset from centre as a fraction of canvas width/height. */
  x?: number;
  y?: number;
  /** 1 = fit the canvas. */
  scale?: number;
  /** 0..1 */
  opacity?: number;
}

export interface VolumeEffect {
  type: 'volume';
  /** Linear multiplier, 1 = unchanged. */
  gain: number;
}

/** Fade in/out in seconds. Video fades alpha, audio fades volume. */
export interface FadeEffect {
  type: 'fade';
  in?: number;
  out?: number;
}

export interface SpeedEffect {
  type: 'speed';
  /** 2 = twice as fast. */
  rate: number;
}

export type Effect = ColourEffect | CropEffect | TransformEffect | VolumeEffect | FadeEffect | SpeedEffect;

export interface Transition {
  /** crossfade blends from the previous clip on the same track; fade comes up from what is underneath. */
  type: 'crossfade' | 'fade';
  duration: number;
}

export interface MediaClip {
  id: string;
  mediaId: string;
  /** Where the clip sits on the timeline, seconds. */
  start: number;
  /** Which part of the source file is used, seconds. */
  in: number;
  out: number;
  effects?: Effect[];
  transitionIn?: Transition;
  muted?: boolean;
}

export interface TextStyle {
  font?: string;
  /** Pixels at project resolution. */
  fontSize?: number;
  /** #RRGGBB */
  color?: string;
  bold?: boolean;
  /** Preset position, or use x/y. */
  position?: 'top' | 'center' | 'bottom';
  /** Centre of the text as a fraction of the canvas, 0..1. */
  x?: number;
  y?: number;
  /** Draw a solid box behind the text. */
  box?: boolean;
  boxColor?: string;
}

export interface TextClip {
  id: string;
  start: number;
  duration: number;
  text: string;
  style?: TextStyle;
  animation?: 'none' | 'fade' | 'pop' | 'slide-up';
}

export type Clip = MediaClip | TextClip;

export interface Track {
  id: string;
  kind: 'video' | 'audio' | 'text';
  clips: Clip[];
  muted?: boolean;
  hidden?: boolean;
}

export interface Marker {
  id: string;
  time: number;
  label?: string;
  color?: string;
}

export interface Comment {
  id: string;
  time: number;
  author: string;
  text: string;
  resolved: boolean;
}

export interface Project {
  version: 1;
  settings: ProjectSettings;
  media: Media[];
  tracks: Track[];
  markers: Marker[];
  comments: Comment[];
}

export const isTextClip = (c: Clip): c is TextClip => 'text' in c;

export function effectOf<T extends Effect['type']>(clip: MediaClip, type: T): Extract<Effect, { type: T }> | undefined {
  return clip.effects?.find((e) => e.type === type) as Extract<Effect, { type: T }> | undefined;
}

export function clipRate(clip: MediaClip): number {
  return effectOf(clip, 'speed')?.rate ?? 1;
}

/** Length of a clip on the timeline, seconds. */
export function clipLength(clip: Clip): number {
  return isTextClip(clip) ? clip.duration : (clip.out - clip.in) / clipRate(clip);
}

export function projectDuration(p: Project): number {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, c.start + clipLength(c));
  return end;
}

/** Returns a list of problems; empty means the project is valid. */
export function validateProject(p: unknown): string[] {
  const errs: string[] = [];
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(p)) return ['project must be an object'];
  if (p.version !== 1) errs.push(`version must be 1, got ${JSON.stringify(p.version)}`);
  const s = p.settings;
  if (!isObj(s)) errs.push('settings missing');
  else for (const k of ['width', 'height', 'fps', 'sampleRate']) if (!isNum(s[k]) || s[k] <= 0) errs.push(`settings.${k} must be a positive number`);
  const missing = ['media', 'tracks', 'markers', 'comments'].filter((k) => !Array.isArray(p[k]));
  if (missing.length) return [...errs, ...missing.map((k) => `${k} must be an array`)];

  const mediaIds = new Set<string>();
  p.media.forEach((m: any, i: number) => {
    const at = `media[${i}]`;
    if (!isObj(m) || typeof m.id !== 'string') return void errs.push(`${at}.id must be a string`);
    if (mediaIds.has(m.id)) errs.push(`${at}: duplicate id ${m.id}`);
    mediaIds.add(m.id);
    if (typeof m.path !== 'string' || !m.path) errs.push(`${at}.path must be a string`);
    if (!['video', 'audio', 'image'].includes(m.type)) errs.push(`${at}.type must be video, audio or image`);
    if (!isNum(m.duration) || m.duration < 0) errs.push(`${at}.duration must be a number >= 0`);
    if (m.proxyPath !== null && m.proxyPath !== undefined && typeof m.proxyPath !== 'string') errs.push(`${at}.proxyPath must be a string or null`);
  });

  const clipIds = new Set<string>();
  p.tracks.forEach((t: any, ti: number) => {
    const at = `tracks[${ti}]`;
    if (!isObj(t)) return void errs.push(`${at} must be an object`);
    if (!['video', 'audio', 'text'].includes(t.kind)) errs.push(`${at}.kind must be video, audio or text`);
    if (!Array.isArray(t.clips)) return void errs.push(`${at}.clips must be an array`);
    t.clips.forEach((c: any, ci: number) => {
      const cat = `${at}.clips[${ci}]`;
      if (!isObj(c) || typeof c.id !== 'string') return void errs.push(`${cat}.id must be a string`);
      if (clipIds.has(c.id)) errs.push(`${cat}: duplicate clip id ${c.id}`);
      clipIds.add(c.id);
      if (!isNum(c.start) || c.start < 0) errs.push(`${cat}.start must be a number >= 0`);
      if (t.kind === 'text') {
        if (typeof c.text !== 'string') errs.push(`${cat}.text must be a string`);
        if (!isNum(c.duration) || c.duration <= 0) errs.push(`${cat}.duration must be > 0`);
        return;
      }
      if (!mediaIds.has(c.mediaId)) errs.push(`${cat}.mediaId ${JSON.stringify(c.mediaId)} is not in media`);
      if (!isNum(c.in) || !isNum(c.out) || c.in < 0 || c.out <= c.in) errs.push(`${cat}: need 0 <= in < out`);
      const speed = Array.isArray(c.effects) ? c.effects.find((e: any) => e?.type === 'speed') : undefined;
      if (speed && (!isNum(speed.rate) || speed.rate <= 0)) errs.push(`${cat}: speed.rate must be > 0`);
      if (c.transitionIn && !(['crossfade', 'fade'].includes(c.transitionIn.type) && isNum(c.transitionIn.duration) && c.transitionIn.duration > 0))
        errs.push(`${cat}.transitionIn needs type crossfade|fade and duration > 0`);
    });
  });
  p.comments.forEach((c: any, i: number) => {
    if (!isObj(c) || !isNum(c.time) || typeof c.text !== 'string') errs.push(`comments[${i}] needs time and text`);
  });
  return errs;
}

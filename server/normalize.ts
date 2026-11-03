// Translates the App's project JSON into the engine's contract. This is the one place where the
// two halves' small format differences meet; neither side has to change its own format.
//
// App                                   Engine
// clip.volume (0..1)                    { type: 'volume', gain } effect
// text clip { in: 0, out: d, text }     { duration: d, text }
// clip.text on a video clip (a title)   a separate text clip over the same time range
// transitionIn: null                    no transitionIn
// media.path = original file name       media.path = the copy in the workspace (by media id)

import type { Clip, Media, MediaClip, Project, TextClip, Track } from '../engine/src/index.js';

/** Default look for App titles: bottom-centre, bold, like the App's own preview overlay. */
const TITLE_STYLE = { position: 'bottom', fontSize: 64, bold: true } as const;

export interface NormalizeResult {
  project: Project;
  /** Media the engine has no file for (e.g. not uploaded yet); their clips are left out. */
  missing: string[];
}

export function toEngineProject(app: any, fileFor: (m: any) => string | null): NormalizeResult {
  const missing: string[] = [];
  const media: Media[] = [];
  for (const m of app.media ?? []) {
    const file = fileFor(m);
    if (!file) {
      missing.push(m.id);
      continue;
    }
    media.push({ id: m.id, path: file, proxyPath: null, duration: m.type === 'image' ? 0 : Number(m.duration) || 0, type: m.type });
  }
  const have = new Set(media.map((m) => m.id));

  const titles: TextClip[] = [];
  const tracks: Track[] = (app.tracks ?? []).map((t: any): Track => {
    const clips: Clip[] = [];
    for (const c of t.clips ?? []) {
      const len = Number(c.out) - Number(c.in);
      if (t.kind === 'text') {
        if (typeof c.text === 'string' && c.text.trim() && len > 0) {
          clips.push({ id: c.id, start: c.start, duration: len, text: c.text, style: c.style ?? TITLE_STYLE, animation: c.animation ?? 'fade' });
        }
        continue;
      }
      if (!have.has(c.mediaId)) continue;
      const effects = (c.effects ?? []).filter((e: any) => e && e.type !== 'volume');
      if (typeof c.volume === 'number' && c.volume !== 1) effects.push({ type: 'volume', gain: c.volume });
      const clip: MediaClip = { id: c.id, mediaId: c.mediaId, start: c.start, in: c.in, out: c.out, effects };
      if (c.transitionIn) clip.transitionIn = c.transitionIn;
      if (c.muted) clip.muted = true;
      clips.push(clip);
      // The App lets any clip carry a title; the engine draws text from text tracks only.
      if (typeof c.text === 'string' && c.text.trim()) {
        titles.push({ id: `${c.id}-title`, start: c.start, duration: len, text: c.text, style: TITLE_STYLE, animation: 'fade' });
      }
    }
    return { id: t.id, kind: t.kind, clips, ...(t.muted ? { muted: true } : {}), ...(t.hidden ? { hidden: true } : {}) };
  });
  if (titles.length) tracks.push({ id: 'app-clip-titles', kind: 'text', clips: titles });

  return {
    project: {
      version: 1,
      settings: app.settings,
      media,
      tracks,
      markers: app.markers ?? [],
      comments: (app.comments ?? []).map((k: any) => ({ id: k.id, time: k.time, author: k.author ?? '', text: k.text ?? '', resolved: !!k.resolved })),
    },
    missing,
  };
}

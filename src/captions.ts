// Captions: build them from transcripts, translate them, and write SRT/VTT.

import type { Transcript } from './ai.js';
import { clipRate, isTextClip, type MediaClip, type Project, type TextClip } from './contract.js';

export interface CaptionOptions {
  /** Longest caption line, characters. Default 42 (broadcast convention). */
  maxChars?: number;
  /** Longest a caption stays up, seconds. Default 4. */
  maxDuration?: number;
  /** A pause this long starts a new caption, seconds. Default 0.7. */
  pauseGap?: number;
  idPrefix?: string;
}

/**
 * Turns the words spoken in each timeline clip into caption text clips at timeline times.
 * Muted clips are skipped, so a multicam edit (muted video + one audio bed) isn't captioned twice.
 */
export function captionsFromTranscripts(project: Project, transcripts: Map<string, Transcript>, o: CaptionOptions = {}): TextClip[] {
  const maxChars = o.maxChars ?? 42;
  const maxDuration = o.maxDuration ?? 4;
  const pauseGap = o.pauseGap ?? 0.7;
  const words: Array<{ text: string; start: number; end: number }> = [];
  for (const track of project.tracks) {
    if (track.kind === 'text' || track.muted) continue;
    for (const c of track.clips) {
      if (isTextClip(c) || (c as MediaClip).muted) continue;
      const tr = transcripts.get(c.mediaId);
      if (!tr) continue;
      const rate = clipRate(c);
      for (const w of tr.words) {
        if (w.start < c.in || w.end > c.out) continue;
        words.push({ text: w.text, start: c.start + (w.start - c.in) / rate, end: c.start + (w.end - c.in) / rate });
      }
    }
  }
  words.sort((a, b) => a.start - b.start);

  const out: TextClip[] = [];
  let line: typeof words = [];
  const flush = () => {
    if (!line.length) return;
    const start = line[0].start;
    const end = Math.max(line[line.length - 1].end, start + 0.8);
    out.push({
      id: `${o.idPrefix ?? 'cap'}-${out.length + 1}`,
      start: Math.round(start * 1000) / 1000,
      duration: Math.round((end - start) * 1000) / 1000,
      text: line.map((w) => w.text).join(' '),
      style: { position: 'bottom', fontSize: 48 },
      animation: 'none',
    });
    line = [];
  };
  for (const w of words) {
    if (line.length) {
      const last = line[line.length - 1];
      const chars = line.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
      if (chars > maxChars || w.end - line[0].start > maxDuration || w.start - last.end > pauseGap || /[.!?]$/.test(last.text)) flush();
    }
    line.push(w);
  }
  flush();
  // Never overlap the next caption.
  for (let i = 0; i + 1 < out.length; i++) {
    const gapEnd = out[i + 1].start;
    if (out[i].start + out[i].duration > gapEnd) out[i].duration = Math.max(0.1, Math.round((gapEnd - out[i].start) * 1000) / 1000);
  }
  return out;
}

const stamp = (t: number, sep: ',' | '.') => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
};

/** SRT or WebVTT for a text track (default: the first visible text track). */
export function subtitles(project: Project, o: { trackId?: string; format?: 'srt' | 'vtt' } = {}): string {
  const track = project.tracks.find((t) => t.kind === 'text' && (o.trackId ? t.id === o.trackId : !t.hidden));
  const clips = (track?.clips.filter(isTextClip) ?? []).sort((a, b) => a.start - b.start);
  if ((o.format ?? 'srt') === 'vtt') {
    return ['WEBVTT', '', ...clips.flatMap((c) => [`${stamp(c.start, '.')} --> ${stamp(c.start + c.duration, '.')}`, c.text, ''])].join('\n');
  }
  return clips.flatMap((c, i) => [String(i + 1), `${stamp(c.start, ',')} --> ${stamp(c.start + c.duration, ',')}`, c.text, '']).join('\n');
}

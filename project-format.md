# Project format (shared contract)

Copy this file into both repos. Neither side changes it without telling the other. Contract changes are agreed first, then made in both repos the same day.

TypeScript types for everything below are in `src/contract.ts`. `validateProject()` checks a project against them.

## Project JSON

```json
{
  "version": 1,
  "settings": { "width": 1920, "height": 1080, "fps": 30, "sampleRate": 48000 },
  "media": [
    { "id": "m1", "path": "footage/cam_a.mp4", "proxyPath": null, "duration": 742.5, "type": "video" }
  ],
  "tracks": [
    { "id": "v1", "kind": "video", "clips": [
      { "id": "c1", "mediaId": "m1", "start": 0, "in": 12.0, "out": 18.5,
        "effects": [ { "type": "colour", "exposure": 0.2 } ],
        "transitionIn": { "type": "crossfade", "duration": 0.5 } }
    ]},
    { "id": "a1", "kind": "audio", "clips": [] },
    { "id": "t1", "kind": "text", "clips": [] }
  ],
  "markers": [],
  "comments": [ { "id": "k1", "time": 4.2, "author": "producer", "text": "Hook too slow", "resolved": false } ]
}
```

### Rules

- All times are in seconds. `start` is where a clip sits on the timeline; `in` and `out` are which part of the source file is used.
- A media clip's timeline length is `(out - in) / speed`.
- `media.path` is relative to the project file's folder, or absolute. `type` is `video`, `audio` or `image`. Images have `duration: 0` and are used for as long as `out - in`.
- **Stacking:** video tracks later in the `tracks` array draw on top of earlier ones. Text tracks draw above all video.
- **Audio:** audio from video-track clips and audio-track clips is mixed together. `muted: true` on a clip or track silences it. `hidden: true` on a video track hides its picture but keeps its audio.
- IDs must be unique: media IDs among media, clip IDs across all tracks.

## Additions in v1 (Engine proposal, needs App sign-off)

The doc's starting shape left these open. The Engine implements them as written. Change them together if the App needs something different.

### Clip fields

| Field | Type | Meaning |
|---|---|---|
| `muted` | boolean | Silence this clip's audio |
| `transitionIn.type` | `"crossfade"` \| `"fade"` | `crossfade` blends from the previous clip on the same track, using that clip's spare source footage after `out` (its "handle"). `fade` comes up from whatever is underneath. |

### Effects (`clip.effects[]`)

| type | fields | notes |
|---|---|---|
| `colour` | `exposure` (stops, 0 = none), `contrast` (1 = none), `saturation` (1 = none, 0 = grey), `temperature` (Kelvin, 6500 = none), `lut` (path to .cube) | |
| `crop` | `left`, `right`, `top`, `bottom` | Fractions of the source frame, 0..1 |
| `transform` | `x`, `y` (offset from centre, fraction of canvas), `scale` (1 = fit canvas), `opacity` (0..1) | Use for picture-in-picture |
| `volume` | `gain` | Linear multiplier, 1 = unchanged |
| `fade` | `in`, `out` | Seconds. Fades picture alpha and audio volume |
| `speed` | `rate` | 2 = twice as fast. Changes the clip's timeline length |
| `reframe` | `keyframes: [{t, x, y}]` | Fill the canvas and pan the crop window to follow a subject. `t` is source seconds; `x`/`y` are the window centre as a fraction of the source frame (0..1), linear between keyframes. Written by `autoReframe`; the App can let editors drag keyframes |

### Text clips (on `kind: "text"` tracks)

```json
{ "id": "c6", "start": 0.5, "duration": 3, "text": "My Science Project",
  "animation": "pop",
  "style": { "fontSize": 72, "bold": true, "color": "#FFFFFF", "position": "center", "box": false } }
```

- `animation`: `none` | `fade` | `pop` | `slide-up`
- `style.position`: `top` | `center` | `bottom` (default `bottom`). Or set `x`/`y` (0..1, the text's centre).
- `style.fontSize` is in pixels at project resolution. Exports at other sizes scale it.
- `style.box` draws a solid box behind the text in `boxColor`.
- Use `\n` in `text` for a line break.

### Track fields

`muted` (all clips silent) and `hidden` (picture off, audio on) on any track.

## Engine functions the App calls

Create one `Engine` per open project and call `openProject(project, projectFolder)` first. The calls that take a `mediaId` look it up there.

| Function | Returns |
|---|---|
| `probeMedia(path)` | `{ type, duration, container, video: {codec,width,height,fps,rotation}, audio: {codec,channels,sampleRate} }` |
| `importMedia(path, id?)` | A ready `media` entry to add to the project (probes and registers it) |
| `getThumbnails(mediaId, count)` | Array of JPEG file paths, evenly spaced |
| `getWaveform(mediaId)` | `{ peaksPerSecond, duration, min[], max[] }`, values -1..1 |
| `makeProxy(mediaId, onProgress?)` | Path to a 540p copy. Also sets `proxyPath` on the registered media. **The App should write it into the project JSON.** |
| `getFrameAt(project, time, {width?, format?})` | `{ width, height, format, data }`. `data` is a PNG buffer, or raw RGBA when `format: "rgba"` |
| `getAudio(project, from, to)` | `{ sampleRate, channels: 2, data: Float32Array }`, interleaved stereo, ready for Web Audio |
| `transcribe(mediaId)` | `{ mediaId, language, words: [{text,start,end,speaker}] }`. Times are source-file seconds |
| `searchFootage(query, {limit?, semantic?})` | `[{ mediaId, time, end, text, score, source }]`. `source` is `transcript` or `visual`. Times are source-file seconds. `semantic: true` has Claude rank the matches |
| `analyse(project)` | `{ duration, silences[], fillers[], cuts[], pacing: { hookScore, hook, slowSections[] } }`. Times are timeline seconds |
| `syncMulticam(mediaIds, {reference?, maxOffset?})` | `{ reference, start, end, angles: [{ mediaId, offset, clockRate, duration, confidence, driftPerHour }] }`. **Proposed addition.** See Multicam below |
| `autoSwitch(sync, {wide?, audioFrom?, minShot?, speechDb?, crosstalkDb?, anticipate?, speakers?, timelineStart?})` | `{ segments: [{start,end,mediaId,reason}], clips: { video: MediaClip[], audio: MediaClip[] } }`. **Proposed addition** |
| `autoReframe(project, {width?, height?})` | A copy of the project at the new size (default 1080x1920) with a `reframe` effect on every full-frame video clip. **Proposed addition** |
| `trackSubject(mediaId)` | `{ fps, t[], x[], y[], cuts[] }`, the smoothed subject path. **Proposed addition** |
| `indexFootage(mediaId, {interval?, batch?, onProgress?})` | `[{ time, text }]` frame descriptions (one every `interval` s, default 5) for visual search. Needs a describer (Claude). **Proposed addition** |
| `autoCaptions(project, {maxChars?, maxDuration?, pauseGap?})` | `TextClip[]` at timeline times from transcripts. **Proposed addition** |
| `translateCaptions(project, language, {trackId?})` | Project copy with a translated text track shown and the original hidden. Needs a translator (Claude). **Proposed addition** |
| `subtitles(project, {trackId?, format?})` | SRT (default) or WebVTT text. **Proposed addition** |
| `labelSpeakers(mediaId, sync, {speakers?, wide?, names?})` | The transcript with `speaker` filled in from per-person mics. **Proposed addition** |
| `exportProject(project, preset, onProgress, {output?, signal?})` | Path to the finished MP4. `preset` is `youtube` \| `shorts` \| `4k` \| `school`, or a custom preset object |

### Multicam

- `referenceTime = offset + sourceTime × clockRate`. The reference angle (first in the list, or `reference`) has offset 0 and clockRate 1.
- `confidence` is 0..1. Below about 0.3, show a warning and let the editor nudge the sync by hand.
- `driftPerHour` and `clockRate` are measured when angles overlap by more than 2 minutes (otherwise drift is `null` and clockRate is 1). Camera clocks typically drift 0.1 to 0.5 s per hour.
- Drift is corrected in the clips `autoSwitch` returns: clips from a drifting angle carry a `speed` effect of `1 / clockRate` (e.g. 0.9999), so they stay in sync from start to end with no change to their timeline length. The App should keep that effect when the editor trims or moves those clips.
- `autoSwitch` returns clips ready to drop onto the timeline: muted video clips that cut between angles, and one audio clip from `audioFrom` underneath. The App inserts them and owns the result from then on.
- `segments[].reason` is `speaker` (that person's mic was loudest), `wide` (silence or crosstalk), or `hold` (no clear choice, kept the previous angle).

Errors are thrown as `EngineError` with a `code`: `NOT_FOUND`, `UNSUPPORTED`, `INVALID_PROJECT`, `UNKNOWN_MEDIA`, `UNKNOWN_PRESET`, `EMPTY_PROJECT`, `SYNC_FAILED`, `AI_NOT_CONFIGURED`, `AI_REFUSED`, `AI_FAILED`, `ABORTED`, `FFMPEG_FAILED`, `RENDER_FAILED`.

The App's `fakeEngine` should implement exactly these signatures.

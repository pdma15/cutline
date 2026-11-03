# Project format (shared contract)

The one contract between the Engine (`engine/`) and the Editor App (`app/`). Neither side changes it without telling the other. Contract changes are agreed first, then made on both sides in the same pull request.

TypeScript types for the engine side are in `engine/src/contract.ts`; `validateProject()` checks a project against them. The App writes a few things differently (see **Editor App format** at the end); `server/normalize.ts` translates them, so both formats stay valid.

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

## Editor App format (Project 2)

The App saves version 1 projects in the shape above with these differences. `server/normalize.ts` converts them before anything reaches the engine; a test (`server/server.test.ts`) keeps the two in step.

| App writes | Engine reads | Notes |
|---|---|---|
| `clip.volume` (0..1) | `{ type: "volume", gain }` effect | |
| Text clips `{ in: 0, out: d, text }` | `{ duration: d, text }` | Titles get the App's look: bottom-centre, bold, fade |
| `clip.text` on a video clip | a separate text clip over the same range | The engine treats any clip with `text` as a text clip, so this must never reach it unconverted |
| `transitionIn: null` | no `transitionIn` | |
| `media.path` = the original file name | the workspace copy, found by media id | See "Media files" below |
| `media.duration` for images = 6 | 0 | Images use `out - in` either way |

App-only fields the engine ignores: project `name`, `approved`; clip `name`; media `favorite`, `demo`, `size`, `modified`.

App rules the engine doesn't enforce:

- IDs are letters, digits, `_` and `-` only.
- No overlapping clips within one track.
- Limits: 24-hour timeline, 30 tracks, 1,000 media items, 2,000 clips per track, 1,000 comments/markers, 5 MB project JSON.
- Ripple delete and transcript cuts move later clips on the affected video track only.

Clips the engine creates (multicam, reframe) have no `effects` array when empty and may carry effects the App doesn't edit yet (`reframe`, `speed`, `transform`). **To do before the App opens them:** the App's `validateProject` requires `effects` on every clip.

### Media files

The App keeps original files in the browser and stores only names. When served by the Cutline server, each import is also sent to `PUT /api/media/<mediaId>?name=<file name>`; the server keeps a copy at `workspace/media/<mediaId>.<ext>` and returns the engine's probe (`type`, `duration`, `video`, `audio`). Nothing leaves the computer: the server listens on 127.0.0.1 only.

The App's demo media (`demo: true`, ids `m1`–`m4`) map to generated stand-in files, so the demo project renders and exports.

### Server API (what `app/real-engine.js` calls)

| Request | Returns |
|---|---|
| `GET /api/health` | `{ engine: true, presets, ai: { transcribe, claude } }` |
| `PUT /api/media/:id?name=` (file body) | probe result |
| `POST /api/frame` `{ project, time, width }` | PNG; header `X-Missing-Media` lists media with no file |
| `POST /api/audio` `{ project, from, to }` | float32 stereo; header `X-Sample-Rate` |
| `POST /api/call` `{ fn, args }` | `getThumbnails` (data URLs), `getWaveform`, `makeProxy`, `transcribe` (App word list), `searchFootage` (`{mediaId, time, end, label, source, score}`), `analyse` (`{hookScore, flags: [{time, end, label}], analysis}`) |
| `POST /api/export` `{ project, preset }` | `{ job }`; 409 naming any files that need reimporting |
| `GET /api/export/:job` | `{ progress (0–100), done, error, url, name }` |
| `GET /api/export/:job/file` | the MP4 |
| `POST /api/export/:job/cancel` | stops the render |

Errors are `{ error, code }` with the engine's `EngineError` codes and matching HTTP status (e.g. `AI_NOT_CONFIGURED` → 501).

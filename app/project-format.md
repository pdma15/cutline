# Project format / engine handoff

Version 1 follows the PDF's starting shape. All times are seconds.

```json
{
  "version": 1,
  "name": "My project",
  "settings": { "width": 1920, "height": 1080, "fps": 30, "sampleRate": 48000 },
  "media": [
    { "id": "m1", "path": "clip.mp4", "proxyPath": null, "duration": 8, "type": "video" }
  ],
  "tracks": [
    { "id": "v1", "kind": "video", "clips": [
      { "id": "c1", "mediaId": "m1", "start": 0, "in": 1, "out": 6,
        "effects": [ { "type": "colour", "exposure": 0, "saturation": 1 } ],
        "volume": 1, "transitionIn": null }
    ] },
    { "id": "a1", "kind": "audio", "clips": [] },
    { "id": "t1", "kind": "text", "clips": [] }
  ],
  "markers": [],
  "comments": []
}
```

- `start`: timeline position; `in`/`out`: source range, end exclusive.
- Source duration of this example clip is 8s; displayed duration is 5s.
- Clip/track/media IDs are unique letters, digits, underscores and hyphens.
- Text clips have `text` instead of `mediaId`; use in=0 and out=duration.
- Optional frontend extensions: project `name`, `approved`; clip `name`, `text`,
  `volume` (0–1); media `favorite`, `demo`, `size`, `modified`.
- A media `path` is a local filename here, not a remotely accessible path. A real
  engine needs an agreed asset upload/relink protocol. Blob URLs are never saved.
- Transition shape: `{ "type": "crossfade", "duration": 0.5 }` or fade; it is metadata only.
- Markers: `{ "id": "mark1", "time": 4 }`.
- Comments: `{ "id": "k1", "time": 4.2, "author": "Editor", "text": "Tighten this", "resolved": false }`.
- Ripple delete and transcript cuts move later clips on the affected video track
  only; audio, other tracks and absolute-time comments/markers stay in place.
- No within-track overlap. Additional tracks are allowed, but local preview shows
  one active video layer rather than compositing all layers.
- Current frontend limits: 24-hour timeline, 30 tracks, 1,000 media items,
  2,000 clips per track, 1,000 comments/markers, 5 MB project JSON.

## Adapter surface

The mock exposes these async methods on `window.engine`, matching the PDF names:

- `probeMedia(path)` → metadata
- `getThumbnails(mediaId, count)` → thumbnails
- `getWaveform(mediaId)` → peaks
- `makeProxy(mediaId)` → proxy reference
- `getFrameAt(project, time)` → composited frame
- `getAudio(project, from, to)` → audio samples
- `transcribe(mediaId)` → `{text, start, end, speaker, mediaId}[]`
- `searchFootage(query)` → `{mediaId, time, label}[]`
- `analyse(project)` → `{hookScore, flags: [{time, label}]} `
- `exportProject(project, preset, onProgress)` → rendered file reference in a real adapter

Mock exports instead return `{demo: true, message, preset, project}`. Preset IDs:
`school`, `youtube`, `shorts`, `4k`. Progress is 0–100. Agree production return
formats and cancellation/error handling with the engine developer before integration.
The PDF does not fully define those formats. Keep version/contract changes aligned
between both projects.

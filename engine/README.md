# @pro-video/engine

The headless engine for the Pro Video Editor: video processing and AI with no UI. Input is a project JSON (see [project-format.md](../project-format.md)). Output is frames, audio, analysis and finished videos.

## Quick start

```bash
npm install
npx tsx scripts/make-sample.ts            # builds examples/school with synthetic footage
cd examples/school
npx tsx ../../src/cli.ts frame project.json 2.5 -o frame.png
npx tsx ../../src/cli.ts export project.json --preset school -o out/school.mp4
npx tsx ../../src/cli.ts analyse project.json
```

Multicam, using a synthetic three-camera interview:

```bash
npx tsx scripts/make-multicam.ts          # builds examples/interview
cd examples/interview
npx tsx ../../src/cli.ts multicam project.json camA camB --wide wide -o edited.json
npx tsx ../../src/cli.ts export edited.json --preset youtube -o out/interview.mp4
```

Run `npx tsx src/cli.ts help` for every command. After `npm run build`, the same CLI is at `dist/cli.js`.

## As a library

```ts
import { Engine } from '@pro-video/engine';

const engine = new Engine({ cacheDir: '.engine-cache' });
await engine.openProject(project, '/path/to/project/folder');

const frame = await engine.getFrameAt(project, 12.4, { width: 960 });   // PNG buffer
const audio = await engine.getAudio(project, 12, 14);                   // Float32 stereo
const file  = await engine.exportProject(project, 'youtube', (f) => console.log(f));
```

## What works

| Area | Status |
|---|---|
| Media probe, thumbnails, waveforms, 540p proxies | Done, cached |
| Compositor: stacked tracks, crop, scale, opacity, picture-in-picture | Done |
| Transitions: crossfade (uses source handles), fade | Done |
| Colour: exposure, contrast, saturation, white balance, LUTs | Done |
| Text: titles and captions with fade / pop / slide-up, outline or box | Done (libass) |
| Speed changes (picture and pitch-preserving audio) | Done |
| Audio mixer: per-clip gain, fades, mute, multi-track mix, loudness normalising | Done |
| Export presets: YouTube 1080p, Shorts 9:16 (fill-crop), 4K, School 720p; progress and cancel | Done |
| Silence detection, cut list, hook score, slow-section flags | Done (heuristic) |
| Transcription with word timestamps | Plumbing done: whisper.cpp via `WHISPER_CPP_BIN` + `WHISPER_MODEL`, or pass any `Transcriber`. **Not run against a real model yet** |
| Filler-word detection, transcript search | Done (needs transcripts) |
| Speaker labels | Done when each person has their own mic (multicam): words go to the loudest mic. Single-mic recordings still get `S1` |
| Multicam audio sync | Done. Under 1 ms accuracy, confidence score, clock drift measured and corrected (speed tweak on drifting angles) |
| Multicam auto-switch to active speaker | Done. Mic-level based with wide shot for silence/crosstalk, 2 s minimum shot, cuts 0.2 s early |
| Visual footage search | Done: frames described by Claude every 5 s, keyword or `semantic` search. **Tested with a fake model only; needs `ANTHROPIC_API_KEY` to run for real** |
| Auto-reframe 16:9 to 9:16 with subject tracking | Done, offline. Follows motion and detail (not face detection), smooths like a camera operator |
| Auto-captions from transcripts, SRT/WebVTT export | Done |
| Caption translation | Done via Claude. **Tested with a fake model only** |
| Dubbing (translated voice) | Not started. Needs a text-to-speech service |
| Long timelines | Chunked export. A 30-minute, 360-cut timeline exports in sync (picture exact, sound within 0.1 ms at 29:50); preview frames take about 45 ms |

## Tests

```bash
npm test             # about 15 s
npm run test:long    # 30-minute, 360-cut stress test, about 2 minutes
```

AI features run against fake models in tests, so no API key or network is needed. The Claude integration test checks the exact request we'd send (model `claude-opus-5-5`, server-side refusal fallbacks, images, JSON schema).

## AI setup

| Feature | Needs |
|---|---|
| Transcription | `WHISPER_CPP_BIN` (path to whisper.cpp's `whisper-cli`) and `WHISPER_MODEL` (a ggml model file) |
| Visual search, semantic search, translation | `ANTHROPIC_API_KEY`. Uses `claude-opus-5-5`, with server-side refusal fallbacks turned on |

Everything else runs offline.

The suite generates its own coloured test clips. It checks pixel colours at known times (base track, PiP, crossfade blend, gaps), audio length and level, export size, duration and progress, cancellation, silence detection, transcript search and filler detection.

# @pro-video/engine

The headless engine for the Pro Video Editor: video processing and AI with no UI. Input is a project JSON (see [project-format.md](project-format.md)). Output is frames, audio, analysis and finished videos.

## Quick start

```bash
npm install
npx tsx scripts/make-sample.ts            # builds examples/school with synthetic footage
cd examples/school
npx tsx ../../src/cli.ts frame project.json 2.5 -o frame.png
npx tsx ../../src/cli.ts export project.json --preset school -o out/school.mp4
npx tsx ../../src/cli.ts analyse project.json
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
| Transcription with word timestamps | Plumbing done: whisper.cpp via `WHISPER_CPP_BIN` + `WHISPER_MODEL`, or pass any `Transcriber`. Not run against a real model yet |
| Filler-word detection, transcript search | Done (needs transcripts) |
| Speaker labels | Not yet (Whisper has no diarisation; every word is `S1`) |
| Multicam audio sync and auto-switch | Not started |
| Visual footage search (frame descriptions) | Not started |
| Auto-reframe with subject tracking | Not started (Shorts preset centre-crops) |
| Translation and dubbing | Not started (stretch) |

## Tests

```bash
npm test
```

The suite generates its own coloured test clips. It checks pixel colours at known times (base track, PiP, crossfade blend, gaps), audio length and level, export size, duration and progress, cancellation, silence detection, transcript search and filler detection.

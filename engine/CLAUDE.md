# Engine (Project 1): CLAUDE.md

This repo is the **Engine + AI brain** half of the Pro Video Editor. It has no UI. It takes a project JSON and produces frames, audio, analysis data and finished videos. The Editor App (Project 2, another repo) calls it.

**The shared contract is `project-format.md`.** Never change the project shape or a function signature without agreeing it with the App side first.

## Layout

- `src/contract.ts`: project types, `validateProject`, timeline helpers. Mirrors project-format.md.
- `src/ffmpeg.ts`: runs ffmpeg/ffprobe. Uses `FFMPEG_PATH`/`FFPROBE_PATH` if set, otherwise the npm-bundled binaries.
- `src/media.ts`: probe, thumbnails, waveform, proxies. Results are cached under `cacheDir`, keyed by file path + size + mtime.
- `src/render.ts`: `buildGraph` turns a time window of a project into one FFmpeg filtergraph. Preview frames, playback audio, export and analysis all use it, so what the App previews is what gets exported.
- `src/ai.ts`: transcription (pluggable `Transcriber`; whisper.cpp built in), transcript search, silence/filler/pacing analysis.
- `src/multicam.ts`: audio sync (FFT envelope correlation, then fine envelope refine), active-speaker auto-switch, segments to clips.
- `src/reframe.ts`: subject tracking (motion + detail, zero-lag smoothing) and keyframes for the `reframe` effect.
- `src/claude.ts`: Claude-backed `Describer` / `Translator` / `Matcher` (lazy SDK import; structured outputs; refusal fallbacks).
- `src/captions.ts`: captions from transcripts, SRT/VTT.
- `src/engine.ts`: the `Engine` class, which is the public API, plus export presets.
- `src/cli.ts`: the `engine` command-line tool.
- `scripts/make-sample.ts`: generates synthetic footage and a sample project.
- `scripts/make-multicam.ts`: synthetic two-person interview on three cameras with known offsets (used by tests).

## Rules

- Rule of thumb: if it touches pixels or audio samples, it belongs here. If a person clicks it, it belongs in the App.
- AI must stay optional. Simple mode has to work offline with no model configured. Throw `AI_NOT_CONFIGURED`, never crash.
- Throw `EngineError` with a stable `code` for anything the App might show the user.
- The bundled FFmpeg has **no drawtext**. Text renders via libass (`ass` filter) from a generated .ass file.
- Times: project JSON and `analyse` use timeline seconds; `transcribe` and `searchFootage` use source-file seconds.
- Export is chunked (≤60 s, ≤32 clips per FFmpeg graph). Never go back to one graph for the whole timeline: it crashes around a few hundred clips.
- Inputs are seeked 0.1 s early and trimmed back (`preroll` in render.ts). AAC can't decode the first block after a direct seek correctly.
- Tests use fake AI models. Never make `npm test` need a key or network.

## Commands

```bash
npm test                                   # node:test suite, makes its own fixtures
npm run typecheck
npm run test:long                          # 30-min stress test
npx tsx scripts/make-sample.ts             # examples/school/project.json + footage
npx tsx src/cli.ts export examples/school/project.json --preset school -o out.mp4
```

One feature per branch and PR. Add a test in `test/engine.test.ts` for every new engine function.

# Cutline

A video editor for two kinds of people: a student making a 2–5 minute school video, and a big YouTube team cutting hours of multi-camera footage. Same engine underneath; Simple mode hides most of it, Pro mode shows it all.

Built as two projects that met on merge day, joined by a small local server:

```
cutline/
├── engine/              Project 1 — all video processing and AI, no UI (TypeScript + FFmpeg)
├── app/                 Project 2 — the editor people click (plain HTML/CSS/JS, no build step)
├── server/              Joins them: serves the App, passes its calls to the engine
├── landing-page/        The intro: storm, lightning, ANI x PADMA, then into the editor
└── project-format.md    The shared contract (project JSON, function list, server API)
```

## Run it

You need [Node.js](https://nodejs.org) 20 or newer. FFmpeg comes with the engine.

```bash
npm install
npm start
```

Open http://localhost:4100. The landing page plays (about 15 seconds; "Skip intro" jumps to the title), then fades into the editor at http://localhost:4100/editor/. Go to `/editor/` directly to skip it, or add `?stay` to the landing page address to keep watching the scene.

Everything runs on your computer; imported media is copied to `workspace/` next to this file and never uploaded anywhere.

For static hosting (e.g. Netlify), publish `landing-page/` as the site root with `app/` copied into it as `editor/`. Opened straight from disk, the landing page goes to `../app/index.html` instead. The App also works on its own as a static site. Without the server it falls back to its built-in fake engine: same interface, demo results, no real export.

## What works together

| In the App | Done by |
|---|---|
| Import video, audio, photos | Engine measures each file (formats the browser can't play still import) |
| Preview while paused | Engine renders the real frame: every track, colour, transitions, titles |
| Preview while playing | Browser plays the media directly (smooth, but one video layer at a time) |
| Analyse pacing | Engine: hook score, slow sections, filler words |
| Transcript, footage search | Engine (needs AI setup, below) |
| Export → School / YouTube / Shorts / 4K | Engine renders the MP4, with progress |

The engine can do more than the App has buttons for yet: multicam sync and auto-switching, auto-reframe to 9:16, auto-captions, translation, SRT export, speaker labels. See [engine/README.md](engine/README.md); all of it is available from the engine's command-line tool today.

## AI setup (optional)

Simple mode works fully offline. For AI features:

| Feature | Set |
|---|---|
| Transcription (transcript editing, filler words) | `WHISPER_CPP_BIN` and `WHISPER_MODEL` ([whisper.cpp](https://github.com/ggerganov/whisper.cpp)) |
| Visual footage search, translation | `ANTHROPIC_API_KEY` |

```bash
ANTHROPIC_API_KEY=... npm start
```

## Tests

```bash
npm test             # engine + server, about 30 s
npm run test:long    # 30-minute, 360-cut stress test, about 2 minutes
npm run typecheck
```

The server tests run the merge-day checklist: the App's own demo project renders through the engine, a real file is imported, analysed and exported as a school MP4, and a project with a missing file gets a clear "reimport these files" message.

## Working on it

- One feature per branch and pull request; the other person glances at it.
- Changing the project format or a function? Update [project-format.md](project-format.md), `engine/src/contract.ts` and `server/normalize.ts` in the same pull request.
- `engine/CLAUDE.md` describes the engine for Claude Code sessions; `app/README.md` describes the App.

## Known gaps

- AI features have only been tested with fake models; they need the keys above to run for real.
- Playback preview is the browser's, so it shows one video layer; paused frames are exact.
- The App has no buttons yet for multicam, reframe, captions or translation.
- Media relinking after moving the project to another computer: reimport the files.

# Cutline — video editor frontend

A small, buildless implementation of the **Editor App** in your PDF.
Plain HTML, CSS and JavaScript. No npm, frameworks, fonts, CDNs, API keys or dependencies.

## Files

- `index.html` — the interface
- `style.css` — responsive layout and appearance
- `script.js` — project state, timeline and interactions
- `fake-engine.js` — clearly labelled demo AI and export responses
- `project-format.md` — engine handoff notes
- `README.md` — these instructions

## Run or deploy

Open `index.html` in a modern desktop browser to try it locally.
For Netlify manual deployment, extract this ZIP and upload the folder containing
`index.html`, `style.css`, `script.js` and `fake-engine.js`. Keep all four together,
with index.html at the uploaded folder's top level. No build command is required.
If deploying from Git, leave the build command empty and use `.` as the publish
directory when these files are at the repository root. No Netlify functions needed.
The frontend uses only static hosting; any real engine/API is a separate deployment.

## First edit

The short introduction explains the workflow. Click **Start editing** or scroll
down to reach the editor. It adds no dependencies or JavaScript.

1. Try the demo, or choose Templates → Blank project for your own video.
2. Import browser-compatible videos, audio and images. MP4/H.264 and MP3 are good starting choices; actual codec support depends on the browser.
3. Click a media card's + button to append it, or drag it onto a matching track.
4. Select a timeline clip. Change Source in/out to trim and click Apply changes.
5. Click the ruler to position the playhead. Use Split, Delete or Ripple delete.
6. Add a title and edit its text in the inspector.
7. Download Save JSON. To continue later, Open project, then reimport your originals.

## Implemented frontend behavior

- Simple/Pro modes and responsive desktop/mobile layout (drag editing works best on desktop).
- Video/audio/image import and browser metadata for duration. Files never upload.
- Search by filename, favourites, media bin and replaceable demo AI search.
- Timeline tracks, drag/move, snap, numeric trim, split, delete, per-track ripple delete,
  zoom, scrub, frame-step and markers. Pro can add video/audio/text tracks.
- Basic local video/image preview, audio-track playback, title overlays, exposure,
  saturation and per-clip volume. Overlapping clips within a track are rejected.
- Undo/redo for project mutations, device-local autosave/recovery, JSON download/open,
  templates and a blank project. Undo history is session-only and holds 50 edits.
- Demo transcript word seeking/cutting, demo pacing flags, timestamped local notes,
  resolve/reopen and local approval. Any new edit clears approval.
- Export preset dialog and simulated progress; downloads a JSON export request.
- Accessible labels, keyboard focus, help and basic project JSON validation.

## Deliberate boundaries

This is the PDF's frontend/fake-engine phase, not the finished video engine.
**It does not render MP4s or perform real AI analysis.** Demo exports download JSON,
never a file falsely labelled as video. Demo transcripts belong to demo media `m1`.
The demo background is CSS artwork, not actual footage. Thumbnail/track patterns
are decorative, not extracted video frames or measured waveforms.

Local playback uses HTML media elements and a timeline clock. It is a convenience
preview, not a frame-accurate compositor. The last active video track is shown;
text tracks overlay it and audio tracks play alongside it. J reverses the playhead
with seeking and muted audio; reverse playback is approximate. Crop, transitions,
fades, keyframes, proxies, masks, multicam, real transcription/search/pacing,
translation/dubbing and final colour/audio processing belong to the real engine.
The transition selector currently records intent in JSON only.

Comments and approvals are local project data, not shared accounts or live
collaboration. JSON files contain edit instructions and metadata, not media bytes.
Reimporting the same file name/type/size/modification time relinks its preview.
Keep the original media files; browser storage can be cleared and is not a backup.
Do not put API secrets into these static JavaScript files.

## Keyboard shortcuts

Space: play/pause · S: split selected clip · M: marker · Delete/Backspace: delete
selected clip · Left/Right: frame-step · J/K/L: reverse/pause/play · Ctrl/Cmd+Z:
undo · Ctrl/Cmd+Shift+Z: redo · Ctrl/Cmd+S: download project.
Shortcuts are disabled while typing or when a dialog is open.

## Engine integration

See project-format.md. `fake-engine.js` deliberately keeps the PDF's function
names together. Swap its demo implementation for an adapter to your actual engine.
The basic browser import/preview code in `script.js` must then be connected to the
engine's probe/frame/audio outputs; replacing the mock alone does not create a
compositor. Real AI results must be mapped to the relevant media IDs and timestamps.

## Verification

JavaScript syntax checked. Browser checked: initial layout, clip trimming,
split, undo, mode toggle, timestamped comments, demo transcript/pacing display,
title insertion, autosave recovery after reload, and demo export completion.
Full engine integration and final video rendering are outside this frontend.

// Generates a synthetic two-person interview shot on three cameras that started recording at
// different moments, plus a project that uses them. Used by the tests and for trying multicam.
// Usage: npx tsx scripts/make-multicam.ts [outDir]   (default: examples/interview)

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Project } from '../src/contract.js';
import { ffmpeg } from '../src/ffmpeg.js';

const RATE = 48000;
const SCENE = 24;

/** Who talks when, in scene seconds. */
export const TURNS: Array<{ who: 'A' | 'B'; from: number; to: number }> = [
  { who: 'A', from: 1, to: 4.2 },
  { who: 'B', from: 4.6, to: 8.9 },
  { who: 'A', from: 9.3, to: 11.5 },
  { who: 'B', from: 11.9, to: 16.4 },
  { who: 'A', from: 16.8, to: 21 },
];

/** Each camera's recording window in scene time. Offsets relative to camA are 2.37 and 0.8. */
export const CAMERAS = [
  { id: 'camA', colour: 'darkred', from: 0, to: 22, mic: { A: 1, B: 0.2, noise: 0.01 } },
  { id: 'camB', colour: 'navy', from: 2.37, to: 24, mic: { A: 0.2, B: 1, noise: 0.01 } },
  { id: 'wide', colour: 'darkgreen', from: 0.8, to: 23.5, mic: { A: 0.5, B: 0.5, noise: 0.02 } },
] as const;

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** Noise shaped into syllables during this person's turns. */
function voice(who: 'A' | 'B', seed: number): Float32Array {
  const rand = rng(seed);
  const out = new Float32Array(SCENE * RATE);
  let lp = 0;
  const tone = who === 'A' ? 0.35 : 0.7; // different "timbre": low-pass amount
  for (const t of TURNS.filter((x) => x.who === who)) {
    let s = t.from;
    while (s < t.to) {
      const dur = 0.08 + rand() * 0.22;
      const amp = 0.25 + rand() * 0.35;
      const a = Math.floor(s * RATE);
      const b = Math.min(Math.floor(Math.min(s + dur, t.to) * RATE), out.length);
      for (let i = a; i < b; i++) {
        const env = Math.sin((Math.PI * (i - a)) / (b - a));
        lp += tone * (rand() * 2 - 1 - lp);
        out[i] = lp * amp * env;
      }
      s += dur + 0.04 + rand() * 0.18;
    }
  }
  return out;
}

function wav(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2));
  return buf;
}

export async function makeMulticamMedia(dir: string): Promise<void> {
  await mkdir(path.join(dir, 'footage'), { recursive: true });
  const A = voice('A', 11);
  const B = voice('B', 29);
  for (const [n, cam] of CAMERAS.entries()) {
    const rand = rng(100 + n);
    const a = Math.floor(cam.from * RATE);
    const b = Math.floor(cam.to * RATE);
    const mic = new Float32Array(b - a);
    for (let i = 0; i < mic.length; i++) mic[i] = cam.mic.A * A[a + i] + cam.mic.B * B[a + i] + cam.mic.noise * (rand() * 2 - 1);
    const wavFile = path.join(dir, 'footage', `${cam.id}.wav`);
    await writeFile(wavFile, wav(mic));
    await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', `color=c=${cam.colour}:s=640x360:r=30:d=${cam.to - cam.from}`, '-i', wavFile,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', path.join(dir, 'footage', `${cam.id}.mp4`)]);
    await rm(wavFile);
  }
}

export const multicamProject = (): Project => ({
  version: 1,
  settings: { width: 1280, height: 720, fps: 30, sampleRate: 48000 },
  media: CAMERAS.map((c) => ({ id: c.id, path: `footage/${c.id}.mp4`, proxyPath: null, duration: c.to - c.from, type: 'video' as const })),
  tracks: [
    { id: 'v1', kind: 'video', clips: [] },
    { id: 'a1', kind: 'audio', clips: [] },
  ],
  markers: [],
  comments: [],
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = path.resolve(process.argv[2] ?? 'examples/interview');
  await makeMulticamMedia(dir);
  await writeFile(path.join(dir, 'project.json'), JSON.stringify(multicamProject(), null, 2) + '\n');
  console.log(`multicam sample written to ${path.join(dir, 'project.json')}`);
}

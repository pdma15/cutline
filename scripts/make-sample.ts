// Generates synthetic footage and a sample project so the engine can be tried without real media.
// Usage: npx tsx scripts/make-sample.ts [outDir]   (default: examples/school)

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Project } from '../src/contract.js';
import { ffmpeg } from '../src/ffmpeg.js';

export async function makeSampleMedia(dir: string): Promise<void> {
  await mkdir(path.join(dir, 'footage'), { recursive: true });
  const f = (name: string) => path.join(dir, 'footage', name);
  // 8 s test pattern; tone for 0-3 s and 5-8 s, silent 3-5 s.
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=8',
    '-af', "volume='if(between(t,3,5),0,0.5)':eval=frame", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('cam_a.mp4')]);
  // 6 s colour bars with a lower tone.
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'smptehdbars=s=1280x720:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=220:r=48000:d=6',
    '-af', 'volume=0.4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('cam_b.mp4')]);
  // A still "photo".
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'mandelbrot=s=1024x768:end_pts=1', '-frames:v', '1', f('photo.png')]);
  // Background music bed.
  await ffmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=660:r=48000:d=20', '-af', 'volume=0.15', '-c:a', 'aac', f('music.m4a')]);
}

export const sampleProject = (): Project => ({
  version: 1,
  settings: { width: 1280, height: 720, fps: 30, sampleRate: 48000 },
  media: [
    { id: 'm1', path: 'footage/cam_a.mp4', proxyPath: null, duration: 8, type: 'video' },
    { id: 'm2', path: 'footage/cam_b.mp4', proxyPath: null, duration: 6, type: 'video' },
    { id: 'm3', path: 'footage/photo.png', proxyPath: null, duration: 0, type: 'image' },
    { id: 'm4', path: 'footage/music.m4a', proxyPath: null, duration: 20, type: 'audio' },
  ],
  tracks: [
    {
      id: 'v1', kind: 'video', clips: [
        { id: 'c1', mediaId: 'm1', start: 0, in: 0, out: 6, effects: [{ type: 'colour', exposure: 0.2, saturation: 1.2 }] },
        { id: 'c2', mediaId: 'm2', start: 6, in: 1, out: 5, transitionIn: { type: 'crossfade', duration: 0.5 } },
        { id: 'c3', mediaId: 'm3', start: 10, in: 0, out: 3, effects: [{ type: 'fade', in: 0.5, out: 0.5 }] },
      ],
    },
    {
      id: 'v2', kind: 'video', clips: [
        { id: 'c4', mediaId: 'm2', start: 2, in: 0, out: 2.5, muted: true, effects: [{ type: 'transform', x: 0.3, y: -0.3, scale: 0.3 }] },
      ],
    },
    { id: 'a1', kind: 'audio', clips: [{ id: 'c5', mediaId: 'm4', start: 0, in: 0, out: 13, effects: [{ type: 'volume', gain: 0.6 }, { type: 'fade', in: 1, out: 2 }] }] },
    {
      id: 't1', kind: 'text', clips: [
        { id: 'c6', start: 0.5, duration: 3, text: 'My Science Project', animation: 'pop', style: { fontSize: 72, bold: true, position: 'center' } },
        { id: 'c7', start: 10.5, duration: 2, text: 'Thanks for watching!', animation: 'fade', style: { box: true, boxColor: '#1d4ed8' } },
      ],
    },
  ],
  markers: [{ id: 'mk1', time: 6, label: 'Bars' }],
  comments: [{ id: 'k1', time: 4.2, author: 'producer', text: 'Hook too slow', resolved: false }],
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = path.resolve(process.argv[2] ?? 'examples/school');
  await makeSampleMedia(dir);
  await writeFile(path.join(dir, 'project.json'), JSON.stringify(sampleProject(), null, 2) + '\n');
  console.log(`sample project written to ${path.join(dir, 'project.json')}`);
}

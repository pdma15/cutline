// Stand-in footage for the App's built-in demo project (media m1-m4), so the demo renders and
// exports a real video. Colours follow the App's own demo-frame gradients.

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg } from '../engine/src/ffmpeg.js';

const DEMO = [
  { id: 'm1', file: 'mountain-morning.mp4', args: ['-f', 'lavfi', '-i', 'gradients=s=1920x1080:c0=0x7f9fa4:c1=0xb7c2b0:x0=960:y0=0:x1=960:y1=1080:d=8:r=30:speed=0.01', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '8'] },
  { id: 'm2', file: 'scenic-route.mp4', args: ['-f', 'lavfi', '-i', 'gradients=s=1920x1080:c0=0x9b9d8d:c1=0xd3bb96:x0=960:y0=0:x1=960:y1=1080:d=10:r=30:speed=0.01', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '10'] },
  { id: 'm3', file: 'golden-hour.png', args: ['-f', 'lavfi', '-i', 'gradients=s=1920x1080:c0=0xb18a76:c1=0xe4c5a0:x0=960:y0=0:x1=960:y1=1080:d=1', '-frames:v', '1'] },
  // A soft major chord as stand-in music.
  { id: 'm4', file: 'softer-pace.m4a', args: ['-f', 'lavfi', '-i', "aevalsrc='0.08*(sin(2*PI*261.6*t)+sin(2*PI*329.6*t)+sin(2*PI*392*t))*(0.6+0.4*sin(2*PI*0.25*t))':s=48000:d=24", '-c:a', 'aac'] },
] as const;

/** Creates the demo files once; returns a map of demo media id -> file. */
export async function ensureDemoMedia(dir: string): Promise<Map<string, string>> {
  await mkdir(dir, { recursive: true });
  const out = new Map<string, string>();
  for (const d of DEMO) {
    const file = path.join(dir, d.file);
    if (!existsSync(file)) {
      const video = d.file.endsWith('.mp4') ? ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'] : [];
      await ffmpeg(['-v', 'error', ...d.args, ...video, file]);
    }
    out.set(d.id, file);
  }
  return out;
}

import { createHash } from 'node:crypto';
import { mkdir, stat, readFile, writeFile, access, rename } from 'node:fs/promises';
import path from 'node:path';
import type { MediaType } from './contract.js';
import { EngineError, ffmpeg, ffprobe, sec } from './ffmpeg.js';

export interface ProbeResult {
  path: string;
  type: MediaType;
  duration: number;
  container: string;
  video: { codec: string; width: number; height: number; fps: number; rotation: number } | null;
  audio: { codec: string; channels: number; sampleRate: number } | null;
}

const IMAGE_CODECS = new Set(['png', 'mjpeg', 'jpeg2000', 'webp', 'bmp', 'tiff', 'gif', 'heic']);

const parseRate = (r?: string): number => {
  if (!r) return 0;
  const [n, d] = r.split('/').map(Number);
  return d ? n / d : n || 0;
};

export async function probeMedia(file: string): Promise<ProbeResult> {
  try {
    await access(file);
  } catch {
    throw new EngineError('NOT_FOUND', `media not found: ${file}`);
  }
  const { stdout } = await ffprobe(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(stdout.toString());
  const streams: any[] = info.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v && !a) throw new EngineError('UNSUPPORTED', `no audio or video streams in ${file}`);

  const formatName: string = info.format?.format_name ?? '';
  const isImage = !!v && !a && (IMAGE_CODECS.has(v.codec_name) || /image2|_pipe$/.test(formatName));
  const duration = isImage ? 0 : Number(info.format?.duration ?? v?.duration ?? a?.duration ?? 0);
  const rotation = Number(v?.tags?.rotate ?? v?.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? 0);
  return {
    path: file,
    type: isImage ? 'image' : v ? 'video' : 'audio',
    duration,
    container: formatName,
    video: v
      ? { codec: v.codec_name, width: v.width, height: v.height, fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate), rotation }
      : null,
    audio: a ? { codec: a.codec_name, channels: a.channels, sampleRate: Number(a.sample_rate) } : null,
  };
}

/** Stable cache key for a file: changes when the file changes. */
export async function fileKey(file: string): Promise<string> {
  const s = await stat(file);
  return createHash('sha1').update(`${path.resolve(file)}|${s.size}|${s.mtimeMs}`).digest('hex').slice(0, 16);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function thumbnails(file: string, probe: ProbeResult, count: number, cacheDir: string, height = 90): Promise<string[]> {
  const dir = path.join(cacheDir, 'thumbs', `${await fileKey(file)}-${count}-${height}`);
  await mkdir(dir, { recursive: true });
  const times = Array.from({ length: count }, (_, i) => (probe.type === 'image' ? 0 : (probe.duration * (i + 0.5)) / count));
  const out = times.map((_, i) => path.join(dir, `${String(i).padStart(4, '0')}.jpg`));
  await pool(times, 4, async (t, i) => {
    if (await exists(out[i])) return;
    const seek = probe.type === 'image' ? [] : ['-ss', sec(t)];
    await ffmpeg(['-v', 'error', ...seek, '-i', file, '-frames:v', '1', '-vf', `scale=-2:${height}`, '-q:v', '4', out[i]]);
  });
  return out;
}

export interface Waveform {
  /** Peaks per second of source audio. */
  peaksPerSecond: number;
  duration: number;
  /** Per bucket, -1..1. Draw a bar from min to max. */
  min: number[];
  max: number[];
}

export async function waveform(file: string, probe: ProbeResult, cacheDir: string, peaksPerSecond = 100): Promise<Waveform> {
  const cached = path.join(cacheDir, 'waveforms', `${await fileKey(file)}-${peaksPerSecond}.json`);
  if (await exists(cached)) return JSON.parse(await readFile(cached, 'utf8'));
  if (!probe.audio) return { peaksPerSecond, duration: probe.duration, min: [], max: [] };

  const rate = 8000;
  const { stdout } = await ffmpeg(['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-acodec', 'pcm_s16le', '-'], {
    captureStdout: true,
  });
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 2));
  const per = Math.max(1, Math.round(rate / peaksPerSecond));
  const n = Math.ceil(samples.length / per);
  const min = new Array<number>(n);
  const max = new Array<number>(n);
  for (let b = 0; b < n; b++) {
    let lo = 0;
    let hi = 0;
    const end = Math.min(samples.length, (b + 1) * per);
    for (let i = b * per; i < end; i++) {
      const s = samples[i];
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    min[b] = Math.round((lo / 32768) * 1000) / 1000;
    max[b] = Math.round((hi / 32767) * 1000) / 1000;
  }
  const result: Waveform = { peaksPerSecond: rate / per, duration: samples.length / rate, min, max };
  await mkdir(path.dirname(cached), { recursive: true });
  await writeFile(cached, JSON.stringify(result));
  return result;
}

/** 540p H.264 with short GOPs so scrubbing is fast. */
export async function proxy(file: string, probe: ProbeResult, cacheDir: string, onProgress?: (f: number) => void): Promise<string> {
  if (probe.type !== 'video') throw new EngineError('UNSUPPORTED', `proxies are only made for video, not ${probe.type}`);
  const out = path.join(cacheDir, 'proxies', `${await fileKey(file)}.mp4`);
  if (await exists(out)) return out;
  await mkdir(path.dirname(out), { recursive: true });
  const tmp = out.replace(/\.mp4$/, '.partial.mp4');
  const h = Math.min(540, probe.video!.height);
  await ffmpeg(
    ['-v', 'error', '-i', file, '-vf', `scale=-2:${h - (h % 2)}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', '15', '-pix_fmt', 'yuv420p',
      ...(probe.audio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']), '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp],
    { onStdoutLine: progressParser(probe.duration, onProgress) },
  );
  await rename(tmp, out);
  return out;
}

export function progressParser(duration: number, onProgress?: (f: number) => void): ((line: string) => void) | undefined {
  if (!onProgress) return undefined;
  return (line) => {
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
    if (m && duration > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
    else if (line === 'progress=end') onProgress(1);
  };
}

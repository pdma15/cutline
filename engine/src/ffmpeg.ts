import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export class EngineError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

/** FFMPEG_PATH / FFPROBE_PATH win; otherwise the npm-bundled binaries. */
export const ffmpegBin = (): string => process.env.FFMPEG_PATH || (require('ffmpeg-static') as string);
export const ffprobeBin = (): string => process.env.FFPROBE_PATH || (require('ffprobe-static') as { path: string }).path;

export interface RunOptions {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Collect stdout as a Buffer (for piped images/audio). */
  captureStdout?: boolean;
  /** Kills the process when aborted. */
  signal?: AbortSignal;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal });
    const out: Buffer[] = [];
    let err = '';
    let outLine = '';
    let errLine = '';
    const lines = (chunk: string, rest: string, cb?: (l: string) => void): string => {
      const parts = (rest + chunk).split(/\r?\n|\r/);
      const tail = parts.pop() ?? '';
      if (cb) parts.forEach(cb);
      return tail;
    };
    child.stdout.on('data', (d: Buffer) => {
      if (opts.captureStdout) out.push(d);
      if (opts.onStdoutLine) outLine = lines(d.toString(), outLine, opts.onStdoutLine);
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      err += s;
      if (err.length > 2_000_000) err = err.slice(-1_000_000);
      errLine = lines(s, errLine, opts.onStderrLine);
    });
    child.on('error', (e) =>
      reject(e.name === 'AbortError' ? new EngineError('ABORTED', 'cancelled') : new EngineError('FFMPEG_MISSING', `could not start ${bin}: ${e.message}`)));
    child.on('close', (code) => {
      if (opts.signal?.aborted) return reject(new EngineError('ABORTED', 'cancelled'));
      if (code === 0) return resolve({ stdout: Buffer.concat(out), stderr: err });
      const tail = err.trim().split('\n').slice(-8).join('\n');
      reject(new EngineError('FFMPEG_FAILED', `${bin.split('/').pop()} exited with ${code}:\n${tail}`));
    });
  });
}

export const ffmpeg = (args: string[], opts?: RunOptions) => run(ffmpegBin(), ['-hide_banner', '-nostdin', '-y', ...args], opts);
export const ffprobe = (args: string[]) => run(ffprobeBin(), ['-hide_banner', ...args], { captureStdout: true });

/** Seconds as a string ffmpeg accepts, without float noise. */
export const sec = (n: number): string => (Math.round(n * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, '') || '0';

/** Quote a value for use inside a filtergraph option. */
export const filterPath = (p: string): string => `'${p.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`;

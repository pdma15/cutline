#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateProject, type Project } from './contract.js';
import { Engine, PRESETS } from './engine.js';
import { EngineError } from './ffmpeg.js';

const HELP = `engine — headless video engine (Project 1)

Usage: engine <command> [args] [--flags]

Media
  probe <file>                         Duration, codecs, resolution, fps, audio
  thumbs <file> [--count 10]           Thumbnail JPEGs for the timeline
  waveform <file> [-o peaks.json]      Audio peak data
  proxy <file>                         Low-res editing copy (540p)

Project (project.json; media paths resolve relative to it)
  validate <project>                   Check against the contract
  frame <project> <time> [-o f.png] [--width 960]
  audio <project> <from> <to> [-o mix.wav]
  export <project> [--preset youtube] [-o out.mp4]
  analyse <project>                    Silences, fillers, cuts, pacing
  transcribe <project> <mediaId>       Needs WHISPER_CPP_BIN + WHISPER_MODEL
  search <project> <query...>          Search transcribed footage
  presets                              List export presets

Global: --cache <dir>  (default: system temp)`;

function parse(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') flags.o = argv[++i];
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true);
    } else pos.push(a);
  }
  return { pos, flags };
}

const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

async function loadProject(file: string): Promise<{ project: Project; dir: string }> {
  const project = JSON.parse(await readFile(file, 'utf8'));
  return { project, dir: path.dirname(path.resolve(file)) };
}

async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  const [cmd, ...args] = pos;
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
  const need = (n: number, usage: string) => {
    if (args.length < n) throw new EngineError('USAGE', `usage: engine ${usage}`);
  };
  const cacheDir = str('cache');

  if (!cmd || cmd === 'help' || flags.help) return console.log(HELP);

  if (['probe', 'thumbs', 'waveform', 'proxy'].includes(cmd)) {
    need(1, `${cmd} <file>`);
    const engine = new Engine({ cacheDir });
    if (cmd === 'probe') return print(await engine.probeMedia(path.resolve(args[0])));
    const m = await engine.importMedia(path.resolve(args[0]), 'm1');
    if (cmd === 'thumbs') return print(await engine.getThumbnails(m.id, Number(str('count') ?? 10)));
    if (cmd === 'waveform') {
      const w = await engine.getWaveform(m.id);
      if (str('o')) {
        await writeFile(str('o')!, JSON.stringify(w));
        return print({ output: path.resolve(str('o')!), peaks: w.max.length, peaksPerSecond: w.peaksPerSecond });
      }
      return print({ ...w, min: `[${w.min.length} values]`, max: `[${w.max.length} values]` });
    }
    const out = await engine.makeProxy(m.id, (f) => process.stderr.write(`\rproxy ${Math.round(f * 100)}%`));
    process.stderr.write('\n');
    return print({ proxy: out });
  }

  if (cmd === 'presets') return print(Object.values(PRESETS));

  need(1, `${cmd} <project.json>`);
  const { project, dir } = await loadProject(args[0]);
  const engine = new Engine({ cacheDir, baseDir: dir });

  switch (cmd) {
    case 'validate': {
      const errs = validateProject(project);
      if (errs.length) {
        console.error(errs.join('\n'));
        process.exitCode = 1;
      } else console.log('ok');
      return;
    }
    case 'frame': {
      need(2, 'frame <project> <time> [-o frame.png]');
      const f = await engine.getFrameAt(project, Number(args[1]), { width: str('width') ? Number(str('width')) : undefined });
      const out = path.resolve(str('o') ?? `frame-${args[1]}.png`);
      await writeFile(out, f.data);
      return print({ output: out, width: f.width, height: f.height });
    }
    case 'audio': {
      need(3, 'audio <project> <from> <to> [-o mix.wav]');
      return print({ output: await engine.exportAudio(project, Number(args[1]), Number(args[2]), path.resolve(str('o') ?? 'mix.wav')) });
    }
    case 'export': {
      const preset = str('preset') ?? 'youtube';
      const started = Date.now();
      const out = await engine.exportProject(project, preset, (f) => process.stderr.write(`\rexport ${preset} ${String(Math.round(f * 100)).padStart(3)}%`), {
        output: str('o') ? path.resolve(str('o')!) : undefined,
      });
      process.stderr.write('\n');
      return print({ output: out, seconds: Math.round((Date.now() - started) / 100) / 10 });
    }
    case 'analyse':
    case 'analyze':
      return print(await engine.analyse(project));
    case 'transcribe': {
      need(2, 'transcribe <project> <mediaId>');
      await engine.openProject(project);
      const t = await engine.transcribe(args[1]);
      return print({ mediaId: t.mediaId, language: t.language, words: t.words.length, preview: t.words.slice(0, 20).map((w) => w.text).join(' ') });
    }
    case 'search': {
      need(2, 'search <project> <query>');
      await engine.openProject(project);
      return print(await engine.searchFootage(args.slice(1).join(' ')));
    }
    default:
      throw new EngineError('USAGE', `unknown command ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => {
  console.error(e instanceof EngineError ? `error [${e.code}]: ${e.message}` : e);
  process.exitCode = 1;
});

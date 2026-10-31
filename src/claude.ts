// Claude-backed AI features: describing frames for visual search, semantic search over those
// descriptions, and translating captions. Optional — the engine works without it.
//
// Enabled when ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set, or when a client is passed in.
// The SDK is imported lazily so offline/Simple mode never loads it.

import type Anthropic from '@anthropic-ai/sdk';
import { EngineError } from './ffmpeg.js';

export interface FrameDescription {
  /** Source-time seconds. */
  time: number;
  text: string;
}

/** Describes sampled frames of one clip. */
export interface Describer {
  name: string;
  describe(frames: Array<{ time: number; jpeg: Buffer }>): Promise<FrameDescription[]>;
}

/** Translates a batch of caption lines, keeping order and count. */
export interface Translator {
  name: string;
  translate(lines: string[], targetLanguage: string): Promise<string[]>;
}

/** Picks which indexed moments answer a free-text query. */
export interface Matcher {
  name: string;
  match(query: string, moments: Array<{ id: number; text: string }>): Promise<Array<{ id: number; score: number }>>;
}

const MODEL = 'claude-opus-5-5';

type Client = Anthropic;

async function makeClient(): Promise<Client> {
  const { default: AnthropicSDK } = await import('@anthropic-ai/sdk');
  return new AnthropicSDK();
}

/**
 * One structured-output request. Uses server-side refusal fallbacks (beta) so a rare policy decline
 * on Claude Opus 5.5 is retried on a suitable model instead of failing the whole index job.
 */
async function askJson<T>(client: Client, content: Anthropic.Beta.BetaContentBlockParam[], schema: Record<string, unknown>, system: string): Promise<T> {
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content }],
  });
  if (res.stop_reason === 'refusal') throw new EngineError('AI_REFUSED', `the model declined this request (${res.stop_details?.category ?? 'no category'})`);
  if (res.stop_reason === 'max_tokens') throw new EngineError('AI_FAILED', 'the model ran out of output tokens; try a smaller batch');
  const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new EngineError('AI_FAILED', 'the model returned invalid JSON');
  }
}

export interface ClaudeAI extends Describer, Translator, Matcher {}

/** Returns Claude-backed AI if credentials are in the environment (or a client is given), else undefined. */
export function claudeFromEnv(client?: Client): ClaudeAI | undefined {
  if (!client && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return undefined;
  let cached: Promise<Client> | undefined = client ? Promise.resolve(client) : undefined;
  const get = () => (cached ??= makeClient());

  return {
    name: `claude:${MODEL}`,

    async describe(frames) {
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const f of frames) {
        content.push({ type: 'text', text: `Frame at ${f.time.toFixed(2)}s:` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.jpeg.toString('base64') } });
      }
      content.push({ type: 'text', text: 'Describe each frame for a video editor searching their footage.' });
      const out = await askJson<{ frames: Array<{ time: number; description: string }> }>(await get(), content, {
        type: 'object',
        properties: { frames: { type: 'array', items: { type: 'object', properties: { time: { type: 'number' }, description: { type: 'string' } }, required: ['time', 'description'], additionalProperties: false } } },
        required: ['frames'],
        additionalProperties: false,
      }, 'You index raw video footage so editors can find moments by typing what they remember. For each frame write one plain sentence of 10 to 25 words: who or what is visible, what they are doing, the setting, and any readable on-screen text. Use concrete nouns and verbs an editor would search for (e.g. "falls into the pool", "holds a red trophy"). Return one entry per frame with the exact time given.');
      return out.frames.map((f) => ({ time: f.time, text: f.description }));
    },

    async translate(lines, targetLanguage) {
      if (!lines.length) return [];
      const out = await askJson<{ lines: string[] }>(await get(), [{ type: 'text', text: JSON.stringify({ targetLanguage, lines }) }], {
        type: 'object',
        properties: { lines: { type: 'array', items: { type: 'string' } } },
        required: ['lines'],
        additionalProperties: false,
      }, 'You translate video captions. Translate every entry of "lines" into "targetLanguage". Keep the same number of entries in the same order, keep each one about as short as the original so it fits on screen, and keep names and on-screen terms unchanged.');
      if (out.lines.length !== lines.length) throw new EngineError('AI_FAILED', `translation returned ${out.lines.length} lines for ${lines.length}`);
      return out.lines;
    },

    async match(query, moments) {
      if (!moments.length) return [];
      const listing = moments.map((m) => `${m.id}: ${m.text}`).join('\n');
      const out = await askJson<{ matches: Array<{ id: number; score: number }> }>(await get(), [{ type: 'text', text: `Query: ${query}\n\nMoments:\n${listing}` }], {
        type: 'object',
        properties: { matches: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, score: { type: 'number' } }, required: ['id', 'score'], additionalProperties: false } } },
        required: ['matches'],
        additionalProperties: false,
      }, 'An editor is searching their footage. Each moment is a description of a video frame or a line of speech. Return the ids of moments that match the query, with a score from 0 to 1 for how well each matches. Include only real matches, best first; an empty list is fine.');
      const known = new Set(moments.map((m) => m.id));
      return out.matches.filter((m) => known.has(m.id));
    },
  };
}

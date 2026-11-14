import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeltaJoiner, wellFormed } from '../src/wellFormed';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

// A `\uD800`-`\uDFFF` escape that is not half of a pair: the Rust host's JSON
// parser rejects the whole frame.
const LONE_ESCAPE = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i;

test('lone surrogates become replacement characters and pairs stay', () => {
  expect(wellFormed('a\uD835b𝑥\uDC65')).toBe('a�b𝑥�');
  expect(wellFormed('Let 𝑥 be 😀.')).toBe('Let 𝑥 be 😀.');
});

test('a character split across deltas is sent whole, per stream', () => {
  const joiner = new DeltaJoiner();
  expect(joiner.push('text_delta', 'Let \uD835')).toBe('Let ');
  expect(joiner.push('thinking_delta', 'plan')).toBe('plan');
  expect(joiner.push('text_delta', '\uDC65 be')).toBe('𝑥 be');
  expect(joiner.push('text_delta', '\uD83D')).toBe('');
  joiner.reset();
  expect(joiner.push('text_delta', '\uDE00 next')).toBe('� next');
});

/** Runs the real JSONL worker against a provider that splits 𝑥 across two deltas. */
test('the worker never writes a lone surrogate when a provider splits a character', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'kordi-omp-well-formed-'));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    await request.json();
    const body = chunk({ role: 'assistant', content: 'Let \uD835' }) + chunk({ content: '\uDC65 be a paper.' }) + chunk({}, 'stop');
    return new Response(`${body}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }});
  cleanup.push(() => server.stop(true));
  const worker = Bun.spawn(['bun', 'run', join(import.meta.dir, '../src/worker.ts')], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
  cleanup.push(() => worker.kill());
  worker.stdin.write(`${JSON.stringify({ schemaVersion: 1, type: 'run', requestId: 'request-1', runId: 'run-1', attemptId: 'attempt-1', sessionId: 'session-1', cwd,
    model: { provider: 'fixture-provider', id: 'fixture-model', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1` },
    auth: { kind: 'api_key', credential: 'synthetic-test-key' }, systemPrompt: 'You are a test agent.', messages: [],
    prompt: { text: 'Review the literature.' }, tools: [], limits: { timeoutMs: 30000, maxOutputBytes: 1048576 } })}\n`);
  const lines = (await new Response(worker.stdout).text()).split('\n').filter(Boolean);
  for (const line of lines) expect(LONE_ESCAPE.test(line)).toBe(false);
  const frames = lines.map(line => JSON.parse(line));
  const deltas = frames.filter(frame => frame.event?.kind === 'text_delta').map(frame => frame.event.delta);
  expect(deltas).toEqual(['Let ', '𝑥 be a paper.']);
  expect(frames.at(-1)).toMatchObject({ type: 'result', text: 'Let 𝑥 be a paper.' });
}, 30000);

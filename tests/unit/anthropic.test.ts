import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AnthropicLLM } from '../../server/ai/anthropic';
import { LLMError } from '../../server/ai/llm';

// A local stand-in for api.anthropic.com that speaks the Messages streaming (SSE)
// protocol, so the real SDK code path is exercised without a key or any cost.
let server: Server, base = '';
const seen: { body: Record<string, unknown>; headers: Record<string, unknown> }[] = [];
const sse = (ev: string, data: unknown) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;

beforeAll(async () => {
  server = createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
      const body = JSON.parse(b || '{}');
      seen.push({ body, headers: req.headers });
      const key = req.headers['x-api-key'];
      if (key === 'bad') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); }
      if (key === 'busy') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const stop = key === 'refuse' ? 'refusal' : 'end_turn';
      res.write(sse('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1234, output_tokens: 1 } } }));
      res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      for (const t of ['{"type":"desk","imp', 'act":3}\n{"type":"trade",', '"id":"pip"}\n'])
        res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }));
      res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
      res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 42 } }));
      res.write(sse('message_stop', { type: 'message_stop' }));
      res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, r));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

describe('AnthropicLLM (real SDK against a local fake API)', () => {
  it('streams text deltas and reports token usage', async () => {
    const llm = new AnthropicLLM('good', { baseURL: base, maxRetries: 0 });
    let text = '';
    const u = await llm.stream({ model: 'claude-sonnet-5-5', prompt: 'hello', maxTokens: 4000, effort: 'low' }, d => { text += d; });
    expect(text).toBe('{"type":"desk","impact":3}\n{"type":"trade","id":"pip"}\n');
    expect(u).toEqual({ inputTokens: 1234, cachedTokens: 0, outputTokens: 42, stopReason: 'end_turn', model: 'claude-sonnet-5-5' });
    const req = seen.at(-1)!;
    expect(req.body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 4000, stream: true, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'hello' }] });
    expect(req.headers['x-api-key']).toBe('good');
  });

  it('maps errors to codes the game understands', async () => {
    const run = (key: string) => new AnthropicLLM(key, { baseURL: base, maxRetries: 0 }).stream({ model: 'm', prompt: 'p', maxTokens: 10 }, () => { });
    await expect(run('bad')).rejects.toMatchObject({ code: 'auth' });
    await expect(run('busy')).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(run('refuse')).rejects.toMatchObject({ code: 'refused' });
    await expect(run('bad')).rejects.toBeInstanceOf(LLMError);
  });

  it('cancels cleanly', async () => {
    const ac = new AbortController(); ac.abort();
    await expect(new AnthropicLLM('good', { baseURL: base, maxRetries: 0 }).stream({ model: 'm', prompt: 'p', maxTokens: 10, signal: ac.signal }, () => { })).rejects.toMatchObject({ code: 'cancelled' });
  });
});

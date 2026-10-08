import { describe, it, expect } from 'vitest';
import { SupabaseStore } from '../../server/store/supabase';

// No Supabase project needed: a fake fetch records what the client would send.
function fakeFetch(reply: (url: URL, init: RequestInit) => unknown = () => []) {
  const calls: { method: string; url: URL; body: unknown; headers: Headers }[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init.headers) });
    return new Response(JSON.stringify(reply(url, init)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

describe('SupabaseStore', () => {
  it('upserts lessons per room and trader with the service key', async () => {
    const { f, calls } = fakeFetch();
    const s = new SupabaseStore('https://proj.supabase.co', 'service-role-key', f);
    await s.saveLessons('ABCDE', 'pip', ['Do not buy the top.']);
    const c = calls[0];
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/rest/v1/trader_lessons');
    expect(c.url.searchParams.get('on_conflict')).toBe('room_code,agent_id');
    expect(c.body).toMatchObject({ room_code: 'ABCDE', agent_id: 'pip', lessons: ['Do not buy the top.'] });
    expect(c.headers.get('apikey')).toBe('service-role-key');
  });

  it('loads lessons back into a per-trader map', async () => {
    const { f } = fakeFetch(() => [{ agent_id: 'vega', lessons: ['Halve size after a halt.'] }]);
    const s = new SupabaseStore('https://proj.supabase.co', 'k', f);
    expect(await s.loadLessons('ABCDE')).toEqual({ vega: ['Halve size after a halt.'] });
  });

  it('upserts players on (room_code, token)', async () => {
    const { f, calls } = fakeFetch();
    const s = new SupabaseStore('https://proj.supabase.co', 'k', f);
    await s.savePlayers([{ room_code: 'ABCDE', token: 't1', pid: 'p1', name: 'Brae', color: '#fff', cash: 1, shares: 2, cost: 3, start_value: 4 }]);
    expect(calls[0].url.pathname).toBe('/rest/v1/players');
    expect(calls[0].url.searchParams.get('on_conflict')).toBe('room_code,token');
  });
});

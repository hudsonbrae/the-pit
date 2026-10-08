import { describe, it, expect } from 'vitest';
import { deps, simRoom, RecConn, ScriptLLM, script, IDS, until } from './helpers';
import { FakeLLM } from '../../server/ai/fake';
import { lineSplitter, parseLine } from '../../server/ai/llm';
import { tradePrompt } from '../../server/prompts';

describe('AI rounds on the server', () => {
  it('two rounds in a row: the second prompt contains the lessons written in the first', async () => {
    const lessonsR1 = (id: string) => `${id} lesson one: wait for the second wave of sellers.`;
    const llm = new ScriptLLM([script(6, () => ''), script(-4, lessonsR1, 'sell'), script(2, () => '')]);
    const d = deps({ llm });
    const room = simRoom(d);
    // round 0 gives every trader a "last call"; round 1 writes lessons; round 2 must see them
    await room.runRound({ text: 'Halcyon wins $4B Pentagon contract', byName: 'Brae', origin: 'PLAYER' });
    await room.runRound({ text: 'CFO resigns effective immediately', byName: 'Brae', origin: 'PLAYER' });
    await room.runRound({ text: 'CEO posts a photo of his dog', byName: 'Sam', origin: 'PLAYER' });
    expect(llm.prompts).toHaveLength(3);
    for (const id of IDS) {
      expect(llm.prompts[1]).not.toContain(lessonsR1(id));
      expect(llm.prompts[2]).toContain(lessonsR1(id));
    }
    // the second prompt also reflects the first call's outcome
    expect(llm.prompts[1]).toContain('Their last call: BUY 500');
  });

  it('persists lessons per room and trader, and a restored room loads them into its prompt', async () => {
    const llm = new ScriptLLM([script(1, id => `${id}: never chase a halt.`)]);
    const d = deps({ llm });
    const room = simRoom(d, 'LSSNS');
    await room.runRound({ text: 'Something happens', byName: 'Brae', origin: 'PLAYER' });
    await until(() => Object.keys(d.store.lessons.get('LSSNS') ?? {}).length === 6);
    expect(d.store.lessons.get('LSSNS')!.vega).toEqual(['vega: never chase a halt.']);
    // a new process: same store, fresh room object
    const again = simRoom({ ...d, llm: new ScriptLLM([script(0, () => '')]) }, 'LSSNS');
    await again.loadPersisted();
    const p = tradePrompt((again as unknown as { ctx(): Parameters<typeof tradePrompt>[0] }).ctx(), 'x');
    expect(p).toContain('1) vega: never chase a halt.');
  });

  it('streams desk, trades and chatter to clients line by line, before the model has finished', async () => {
    const llm = new ScriptLLM([script(12, () => '')], 40);
    const d = deps({ llm, cfg: { roundPaceMs: 30, chatterPaceMs: 10 } });
    const room = simRoom(d);
    const c = new RecConn();
    room.attach(c, 'player-token-1', 'Brae');
    await room.runRound({ text: 'Huge contract win', byName: 'Brae', origin: 'PLAYER' });
    const deskWire = c.of('wire').find(m => m.wire[0].impact === 12);
    const agents = c.of('agent');
    const chatter = c.of('chatter');
    expect(deskWire).toBeTruthy();
    expect(deskWire!.at).toBeLessThan(llm.endedAt);            // desk shown while the stream was still running
    expect(agents.map(a => a.a.id)).toEqual(IDS);              // in order
    expect(agents[0].at).toBeLessThan(llm.endedAt);            // first trader acted mid-stream
    expect(chatter).toHaveLength(2);
    expect(c.of('round').at(-1)!.r.busy).toBe(false);
    // the shock moved fair value and the traders actually traded
    expect(room.eng.S.fvTarget).toBeGreaterThan(105);
    expect(agents.every(a => /filled|resting/.test(a.a.lastAct!.fill))).toBe(true);
  });

  it('the realistic mock streams valid JSON Lines for a whole round', async () => {
    const fake = new FakeLLM({ firstTokenMs: 0, chunkMs: 0 });
    const room = simRoom(deps({ llm: fake }));
    await room.runRound({ text: 'Short seller alleges fraud at Halcyon', byName: 'Brae', origin: 'PLAYER' });
    expect(room.stats.aiRounds).toBe(1);
    expect(room.stats.offlineRounds).toBe(0);
    expect(room.news[0].impact).toBeLessThan(0);
    expect(room.agents.every(a => a.log[0].head === 'Short seller alleges fraud at Halcyon')).toBe(true);
    expect(fake.calls[0].model).toBe('claude-sonnet-5-5');
  });

  it('falls back to the offline rules when the API fails', async () => {
    const fake = new FakeLLM({ firstTokenMs: 0, chunkMs: 0 });
    fake.failNext = 'overloaded';
    const room = simRoom(deps({ llm: fake }));
    await room.runRound({ text: 'Halcyon wins record contract', byName: 'Brae', origin: 'PLAYER' });
    expect(room.round.note).toMatch(/offline rules/);
    expect(room.stats.offlineRounds).toBe(1);
    expect(room.agents.every(a => a.lastAct)).toBe(true);
  });

  it('a rejected key switches every room to offline and says so', async () => {
    const fake = new FakeLLM({ firstTokenMs: 0, chunkMs: 0 });
    fake.failNext = 'auth';
    const d = deps({ llm: fake });
    const room = simRoom(d);
    await room.runRound({ text: 'x', byName: 'Brae', origin: 'PLAYER' });
    expect(d.aiState.dead).toBe(true);
    expect(room.info().ai).toEqual({ label: 'Offline sim (API key rejected)', on: false });
  });

  it('works with no AI at all (offline rules only)', async () => {
    const room = simRoom(deps({ llm: null }));
    await room.runRound({ text: 'CFO resigns', byName: 'Brae', origin: 'PLAYER' });
    expect(room.round.note).toBe('Claude is not connected here, so the traders ran on offline rules.');
    expect(room.news[0].impact).toBeLessThan(0);
  });

  it('cost guard: per-room rounds-per-minute limit and the daily cap fall back to offline', async () => {
    const fake = new FakeLLM({ firstTokenMs: 0, chunkMs: 0 });
    const d = deps({ llm: fake, cfg: { aiRoundsPerMinPerRoom: 2, aiDailyRoundCap: 3 } });
    const a = simRoom(d, 'AAAAA'), b = simRoom(d, 'BBBBB');
    await a.runRound({ text: 'one', byName: 'x', origin: 'PLAYER' });
    await a.runRound({ text: 'two', byName: 'x', origin: 'PLAYER' });
    await a.runRound({ text: 'three', byName: 'x', origin: 'PLAYER' });
    expect(a.round.note).toMatch(/limit for this room/);
    expect(fake.calls).toHaveLength(2);
    await b.runRound({ text: 'four', byName: 'x', origin: 'PLAYER' });   // 3rd AI round today: allowed
    await b.runRound({ text: 'five', byName: 'x', origin: 'PLAYER' });   // over the daily cap
    expect(b.round.note).toMatch(/AI budget is used up/);
    expect(fake.calls).toHaveLength(3);
    expect(d.guard.log.every(u => u.inputTokens > 0 && u.outputTokens > 0)).toBe(true); // token usage logged per round
  });

  it('only one round at a time: a second request is rejected and says who triggered the first', async () => {
    const llm = new ScriptLLM([script(1, () => '')], 30);
    const room = simRoom(deps({ llm }));
    const c1 = new RecConn(), c2 = new RecConn();
    const p1 = room.attach(c1, 'player-token-1', 'Brae'), p2 = room.attach(c2, 'player-token-2', 'Sam');
    if (typeof p1 === 'string' || typeof p2 === 'string') throw new Error(String(p1));
    void room.handle(c1, p1, { k: 'news', text: 'Brae news' });
    await until(() => room.round.busy);
    await room.handle(c2, p2, { k: 'news', text: 'Sam news' });
    expect(c2.of('toast').at(-1)!.text).toMatch(/already in flight \(Brae\)/);
    expect(c2.of('round').at(-1)!.r).toMatchObject({ busy: true, by: 'Brae' });
    await until(() => !room.round.busy);
    expect(llm.prompts).toHaveLength(1);
  });

  it('parses JSON Lines tolerantly, across chunk boundaries', () => {
    const out: string[] = [];
    const s = lineSplitter(l => out.push(l));
    s.push('{"type":"de'); s.push('sk","impact":1}\n{"ty'); s.push('pe":"trade","id":"pip"},\n```\n'); s.end();
    expect(out.map(parseLine).filter(Boolean)).toEqual([{ type: 'desk', impact: 1 }, { type: 'trade', id: 'pip' }]);
  });
});

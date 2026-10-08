import { describe, it, expect } from 'vitest';
import { deps, simRoom, RecConn, ScriptLLM, IDS } from './helpers';
import { Science } from '../../server/intel/science';
import { Scorebook, HORIZON_TICKS, type Resolved } from '../../server/intel/stats';
import { Storyteller } from '../../server/intel/stories';
import type { Player } from '../../server/room';
import type { StoryV } from '../../shared/protocol';

const join = (room: ReturnType<typeof simRoom>, c: RecConn, token: string, name: string) => room.attach(c, token, name) as Player;
const res = (o: Partial<Resolved>): Resolved => ({ who: 'pip', ai: true, t: 0, px: 100, call: 'up', conviction: 70, action: 'buy', qty: 100, fill: 100, head: 'h', category: 'other', clock: '09:40', endPx: 101, ret: 0.01, correct: true, pnl: 100, ...o });

describe('AI science: does debate make the floor smarter?', () => {
  it('scores the opening view and the final call of the same trader on the same headline', () => {
    const x = new Science();
    for (let i = 0; i < 6; i++) {
      // opening said down, debate flipped it to up, price went up: the debate helped
      x.onResolved(res({ debate: true, opening: 'down', call: 'up', correct: true }), 'up');
    }
    x.onResolved(res({ debate: false, correct: false, call: 'down' }), 'up');
    const v = x.view();
    expect(v.debate).toMatchObject({ open: 0, final: 100, n: 6, flips: 6, flipsRight: 6 });
    expect(v.single).toEqual({ acc: 0, n: 1 });
    expect(v.verdict).toMatch(/Debate improved the floor: opening views 0% right, final calls 100%/);
  });

  it('says it is still collecting data rather than inventing a conclusion', () => {
    const x = new Science();
    x.onResolved(res({ debate: true, opening: 'up' }), 'up');
    expect(x.view().verdict).toMatch(/Collecting data: 1 of 6/);
    expect(x.view().debate.final).toBe(100);
  });

  it('measures herding by regime and who moves together or against each other', () => {
    const x = new Science();
    const all = (a: string) => IDS.map(id => ({ id, action: a }));
    x.onRound('CALM', [...IDS.slice(0, 3).map(id => ({ id, action: 'buy' })), ...IDS.slice(3).map(id => ({ id, action: 'sell' }))]);
    x.onRound('PANIC', all('sell'));
    expect(x.view().herding).toEqual({ calm: 0.5, stressed: 1 });
    for (let i = 0; i < 4; i++) x.onRound('CALM', IDS.map(id => ({ id, action: id === 'ash' ? 'sell' : id === 'kestrel' ? 'buy' : 'hold' })));
    const rel = x.view().relations;
    expect(rel.some(r => r.kind === 'rivals' && [r.a, r.b].sort().join() === 'Ash,Kestrel')).toBe(true);
  });

  it('checks the desk: did the fair-value call point the way the price went?', () => {
    const x = new Science();
    x.onHeadlineMoved(5, 1.2); x.onHeadlineMoved(-3, 0.9); x.onHeadlineMoved(4, 0.1); // last is inside the flat band
    expect(x.view().desk).toEqual({ acc: 50, n: 2 });
  });

  it('a debated round in a live room feeds the experiment, the floor tendencies and the prompt', async () => {
    const views = IDS.map(id => JSON.stringify({ type: 'view', id, action: 'buy', qty: 500, conviction: 70, call: 'up', thought: `${id} opens long` }));
    const finals = IDS.map(id => JSON.stringify({ type: 'trade', id, action: id === 'ash' ? 'sell' : 'buy', qty: 500, conviction: 70, call: id === 'ash' ? 'down' : 'up', thought: `${id} final` }));
    const llm = new ScriptLLM([[JSON.stringify({ type: 'desk', impact: 5, speed: 'slow', read: 'Good.' }), ...views], [...finals]]);
    const room = simRoom(deps({ llm }));
    const c = new RecConn(); join(room, c, 'player-token-1', 'Brae');
    await room.runRound({ text: 'Big news', byName: 'Brae', origin: 'PLAYER', debate: true });
    const recs = room.sb.pending.filter(r => r.ai);
    expect(recs.find(r => r.who === 'ash')).toMatchObject({ debate: true, opening: 'up', call: 'down', floor: 'against' });
    expect(recs.find(r => r.who === 'pip')).toMatchObject({ floor: 'with' });
    // score them
    const { t, last } = { t: room.eng.S.t + HORIZON_TICKS, last: room.eng.S.last * 1.02 };
    for (const r of room.sb.resolve(t, last)) room.sci.onResolved(r, 'up');
    expect(room.science().debate.n).toBe(6);
    expect(room.science().debate.open).toBe(100);
    expect(room.science().debate.final).toBe(83);
    expect(room.sb.get('ash').fade).toEqual({ n: 1, c: 0 });
  });

  it('tendencies reach the prompt once there are 3+ calls', () => {
    const sb = new Scorebook();
    for (let i = 0; i < 3; i++) { sb.record({ who: 'ash', ai: true, t: i, px: 100, call: 'down', conviction: 70, action: 'sell', qty: 0, fill: null, head: 'h', category: 'other', clock: '09:40', floor: 'against', regime: 'PANIC' }); }
    sb.resolve(1e6, 98);
    const r = sb.record4prompt('ash', 0, 'normal', null);
    expect(r.summary).toContain('against the AI majority: 3 of 3 right');
    expect(r.summary).toContain('in stressed markets: 3 of 3 right');
  });
});

describe('storyline: titled moments and the timeline', () => {
  const teller = () => { const out: StoryV[] = []; return { out, t: new Storyteller(s => out.push(s), () => { }) }; };

  it('names the moment: THE FLOOR SPLITS, ALL IN', () => {
    const { t } = teller();
    const d = (id: string, action: string, conviction = 60, call = 'up') => ({ id, name: id, action, conviction, call });
    t.onRoundEnd('Big news', [d('a', 'buy'), d('b', 'buy'), d('c', 'sell'), d('d', 'sell'), d('e', 'hold', 95, 'down'), d('f', 'buy')], 'HLCN', '10:42:00', 100);
    expect(t.stories.find(s => s.kind === 'split')?.title).toBe('THE FLOOR SPLITS');
    expect(t.stories.find(s => s.kind === 'allin')).toMatchObject({ title: 'ALL IN', text: 'e is 95% sure HLCN goes DOWN and still held.' });
  });

  it('spots a reversal from the price path', () => {
    const { t } = teller();
    const path = [100, 100, 99, 98, 97.5, 97.6, 98, 98.5, 99, 99.2, 99.3, 99.4, 99.5, 99.5, 99.5, 99.6, 99.6, 99.6, 99.6, 99.6, 99.6, 99.6];
    path.forEach((px, i) => t.onPrice('HLCN', px, '10:00:00', i * 4));
    expect(t.stories.find(s => s.kind === 'reversal')).toMatchObject({ title: 'THE REVERSAL', weight: 3 });
  });

  it('humans vs machines: humans trade 1,000+ the other way within 30 s of a floor majority', () => {
    const { t } = teller();
    const d = (id: string, action: string) => ({ id, name: id, action, conviction: 60, call: 'up' });
    t.onRoundEnd('x', ['a', 'b', 'c', 'd', 'e'].map(id => d(id, 'sell')).concat(d('f', 'hold')), 'HLCN', '10:00:00', 1000);
    t.onHumanTrade('p1', 'buy', 800); t.onHumanTrade('p2', 'buy', 700);
    t.onIntel('HLCN', 'CALM', 0, 1, '10:00:30', 1130);
    expect(t.stories.find(s => s.kind === 'hva')).toMatchObject({ title: 'HUMANS VS MACHINES', text: 'The AI floor sold; 2 humans bought 1,500 the other way.' });
  });

  it('a round writes the timeline: headline, desk read, every decision; moments survive a busy timeline', async () => {
    const llm = new ScriptLLM([[JSON.stringify({ type: 'desk', impact: 3, speed: 'fast', read: 'ok' }), ...IDS.map(id => JSON.stringify({ type: 'trade', id, action: 'hold', qty: 0, conviction: 50, call: 'flat', thought: 't' }))]]);
    const room = simRoom(deps({ llm }));
    const c = new RecConn(); join(room, c, 'player-token-1', 'Brae');
    room.tell.add('halt', 'Circuit breaker.', 3, '10:00:00', 1);
    for (let i = 0; i < 25; i++) await room.runRound({ text: `News ${i}`, byName: 'Brae', origin: 'PLAYER' });
    const tl = room.tell.stories.filter(s => s.weight === 1);
    expect(tl.some(s => s.kind === 'tl:news' && /#\d+ PLAYER: “News 24”/.test(s.text))).toBe(true);
    expect(tl.some(s => s.kind === 'tl:desk' && /^Desk: [+-]\d+\.\d% to fair value, confirmed/.test(s.text))).toBe(true);
    expect(tl.some(s => s.kind === 'tl:ai:pip')).toBe(true);
    expect(room.tell.stories.length).toBeLessThanOrEqual(160);
    expect(room.tell.stories.some(s => s.kind === 'halt')).toBe(true);
    expect(c.of('story').some(m => m.s.kind === 'tl:news')).toBe(true);
  });

  it('reaction time: a human trade after a headline is timed and lands in the recap', async () => {
    const llm = new ScriptLLM([[JSON.stringify({ type: 'desk', impact: 3, speed: 'fast', read: 'ok' }), ...IDS.map(id => JSON.stringify({ type: 'trade', id, action: 'hold', qty: 0, conviction: 50, call: 'flat', thought: 't' }))]]);
    const room = simRoom(deps({ llm }));
    const c = new RecConn(); const p = join(room, c, 'player-token-1', 'Brae');
    await room.runRound({ text: 'News', byName: 'Brae', origin: 'PLAYER' });
    for (let i = 0; i < 3; i++) room.frame();
    room.playerOrder(p, 'buy', 500);
    room.playerOrder(p, 'buy', 500);    // only the first trade after a headline counts
    const r = room.recap();
    expect(r.fastest).toEqual({ name: 'Brae', secs: 0.8 });
    expect(room.tell.stories.filter(s => s.kind === 'tl:react:' + p.id)).toHaveLength(1);
  });
});

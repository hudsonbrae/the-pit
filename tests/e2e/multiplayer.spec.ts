import { test, expect, type Page, type Browser } from '@playwright/test';

async function player(browser: Browser, name: string, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(n => { try { localStorage.setItem('pit.name', n); } catch { } }, name);
  return ctx.newPage();
}
async function openRoom(page: Page, mode: 'sim' | 'real' = 'sim', ticker = '') {
  await page.goto('/');
  await page.fill('#nameIn', await page.evaluate(() => localStorage.getItem('pit.name') || 'Host'));
  if (mode === 'real') { await page.click('#modeSeg [data-m="real"]'); await page.fill('#tickerIn', ticker); }
  await page.click('#createBtn');
  await page.waitForURL(/\/r\/[A-Z]{5}$/);
  await expect(page.locator('#game')).toBeVisible();
  await expect(page.locator('#floor .agent')).toHaveCount(6);
  return page.url().split('/r/')[1];
}

test('two browsers share one book: a trade in one shows on the other\'s tape within 500 ms', async ({ browser }) => {
  const alice = await player(browser, 'Alice');
  const code = await openRoom(alice);
  const bob = await player(browser, 'Bob', { width: 390, height: 844 });   // Bob is on a phone
  await bob.goto(`/r/${code}`);
  await expect(bob.locator('#floor .agent')).toHaveCount(6);
  await expect(alice.locator('#whoLbl')).toHaveText('2 on the floor');

  // Bob watches his tape for Alice's print and timestamps when it appears.
  await bob.evaluate(() => {
    const tape = document.querySelector('#tape')!;
    const w = window as unknown as { seenAt?: number };
    new MutationObserver(() => { if (!w.seenAt && tape.textContent!.includes('Alice bought')) w.seenAt = Date.now(); })
      .observe(tape, { childList: true, subtree: true, characterData: true });
  });
  await alice.click('#sizes [data-q="2000"]');
  const sentAt = await alice.evaluate(() => { const t = Date.now(); (document.querySelector('#buyBtn') as HTMLButtonElement).click(); return t; });
  await bob.waitForFunction(() => (window as unknown as { seenAt?: number }).seenAt, null, { timeout: 5000 });
  const seenAt = await bob.evaluate(() => (window as unknown as { seenAt: number }).seenAt);
  const latency = seenAt - sentAt;
  console.log(`trade → other player's tape: ${latency} ms`);
  expect(latency).toBeLessThan(500);

  // Alice sees her own fill as "You bought"; both see each other in the standings.
  await expect(alice.locator('#tape')).toContainText('You bought');
  await expect(alice.locator('#toast')).toContainText('Bought 2,000');
  await expect(bob.locator('#stand')).toContainText('Alice');
  await expect(alice.locator('#stand')).toContainText('Bob');
  await expect(alice.locator('#yPos')).toHaveText('2,000');
  await expect(bob.locator('#stand li.me')).toContainText('You (Bob)');

  // Bob is not the host: no speed controls or host lab for him; Alice has both.
  await expect(bob.locator('#speed')).toBeHidden();
  await expect(alice.locator('#speed')).toBeVisible();
  await expect(bob.locator('#hostBtn')).toBeHidden();
  await expect(alice.locator('#hostBtn')).toBeVisible();
});

test('breaking news streams an AI round to both players and shows who triggered it', async ({ browser }) => {
  const alice = await player(browser, 'Alice');
  const code = await openRoom(alice);
  const bob = await player(browser, 'Bob');
  await bob.goto(`/r/${code}`);
  await expect(bob.locator('#floor .agent')).toHaveCount(6);
  await alice.fill('#headline', 'Halcyon wins record contract with a top utility');
  await alice.click('#breakBtn');
  await expect(bob.locator('#status')).toContainText('triggered by Alice');
  await expect(bob.locator('#breakBtn')).toBeDisabled();             // one round at a time
  await expect(bob.locator('#wire li').first()).toContainText('PLAYER');
  await expect(bob.locator('#wire li').first()).toContainText('fair value', { timeout: 15_000 });
  await expect(bob.locator('#chatter li')).toHaveCount(2, { timeout: 20_000 });
  await expect(bob.locator('#floor .agent .callrow .call').first()).toBeVisible();      // each trader's call, with conviction
  await expect(bob.locator('#floor .agent [data-sig]').first()).toBeVisible();          // the structured signal bars
  await expect(bob.locator('#breakBtn')).toBeEnabled({ timeout: 20_000 });
  await expect(bob.locator('#floor .agent .side').first()).not.toHaveText('Pre-market');
});

test('a reconnecting player gets their seat back', async ({ browser }) => {
  const alice = await player(browser, 'Alice');
  const code = await openRoom(alice);
  await alice.click('#sizes [data-q="500"]');
  await alice.click('#buyBtn');
  await expect(alice.locator('#yPos')).toHaveText('500');
  await alice.reload();
  await expect(alice.locator('#floor .agent')).toHaveCount(6);
  await expect(alice.locator('#yPos')).toHaveText('500');
  await expect(alice.locator('#roomLbl')).toContainText(code);
});

test('a Real room shows the real price beside the simulated one, labelled', async ({ browser }) => {
  const host = await player(browser, 'Brae', { width: 390, height: 844 });
  await openRoom(host, 'real', 'NVDA');
  await expect(host.locator('#realq')).toBeVisible();
  await expect(host.locator('#realPx')).toHaveText(/\d+\.\d\d/);
  await expect(host.locator('#brandSub')).toContainText('simulated exchange anchored to real price');
  await expect(host.locator('#chartTitle')).toHaveText('NVDA');
  await expect(host.locator('#wire')).toContainText('LIVE', { timeout: 15_000 });   // the latest real headline opens the room
});

test('an unknown room code says so', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pit.name', 'Zed'));
  await page.goto('/r/ZZZZZ');
  await expect(page.locator('#joinWhat')).toContainText('No room with that code');
});

test('a phone trades from the dock, and the page never scrolls sideways', async ({ browser }) => {
  const host = await player(browser, 'Alice');
  const code = await openRoom(host);
  const phone = await player(browser, 'Bob', { width: 390, height: 844 });
  await phone.goto(`/r/${code}`);
  await expect(phone.locator('#dock')).toBeVisible();
  await phone.click('#dSize');                                   // 500 -> 2,000
  await expect(phone.locator('#dSize')).toHaveText('2k');
  await phone.click('#dBuy');
  await expect(phone.locator('#dPos')).toHaveText('2,000 sh');
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('the demo: acts, a floor debate, scored calls in the storyline', async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await player(browser, 'Brae');
  await host.goto('/');
  await host.click('#demoBtn');
  await host.waitForURL(/\/r\/[A-Z]{5}$/);
  await expect(host.locator('#actTitle')).toHaveText(/ACT I/, { timeout: 15_000 });
  await expect(host.locator('#ribbonTxt')).toContainText('FLOOR DEBATE', { timeout: 40_000 });
  await expect(host.locator('#floor .opening').first()).toContainText('OPENING VIEW', { timeout: 20_000 });
  await expect(host.locator('#wire')).toContainText('SCENARIO');
  await expect(host.locator('#wire')).toContainText('DEBATED');
  await expect(host.locator('#regime')).not.toHaveText('', { timeout: 5_000 });
  await expect(host.locator('#story')).toContainText(/(called it|was \d+% sure|called \d in a row)/, { timeout: 90_000 });
});

test('a spectator watches on a big screen without a seat', async ({ browser }) => {
  const host = await player(browser, 'Alice');
  const code = await openRoom(host);
  const tv = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await tv.goto(`/r/${code}?watch=1&stage=1`);
  await expect(tv.locator('#floor .agent')).toHaveCount(6);
  await expect(tv.locator('#watchPill')).toBeVisible();
  await expect(tv.locator('#newsForm')).toBeHidden();
  await expect(tv.locator('#stageJoin')).toContainText(code);
  await expect(host.locator('#whoLbl')).toContainText('1 watching');
  await expect(host.locator('#stand')).not.toContainText('watch');
});

test('host chaos, the timeline, AI science, closing bell → Legends and "Previously on"', async ({ browser }) => {
  const host = await player(browser, 'Brae');
  await openRoom(host);
  const errors: string[] = []; host.on('pageerror', e => errors.push(String(e)));
  await host.click('#buyBtn');
  // chaos: trip the breaker from the host panel
  await host.click('#hostBtn');
  await host.click('#chaosList [data-id="chaos_halt"]');
  await expect(host.locator('#haltBanner')).toBeVisible({ timeout: 5000 });
  await expect(host.locator('#story')).toContainText('CHAOS · MARKET HALT');
  // the timeline shows the small stuff too
  await host.click('#storyTabs [data-v="timeline"]');
  await expect(host.locator('#story li').first()).toBeVisible();
  // AI science drawer
  await host.click('#sciBtn');
  await expect(host.locator('#sciBody')).toContainText('Does debate make the floor smarter?');
  await host.click('#sClose');
  // close the session: the recap names new records; the next session opens with "Previously on"
  await host.click('#hostBtn');
  await host.click('#closeBtn');
  await expect(host.locator('#recap')).toBeVisible({ timeout: 5000 });
  await expect(host.locator('#recapBody')).toContainText('New record');
  await host.click('#rNew');
  await expect(host.locator('#prev')).toBeVisible({ timeout: 5000 });
  await expect(host.locator('#prevBody')).toContainText('NEW RECORD');
  // the lobby lists the Legends
  await host.goto('/');
  await expect(host.locator('#legends')).toBeVisible();
  await expect(host.locator('#legendList')).toContainText('Wildest session');
  expect(errors).toEqual([]);
});

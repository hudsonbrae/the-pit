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

  // Bob is not the host: speed controls are disabled for him, enabled for Alice.
  await expect(bob.locator('#speed button[data-s="0"]')).toBeDisabled();
  await expect(alice.locator('#speed button[data-s="0"]')).toBeEnabled();
  await expect(bob.locator('#resetBtn')).toBeHidden();
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createApp } from '../src/server.js';

test('real server dashboard, duplicates, dead letters, export and responsive layouts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hooklab-ui-'));
  const app = createApp({
    filename: path.join(dir, 'test.sqlite'),
    timeoutMs: 150,
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, '127.0.0.1', resolve),
  );
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.origin());
    await page.getByText('LOCAL HTTP + SQLITE', { exact: true }).waitFor();
    await page
      .getByRole('button', { name: 'Run scenario', exact: true })
      .click();
    await page.getByText('10/10 delivered', { exact: true }).waitFor();
    assert.equal(await page.locator('.event-row').count(), 10);
    assert.equal(await page.locator('tbody tr').count(), 1);
    await page.getByRole('button', { name: /Exhausted retries/ }).click();
    await page
      .getByRole('button', { name: 'Run scenario', exact: true })
      .click();
    await page.getByText('3 attempts · dead', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'dead', exact: true }).click();
    assert.equal(await page.locator('.event-row').count(), 1);
    await page.getByRole('button', { name: 'All events', exact: true }).click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export evidence' }).click();
    assert.equal(
      (await downloaded).suggestedFilename(),
      'hooklab-evidence.json',
    );
    await mkdir('docs/screenshots', { recursive: true });
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => scrollTo(0, 0));
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `no overflow at ${width}`,
      );
      if (process.env.SCREENSHOTS === '1')
        await page.screenshot({
          path: `docs/screenshots/${width === 1440 ? 'desktop' : width === 375 ? 'mobile' : 'tablet'}.png`,
          fullPage: true,
        });
    }
    await page.goto(app.origin() + '/?simulation=1');
    await page.getByText('BROWSER SIMULATION', { exact: true }).waitFor();
    await page
      .getByRole('button', { name: 'Run scenario', exact: true })
      .click();
    await page.getByText('10 delivered', { exact: true }).waitFor();
    assert.equal(await page.locator('tbody tr').count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

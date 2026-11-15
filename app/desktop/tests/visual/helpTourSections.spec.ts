import { expect, test } from '@playwright/test';
import { CARD_TARGETS, MEET_TARGETS, TOUR_TARGETS } from './helpTourTargets';

// The walkthrough's order and its jumps, on the real feature pages and the offline workspace preview.
test.beforeEach(async ({ page }) => {
  await page.route('**/v1/cloud/auth/capabilities', (route) => route.fulfill({ json: { password: true, oauthProviders: ['google', 'github'], commonGroundVersion: 3, connectorsVersion: 1, memoryVersion: 3 } }));
});

for (const [tour, targets] of [
  ['grounding', MEET_TARGETS],
  ['cards', CARD_TARGETS],
  ['imports', ['settings-memory', 'memory-import-files', 'memory-import-run', 'memory-review']],
] as const) {
  test(`${tour} tour follows real feature controls without building, sharing, or importing`, async ({ page }) => {
    await page.goto(tour === 'imports' ? '/tests/visual/memorySettings.html?tour=imports&theme=light' : `/tests/visual/commonGroundPage.html?tour=${tour}&theme=light`);
    for (const [index, target] of targets.entries()) {
      await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', target, { timeout: 10000 });
      await expect(page.locator('.help-tour-card')).toBeVisible();
      await expect(page.getByText(`Step ${index + 1} of ${targets.length}`, { exact: true })).toBeVisible();
      if (index === 1) await page.screenshot({ path: test.info().outputPath(`${tour}-tour.png`) });
      // The room is always an example, even for an account with its own card and rooms.
      if (target.startsWith('grounding-room-')) {
        await expect(page.locator('[data-help-demo="grounding"]')).toBeVisible();
        await expect(page.locator(`[data-help-target="${target}"]`)).toBeVisible();
        await page.screenshot({ path: test.info().outputPath(`${tour}-${target}-example.png`) });
      }
      if (target !== 'grounding' && page.url().includes('emptyCard')) {
        await expect(page.locator('[data-help-demo="grounding"]')).toBeVisible();
        await expect(page.locator('[data-help-demo="grounding"] button').first()).toBeDisabled();
        await page.screenshot({ path: test.info().outputPath(`${tour}-${target}-example.png`) });
      }
      await page.getByRole('button', { name: index === targets.length - 1 ? 'Finish tour' : 'Next', exact: true }).click();
    }
    await expect(page.locator('.help-tour-layer')).toHaveCount(0);
    await expect(page.locator('[data-help-demo]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { featureTourActions: string[] }).featureTourActions)).toEqual([]);
  });
}

for (const theme of ['dark', 'light']) {
  test(`documents spotlight includes its label and selector in ${theme} mode`, async ({ page }) => {
    await page.goto(`/tests/visual/commonGroundPage.html?tour=cards&emptyCard=1&theme=${theme}`);
    for (const target of ['grounding', 'grounding-cards', 'grounding-new-card', 'grounding-memory']) {
      await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', target);
      await page.getByRole('button', { name: 'Next', exact: true }).click();
    }
    const spotlight = page.locator('.help-tour-spotlight');
    await expect(spotlight).toHaveAttribute('data-target', 'grounding-documents');
    const row = page.locator('[data-help-target="grounding-documents"]');
    await expect(row).toContainText('Documents');
    await expect(row).toContainText('1 chosen');
    await expect.poll(async () => {
      const target = await row.boundingBox();
      const ring = await spotlight.boundingBox();
      const card = await page.locator('.help-tour-card').boundingBox();
      if (!target || !ring || !card) return false;
      const containsRow = ring.x <= target.x && ring.y <= target.y
        && ring.x + ring.width >= target.x + target.width
        && ring.y + ring.height >= target.y + target.height;
      const besideRow = card.x + card.width <= ring.x || card.x >= ring.x + ring.width
        || card.y + card.height <= ring.y || card.y >= ring.y + ring.height;
      return containsRow && besideRow;
    }).toBe(true);
    await expect(spotlight).toHaveCSS('border-top-width', '2px');
    await page.screenshot({ path: test.info().outputPath(`documents-spotlight-${theme}.png`) });
  });
}

for (const tour of ['grounding', 'cards'] as const) {
  test(`${tour} tour uses temporary example cards through review and sharing`, async ({ page }) => {
    await page.goto(`/tests/visual/commonGroundPage.html?tour=${tour}&emptyCard=1&theme=light`);
    const targets = tour === 'grounding' ? MEET_TARGETS : CARD_TARGETS;
    for (const [index, target] of targets.entries()) {
      await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', target);
      if (target !== 'grounding' && page.url().includes('emptyCard')) {
        await expect(page.locator('[data-help-demo="grounding"]')).toBeVisible();
        await expect(page.locator('[data-help-demo="grounding"] button').first()).toBeDisabled();
        await page.screenshot({ path: test.info().outputPath(`${tour}-${target}-example.png`) });
      }
      await page.getByRole('button', { name: index === targets.length - 1 ? 'Finish tour' : 'Next', exact: true }).click();
    }
    await expect(page.locator('.help-tour-layer')).toHaveCount(0);
    await expect(page.locator('[data-help-demo]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { featureTourActions: string[] }).featureTourActions)).toEqual([]);
  });
}

test('card section continues into Grounding inside the same main tour', async ({ page }) => {
  await page.goto('/tests/visual/helpHub.html?theme=light');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Feature tours', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create and share cards', exact: true }).click();
  for (const target of CARD_TARGETS) {
    await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', target);
    if (target !== 'grounding') await expect(page.locator('[data-help-demo="grounding"]')).toBeVisible();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
  }
  await expect(page.locator('.help-tour-spotlight')).toHaveAttribute('data-target', 'grounding-pair');
  await page.getByRole('button', { name: 'Tour sections', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Tour sections' }).getByRole('button', { name: 'Import memory', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-help-demo]')).toHaveCount(0);
});

test('the whole tour clicks through the offline preview without a blank wait', async ({ page }) => {
  await page.goto('/tests/visual/helpHub.html?theme=light');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await page.getByRole('button', { name: 'Show me around' }).click();
  const card = page.locator('.help-tour-card');
  for (const [index, target] of TOUR_TARGETS.entries()) {
    // A missing control would be skipped, so every step must find its own target, and well before the 6 s wait ends.
    await expect(page.locator('.help-tour-spotlight'), target).toHaveAttribute('data-target', target, { timeout: 4000 });
    await expect(card).toHaveAttribute('data-positioned', 'true', { timeout: 4000 });
    if (target.startsWith('grounding-room-')) await expect(page.locator('[data-help-demo="grounding"]')).toContainText('Example data');
    if (target === 'grounding-room-topics') await expect(page.getByRole('button', { name: 'Start a group for Accessible interfaces' })).toBeDisabled();
    if (target === 'chat-export') await expect(page.getByRole('dialog', { name: 'Export a session' })).toBeVisible();
    await page.getByRole('button', { name: index === TOUR_TARGETS.length - 1 ? 'Finish tour' : 'Next', exact: true }).click();
  }
  await expect(page.locator('.help-tour-layer')).toHaveCount(0);
  await expect(page.locator('[data-help-demo]')).toHaveCount(0);
});

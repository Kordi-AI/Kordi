import { expect, test, type Locator, type Page } from '@playwright/test';

const box = async (locator: Locator) => {
  const value = await locator.boundingBox();
  if (!value) throw new Error('Missing element box');
  return value;
};

// Offsets of the row, its title and its status glyph from the reply text above it.
async function rowGeometry(page: Page, width: string, message: string) {
  const scope = page.locator(`[data-fixture-width="${width}"] [data-fixture-message="${message}"]`);
  const answer = await box(scope.locator('.app-live-assistant-answer-markdown').first());
  const row = scope.locator('[data-related-agent-session-id]');
  const rowBox = await box(row);
  const title = await box(row.getByRole('button', { name: /^Open background agent session/ }));
  const status = await box(row.locator('[data-related-agent-session-status]'));
  return {
    row: Math.round(rowBox.x - answer.x),
    title: Math.round(title.x - answer.x),
    // The glyph sits a fixed distance from the row's right end.
    statusFromRowEnd: Math.round(rowBox.x + rowBox.width - status.x),
  };
}

test('the background session row keeps its place and controls at any transcript width', async ({ page }) => {
  await page.goto('/tests/visual/backgroundSessionRowWidths.html');
  await expect(page.locator('[data-related-agent-session-id]')).toHaveCount(4);
  await expect(page.locator('[data-related-agent-session-status="stopped"]')).toHaveCount(4);
  // Stopped is a circle with a dash, so it never looks like a Stop button.
  await expect(page.locator('[data-related-agent-session-status="stopped"] svg path[d="M4.6 7h4.8"]')).toHaveCount(4);
  await expect(page.locator('[data-related-agent-session-status="stopped"] svg rect')).toHaveCount(0);

  const reference = await rowGeometry(page, 'wide', 'first-reply');
  // The title sits just right of the elbow, under the reply text.
  expect(reference.row).toBeGreaterThanOrEqual(0);
  expect(reference.row).toBeLessThanOrEqual(4);
  expect(reference.title).toBeGreaterThan(reference.row);
  for (const width of ['wide', 'narrow']) {
    for (const message of ['first-reply', 'second-reply']) {
      expect(await rowGeometry(page, width, message), `${width} ${message}`).toEqual(reference);
    }
  }

  for (const width of ['wide', 'narrow']) {
    const row = page.locator(`[data-fixture-width="${width}"] [data-fixture-message="first-reply"] [data-related-agent-session-id]`);
    const status = row.locator('[data-related-agent-session-status]');
    const before = { title: await box(row.getByRole('button', { name: /^Open background agent session/ })), status: await box(status) };
    await row.hover();
    // Hover adds the menu beside the glyph; nothing moves, swaps or covers the elbow.
    await expect(status).toBeVisible();
    await expect(row.getByRole('button', { name: /^More actions for/ })).toHaveCSS('opacity', '1');
    await expect(page.locator(`[data-fixture-width="${width}"] button[aria-label^="Fold "]`)).toHaveCount(0);
    expect(await box(row.getByRole('button', { name: /^Open background agent session/ }))).toEqual(before.title);
    expect(await box(status)).toEqual(before.status);

    // A stopped session offers Open only, never Stop.
    await row.getByRole('button', { name: /^More actions for/ }).click();
    await expect(row.getByRole('menuitem', { name: 'Open' })).toBeVisible();
    await expect(row.getByRole('menuitem', { name: /Stop/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
  }
});

import { expect, test, type Page } from '@playwright/test';

// A chat's Artifacts tab follows the Memory tab: the same centered empty state. With artifacts,
// a toolbar (search, cards/list switch, New menu) sits on the Memory tab's text edge, and the
// artifacts show as thumbnail cards or as one row each.

test.use({ viewport: { width: 1100, height: 700 } });

async function emptyState(page: Page, url: string, selector: string) {
  await page.goto(url);
  const block = page.locator(selector);
  await expect(block).toBeVisible();
  // Memory shows its button once the settings load; measure the finished block.
  await expect(block.getByRole('button').first()).toBeVisible();
  const label = block.locator('p');
  return {
    box: await block.boundingBox(),
    label: await label.evaluate((element) => {
      const style = getComputedStyle(element);
      return { fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color };
    }),
    labelBox: await label.boundingBox(),
    iconBox: await block.locator('svg').first().boundingBox(),
  };
}

for (const theme of ['light', 'dark'] as const) {
  test(`chat artifacts tab without artifacts matches the Memory tab (${theme})`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
    const memory = await emptyState(page, `/tests/visual/chatArtifacts.html?empty=1&tab=memory&theme=${theme}`, '[data-memory-empty]');
    const artifacts = await emptyState(page, `/tests/visual/chatArtifacts.html?empty=1&theme=${theme}`, '[data-chat-artifacts-empty]');

    const empty = page.locator('[data-chat-artifacts-empty]');
    await expect(empty.getByText('No artifacts yet', { exact: true })).toBeVisible();
    await expect(empty.getByRole('button', { name: 'New document' })).toBeVisible();
    await expect(empty.getByRole('button', { name: 'Add file' })).toHaveAttribute('title', 'Markdown and HTML documents');
    // No section heading or helper line above the empty state.
    await expect(page.locator('.app-detail-kicker')).toHaveCount(0);

    for (const key of ['x', 'y', 'width'] as const) {
      expect(Math.abs((artifacts.box?.[key] ?? 0) - (memory.box?.[key] ?? 1))).toBeLessThan(1);
      expect(Math.abs((artifacts.iconBox?.[key] ?? 0) - (memory.iconBox?.[key] ?? 1))).toBeLessThan(1);
    }
    expect(Math.abs((artifacts.labelBox?.y ?? 0) - (memory.labelBox?.y ?? 1))).toBeLessThan(1);
    expect(artifacts.label).toEqual(memory.label);
    await expect(page).toHaveScreenshot(`chatArtifacts-empty-${theme}.png`);
  });
}

async function memoryTextEdge(page: Page) {
  await page.goto('/tests/visual/chatArtifacts.html?tab=memory&theme=light');
  return (await page.locator('[data-memory-lesson]').first().boundingBox())?.x ?? -1;
}

for (const theme of ['light', 'dark'] as const) {
  test(`chat artifacts tab shows thumbnail cards (${theme})`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
    const edge = await memoryTextEdge(page);
    await page.goto(`/tests/visual/chatArtifacts.html?theme=${theme}`);
    await expect(page.locator('[data-artifact-card="true"]')).toHaveCount(14);
    // Every sample type draws a thumbnail: Markdown, HTML, JSON, Mermaid, SVG, Python, text, a PNG
    // image, TypeScript, and CSV.
    await expect(page.locator('[data-thumbnail-status="ready"]')).toHaveCount(14);
    await expect(page.locator('[data-artifact-card-title]').first()).toHaveText('Launch brief');
    await expect(page.locator('[aria-current="true"]')).toHaveCount(0);
    // Changed project files share the grid and say how they changed.
    await expect(page.locator('[data-artifact-card-change]').first()).toHaveText('Modified');

    const searchX = (await page.locator('.app-artifact-search').boundingBox())?.x ?? 0;
    const cardX = (await page.locator('[data-artifact-card="true"]').first().boundingBox())?.x ?? 0;
    for (const x of [searchX, cardX]) expect(Math.abs(x - edge)).toBeLessThan(3);
    // Let the page frame paint before the capture.
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot(`chatArtifacts-cards-${theme}.png`);
  });
}

test('the New menu holds New document and Add file', async ({ page }) => {
  await page.goto('/tests/visual/chatArtifacts.html?theme=light');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'New document' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Add file' })).toHaveAttribute('title', 'Markdown and HTML documents');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('the layout switch moves to the list and stays there after a reload (light)', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
  await page.goto('/tests/visual/chatArtifacts.html?theme=light');
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.locator('[data-artifact-file-row="true"]')).toHaveCount(14);
  await page.reload();
  await expect(page.locator('[data-artifact-file-row="true"]')).toHaveCount(14);
  await expect(page.getByRole('button', { name: 'List', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('chat artifacts list rows are one line and line up with the toolbar (light)', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
  await page.goto('/tests/visual/chatArtifacts.html?theme=light&layout=list');
  const rows = page.locator('[data-artifact-row-shell]');
  await expect(rows).toHaveCount(14);
  await expect(page.locator('[data-artifact-file-row="true"][aria-current="true"]')).toHaveCount(0);

  // Picking a row opens it in the side panel; the row's fill then runs exactly from the search
  // field's left edge to the New button's right edge.
  await page.locator('[data-artifact-file-row="true"]').nth(2).click();
  await expect(page.getByRole('complementary', { name: 'Document panel' })).toBeVisible();
  await expect(page.locator('[data-artifact-preview-section="true"]')).toHaveCount(0);
  const toolbar = await page.locator('[data-chat-document-entries="true"]').boundingBox();
  const search = await page.locator('.app-artifact-search').boundingBox();
  const picked = await rows.nth(2).boundingBox();
  expect(Math.abs((picked?.x ?? 0) - (search?.x ?? 1))).toBeLessThan(1);
  expect(Math.abs((picked?.x ?? 0) + (picked?.width ?? 0) - ((toolbar?.x ?? 0) + (toolbar?.width ?? 1)))).toBeLessThan(1);
  // One line each: a compact row.
  expect(picked?.height ?? 99).toBeLessThanOrEqual(33);

  await expect(rows.last()).toBeInViewport();
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('chatArtifacts-list-light.png');
});

test('files open in the side panel in the viewer for their type, filling it', async ({ page }) => {
  await page.goto('/tests/visual/chatArtifacts.html?theme=light&layout=cards');
  await expect(page.locator('[data-thumbnail-status="ready"]')).toHaveCount(14);
  // Inactive tabs stay mounted but hidden; check the open one.
  const panel = page.getByRole('complementary', { name: 'Document panel' }).locator('.app-companion-document-panel:not([hidden])');
  const open = (name: string) => page.locator('[data-artifact-card="true"]').filter({ hasText: name }).first().click();

  await open('headlines.ts');
  await expect(panel.locator('[data-code-viewer] .cm-content')).toContainText('export function pickHeadline');
  await expect(panel.locator('.app-document-source-info')).toHaveText('TypeScript · 14 lines');

  await open('pricing.csv');
  await expect(panel.locator('[data-table-viewer] th').nth(1)).toHaveText('Plan');
  await expect(panel.locator('.app-document-source-info')).toHaveText('CSV · 4 rows');
  await panel.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(panel.locator('[data-code-viewer]')).toBeVisible();

  await open('launch-hero.png');
  await expect(panel.locator('[data-image-viewer] img')).toBeVisible();
  await expect(panel.locator('.app-document-source-info')).toContainText('PNG image · 1200 × 675');

  // The viewer fills the panel below its one toolbar line.
  const viewer = await panel.locator('[data-image-viewer]').boundingBox();
  const pane = await panel.boundingBox();
  expect((viewer?.height ?? 0) / (pane?.height ?? 1)).toBeGreaterThan(0.85);
});

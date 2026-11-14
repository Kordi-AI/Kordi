import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 760 } });

test('the Library search menu switches between my library and community catalogs', async ({ page }) => {
  await page.goto('/tests/visual/factoryLibrary.html?theme=light');
  const rail = page.locator('.app-agent-studio-rail');
  const main = page.locator('.app-factory-inspect-main');
  await expect(main.locator('.app-factory-detail-header p')).toHaveText('Skill · Local library · v1.3.0');
  await expect(main.getByRole('switch', { name: 'Enabled' })).toHaveAttribute('aria-checked', 'true');
  await expect(rail.locator('.app-agent-studio-agent-row', { hasText: 'tikz-diagrams' })).toContainText('Disabled');
  await expect(rail.locator('.app-agent-studio-agent-row', { hasText: 'adapt' })).not.toContainText('Enabled');

  await rail.getByLabel('Show: Skills').click();
  const menu = rail.getByRole('menu', { name: 'Show in Library' });
  await expect(menu.getByRole('menuitemradio')).toHaveText(['Skills5', 'Tools3', 'Plugins0', 'ClawHub', 'skills.sh']);
  await menu.getByRole('menuitemradio', { name: 'ClawHub' }).click();
  await expect(menu).toBeHidden();

  await expect(rail.getByPlaceholder('Search ClawHub')).toBeVisible();
  await expect(rail.locator('.app-factory-rail-label')).toHaveText('Popular');
  await expect(rail.locator('.app-agent-studio-agent-row.is-community')).toHaveCount(4);
  const community = page.locator('.app-agent-studio-main').last();
  await expect(community.locator('.app-factory-detail-header h2')).toHaveText('figma-to-code');
  await expect(community.locator('.app-factory-detail-header p')).toHaveText('Skill · ClawHub · v1.0.0');
  await expect(community.getByRole('button', { name: 'Install' })).toBeEnabled();
  await expect(community.locator('.app-factory-security-notice')).toHaveCount(0);

  await rail.getByPlaceholder('Search ClawHub').fill('notion');
  await expect(rail.locator('.app-factory-rail-label')).toHaveCount(0);
  await rail.locator('.app-agent-studio-agent-row.is-community', { hasText: 'notion-sync' }).click();
  await expect(community.locator('.app-factory-security-notice')).toContainText('outside service');
});

test('skill files open full width as rendered Markdown or source', async ({ page }) => {
  await page.goto('/tests/visual/factoryLibrary.html?theme=light');
  const main = page.locator('.app-factory-inspect-main');
  await expect(main.getByRole('tab')).toHaveText(['Overview', 'SKILL.md', 'examples/before-after.md', 'references/tone-presets.md']);
  await main.getByRole('tab', { name: 'SKILL.md' }).click();
  await expect(main.locator('.app-factory-front-matter dt')).toHaveText(['name', 'description']);
  await expect(main.locator('.app-factory-markdown')).toContainText('When to use');
  const view = await main.locator('.app-factory-file-view').boundingBox();
  const pane = await main.boundingBox();
  expect(view && pane && view.width).toBe(pane?.width);
  await main.getByRole('button', { name: 'Source' }).click();
  await expect(main.locator('.app-factory-file-view.is-source pre')).toContainText('name: adapt');
});

for (const theme of ['light', 'dark'] as const) {
  test(`Factory Library matches the approved layout in ${theme}`, async ({ page }) => {
    await page.goto(`/tests/visual/factoryLibrary.html?theme=${theme}`);
    await expect(page.locator('.app-factory-overview')).toBeVisible();
    await expect(page).toHaveScreenshot(`factory-library-${theme}.png`);
    await page.goto(`/tests/visual/factoryLibrary.html?theme=${theme}&filter=community`);
    await expect(page.locator('.app-factory-overview dd').first()).toHaveText('pixel-forge');
    await expect(page.getByRole('tab', { name: 'SKILL.md' })).toBeVisible();
    await expect(page).toHaveScreenshot(`factory-library-community-${theme}.png`);
  });
}

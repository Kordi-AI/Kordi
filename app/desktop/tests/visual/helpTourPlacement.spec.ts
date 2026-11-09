import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/v1/cloud/auth/capabilities', (route) => route.fulfill({ json: { password: true, oauthProviders: ['google', 'github'], commonGroundVersion: 3, connectorsVersion: 1, memoryVersion: 3 } }));
});

test('the tour ring follows the chat theme accent and the popover sits beside wide targets', async ({ page }) => {
  await page.goto('/tests/visual/helpHub.html?theme=light&chatTheme=sand');
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await page.getByRole('button', { name: 'Show me around' }).click();
  const card = page.locator('.help-tour-card');
  const spotlight = page.locator('.help-tour-spotlight');
  await expect(card).toHaveAttribute('data-positioned', 'true');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(spotlight).toHaveAttribute('data-target', 'grounding-cards');
  // The ring uses the theme accent, not a fixed blue.
  const colors = await spotlight.evaluate((ring) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--app-accent)';
    ring.parentElement!.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { ring: getComputedStyle(ring).borderTopColor, width: getComputedStyle(ring).borderTopWidth, accent };
  });
  expect(colors.ring).toBe(colors.accent);
  expect(colors.width).toBe('2px');
  for (let index = 0; index < 5; index += 1) await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(spotlight).toHaveAttribute('data-target', 'grounding-topics');
  await expect(card).toHaveAttribute('data-positioned', 'true');
  // The card section is too wide to have room on its right, so the popover sits right below it.
  await expect.poll(async () => {
    const target = await page.locator('[data-help-target="grounding-topics"]').boundingBox();
    const popover = await card.boundingBox();
    return Boolean(target && popover && popover.y >= target.y + target.height && popover.y - (target.y + target.height) <= 30
      && Math.abs(popover.x - target.x) <= 12);
  }).toBe(true);
  await expect(page.locator('.help-tour-arrow')).toHaveAttribute('data-side', 'bottom');
  await page.screenshot({ path: test.info().outputPath('tour-topics-sand-light.png') });
});

test('the tour ring is centered on a rail icon at the window edge', async ({ page }) => {
  await page.goto('/tests/visual/helpHub.html?theme=light');
  // Match the native shell rail, whose icons sit only 4px from the window edge.
  await page.addStyleTag({ content: '.app-left-glass { padding-left: 4px !important; padding-right: 4px !important; }' });
  await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
  await page.getByRole('button', { name: 'Show me around' }).click();
  await page.getByRole('button', { name: 'Tour sections' }).click();
  await page.getByRole('navigation', { name: 'Tour sections' }).getByRole('button', { name: 'Digest', exact: true }).click();
  const spotlight = page.locator('.help-tour-spotlight');
  await expect(spotlight).toHaveAttribute('data-target', 'nav-digest');
  const target = page.locator('[data-help-target="nav-digest"]');
  await expect.poll(async () => {
    const ring = await spotlight.boundingBox();
    const icon = await target.boundingBox();
    if (!ring || !icon) return null;
    return {
      centered: Math.abs(ring.x + ring.width / 2 - (icon.x + icon.width / 2)) <= 1
        && Math.abs(ring.y + ring.height / 2 - (icon.y + icon.height / 2)) <= 1,
      outside: ring.x < icon.x && ring.y < icon.y && ring.x + ring.width > icon.x + icon.width,
    };
  }).toMatchObject({ centered: true, outside: true });
  const ring = (await spotlight.boundingBox())!;
  await page.screenshot({ path: test.info().outputPath('tour-ring-rail.png'), clip: { x: 0, y: Math.max(0, ring.y - 60), width: 240, height: 160 } });
});

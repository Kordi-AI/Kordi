import { expect, test } from '@playwright/test';

test('Personal agent entry, its agent rows, and its page states', async ({ page }) => {
  await page.goto('/tests/visual/personalAgentPreview.html?status=setup');
  const entry = page.getByTestId('personal-agent-entry');
  await expect(entry).toContainText('Not set up');
  const newTop = (await page.getByRole('button', { name: 'New session' }).boundingBox())!.y;
  expect((await entry.boundingBox())!.y).toBeGreaterThan(newTop);
  // One row per agent directly under the entry, and never also in Pinned or Recents.
  const rows = page.getByTestId('personal-agent-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Alex's Kordi");
  await expect(rows.nth(1)).toContainText('Two new papers cite your workshop draft.');
  await expect(rows.nth(2)).toContainText('No messages yet');
  const entryBox = (await entry.boundingBox())!;
  const firstRowBox = (await rows.nth(0).boundingBox())!;
  expect(firstRowBox.y).toBeGreaterThanOrEqual(entryBox.y + entryBox.height);
  expect(firstRowBox.y - (entryBox.y + entryBox.height)).toBeLessThan(16);
  await expect(page.locator('[data-agent-session-row*=":personal:"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Personal agent', exact: true })).toHaveCount(0);
  const recentsTop = (await page.getByRole('button', { name: 'Recents' }).boundingBox())!.y;
  expect((await rows.nth(2).boundingBox())!.y).toBeLessThan(recentsTop);
  await rows.nth(1).click({ button: 'right' });
  await expect(page.locator('[data-session-context-action]')).toHaveText(['Mark as read', 'Mute']);
  await page.locator('[data-session-context-action="read"]').click();
  await expect(page.locator('[data-session-context-action]')).toHaveCount(0);
  await entry.click();
  const personal = page.getByTestId('personal-agent-page');
  await expect(personal).toContainText('Add a connector to turn it on.');
  await expect(personal.getByRole('switch')).toBeDisabled();

  await page.goto('/tests/visual/personalAgentPreview.html?status=off&page=1');
  await expect(page.getByTestId('personal-agent-entry')).toContainText('Off');
  await expect(personal.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await personal.getByRole('switch').click();
  await expect(personal).toContainText('Watching 3 sources');
  await expect(page.getByTestId('personal-agent-entry')).toContainText('Watching 3 sources');

  // A reach-out opens the agent's chat; its row is the selected one.
  await personal.getByRole('button', { name: /Lab sync moved/ }).click();
  await expect(personal).toHaveCount(0);
  const header = page.locator('[data-personal-agent-header]');
  await expect(header).toContainText("Alex's Kordi");
  const chips = page.getByRole('list', { name: 'Sources' }).last().getByRole('listitem');
  await expect(chips).toHaveText([/^Calendar\s*Lab sync$/, /^GitHub\s*#412 review requested$/]);
  const row = page.locator('[data-personal-agent-row^="cloud-agent:"]');
  await expect(row).toHaveAttribute('aria-current', 'true');
  await row.click({ button: 'right' });
  await expect(page.locator('[data-session-context-action]')).toHaveText(['Mark as unread', 'Mute']);
});

import { test, expect } from '@playwright/test';

test('HCP v4 category checklist retains choices, enforces bounds, and filters secondary categories', async ({ page }) => {
  await page.goto('/tests/visual/memorySettings.html?theme=light&memoryVersion=4');
  const row = page.locator('[data-memory-lesson="lesson-1"]');
  await row.getByRole('button', { name: 'Change categories', exact: true }).click();
  await expect(row.getByRole('menuitemcheckbox', { name: 'Preference', exact: true })).toBeDisabled();
  await row.getByRole('menuitemcheckbox', { name: 'Work', exact: true }).click();
  await expect(row.getByRole('menuitemcheckbox', { name: 'Work', exact: true })).toBeChecked();
  await row.getByRole('menuitemcheckbox', { name: 'Learning', exact: true }).click();
  await expect(row.getByRole('menuitemcheckbox', { name: 'Health', exact: true })).toBeDisabled();
  await expect(row.locator('[data-memory-label="category"]')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(row.getByRole('menu')).toHaveCount(0);
  await row.locator('[data-memory-label="category"]').getByRole('button', { name: 'Learning', exact: true }).click();
  await expect(row).toBeVisible();
  await expect(page.locator('[data-memory-filter-layer="category"]').getByRole('button', { name: /^Learning/ })).toHaveAttribute('aria-pressed', 'true');
});

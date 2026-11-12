import { expect, test } from '@playwright/test';
import { detail, openAddAccount, openPreview, openProvider, pickerRows } from './authProviderHelpers';

test('provider sign-in and onboarding use the selected workspace palette', async ({ page }) => {
  await openPreview(page, 'start', { theme: 'dark', chatTheme: 'ocean' });
  const gate = page.locator('.app-auth-gate-shell');
  const gateBackground = await gate.evaluate((element) => {
    const reference = document.createElement('span');
    reference.style.backgroundColor = 'var(--app-main-bg)';
    element.append(reference);
    const expected = getComputedStyle(reference).backgroundColor;
    reference.remove();
    return expected;
  });
  await expect(gate).toHaveCSS('background-color', gateBackground);

  await openProvider(page, 'openai', 'OpenAI');
  await openAddAccount(page);
  await pickerRows(page).filter({ hasText: /^ChatGPT browser sign-in/ }).click();
  await expect(detail(page).getByRole('button', { name: 'Sign in', exact: true })).toHaveCSS('background-color', 'rgb(161, 203, 209)');

  await openPreview(page, 'login', { provider: 'cerebras', theme: 'light', chatTheme: 'ocean' });
  await detail(page).getByLabel('API key', { exact: true }).fill('synthetic-test-key');
  await expect(detail(page).getByRole('button', { name: 'Save', exact: true })).toHaveCSS('background-color', 'rgb(36, 103, 117)');
});

test('the standalone provider window follows saved appearance and system mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => {
    localStorage.setItem('kordi.themeMode.v1', 'light');
    localStorage.setItem('kordi.chatTheme.v2', 'sand');
  });
  await page.goto('/?authPopup=1&provider=openai&mode=api-key');
  const popup = page.locator('.kordi-app');
  const panel = popup.locator('.app-auth-popup-panel');
  await expect(popup).toHaveClass(/theme-light/);
  await expect(page.locator('body')).toHaveAttribute('data-kordi-chat-theme', 'sand');
  const lightPanel = await panel.evaluate(element => getComputedStyle(element).backgroundColor);

  // Another window writes the shared settings while this one stays open.
  const settings = await page.context().newPage();
  await settings.goto('/tests/visual/authProviderConfig.html');
  await settings.evaluate(() => {
    localStorage.setItem('kordi.themeMode.v1', 'auto');
    localStorage.setItem('kordi.chatTheme.v2', 'ocean');
  });
  await expect(popup).toHaveClass(/theme-dark/);
  await expect(page.locator('body')).toHaveAttribute('data-kordi-chat-theme', 'ocean');
  await expect(panel).not.toHaveCSS('background-color', lightPanel);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(popup).toHaveClass(/theme-light/);
  await settings.close();
});

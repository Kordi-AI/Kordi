import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark']) {
  test(`signed out, the window shows the welcome screen at viewport size and no credential form in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 760 });
    await page.goto(`/tests/visual/authTransitions.html?theme=${theme}`);
    const logIn = page.getByRole('button', { name: 'Log in', exact: true });
    const signUp = page.getByRole('button', { name: 'Sign up', exact: true });
    await expect(logIn).toBeInViewport({ ratio: 1 });
    await expect(signUp).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.app-cloud-login-page')).toHaveJSProperty('clientHeight', 760);
    await expect(page.locator('input, form')).toHaveCount(0);
    // This preview has no native shell, so sign-in cannot start here.
    await expect(page.getByRole('status')).toHaveText('Sign-in is unavailable in this window.');
    await logIn.click();
    await expect(page.getByRole('alert')).toHaveText('Sign-in is unavailable in this window.');
    await expect(page.locator('input, form')).toHaveCount(0);
    await expect(logIn).toBeEnabled();
    await expect(signUp).toBeEnabled();
    await page.screenshot({ path: `test-results/auth-transition-welcome-${theme}.png` });
  });
}

test('loading bird stays centered as the workspace contracts to the login window', async ({ page }) => {
  await page.goto('/tests/visual/authTransitions.html?loading=1');
  const dots = page.locator('.app-cloud-starting-bird');
  await expect(dots).toBeVisible();
  for (const size of [
    { width: 1480, height: 980 }, { width: 1200, height: 900 },
    { width: 960, height: 820 }, { width: 760, height: 760 },
  ]) {
    await page.setViewportSize(size);
    await expect.poll(async () => {
      const bounds = await dots.boundingBox();
      return bounds ? Math.abs(bounds.x + bounds.width / 2 - size.width / 2)
        + Math.abs(bounds.y + bounds.height / 2 - size.height / 2) : Infinity;
    }).toBeLessThan(1);
  }
  await expect(page.locator('.app-cloud-starting-screen')).toHaveText('');
});

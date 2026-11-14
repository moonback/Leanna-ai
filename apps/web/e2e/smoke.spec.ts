import { expect, test } from '@playwright/test';

test('shell loads and reaches the real API', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bienvenue sur LEANA' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(/API connectée/);
});

test('navigation works on the current viewport', async ({ page, isMobile }) => {
  await page.goto('/inconnu');
  await expect(page.getByRole('heading', { name: 'Page introuvable' })).toBeVisible();

  if (isMobile) {
    await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
  }
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Bienvenue sur LEANA' })).toBeVisible();
  // The mobile drawer closes after navigating.
  await expect(page.getByRole('button', { name: 'Fermer le menu' })).toHaveCount(0);
});

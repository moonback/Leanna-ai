// Full stack without an AI key: missions cannot run, and the UI says so instead of
// pretending. The full mission cycle (plan, approvals, worker, crash recovery) is proved by
// apps/api/test/missions.integration.test.ts against real Redis and Postgres.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

async function go(page: Page, isMobile: boolean, module: string | RegExp) {
  if (isMobile) await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
  await page
    .getByRole('navigation', { name: 'Navigation principale' })
    .getByRole('link', { name: module })
    .click();
}

test('missions, activity and notifications without an AI key', async ({ page, isMobile }) => {
  await page.goto('/signup');
  await page.getByLabel('Nom affiché').fill('Missionnaire');
  await page.getByLabel('E-mail').fill(`e2e-${randomUUID()}@example.test`);
  await page.getByLabel('Mot de passe').fill(`Pw-${randomUUID()}`);
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page.getByRole('heading', { name: 'Bonjour, Missionnaire' })).toBeVisible();
  await expect(page.getByText('Aucune mission en cours.')).toBeVisible();

  await go(page, isMobile, 'Missions');
  await expect(page.getByText(/ne sont pas configurées sur ce serveur/)).toBeVisible();
  await expect(page.getByLabel('Nouvelle mission')).toBeDisabled();
  await expect(page.getByText('Aucune mission pour l’instant.')).toBeVisible();

  await go(page, isMobile, 'Activité');
  await expect(page.getByText('Aucune activité enregistrée.')).toBeVisible();
  await go(page, isMobile, /^Notifications/);
  await expect(page.getByText('Aucune notification.')).toBeVisible();
});

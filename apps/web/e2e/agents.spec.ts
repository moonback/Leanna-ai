// Full stack (no AI key needed): an agent is created, given tools, edited and deleted
// through the real API and database, which validates every tool name.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

async function go(page: Page, isMobile: boolean, module: string) {
  if (isMobile) await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
  await page
    .getByRole('navigation', { name: 'Navigation principale' })
    .getByRole('link', { name: module })
    .click();
}

test('Agent Studio: create, edit and delete an agent', async ({ page, isMobile }) => {
  await page.goto('/signup');
  await page.getByLabel('Nom affiché').fill('Studio');
  await page.getByLabel('E-mail').fill(`e2e-${randomUUID()}@example.test`);
  await page.getByLabel('Mot de passe').fill(`Pw-${randomUUID()}`);
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page.getByRole('heading', { name: 'Bonjour, Studio' })).toBeVisible();

  await go(page, isMobile, 'Agent Studio');
  const form = page.getByRole('form', { name: 'Créer un agent' });
  await form.getByLabel('Nom').fill('Scribe');
  await form.getByRole('checkbox', { name: /memory\.remember/ }).check();
  await form.getByRole('checkbox', { name: /memory\.search/ }).check();
  await form.getByRole('button', { name: 'Créer l’agent' }).click();

  const list = page.getByRole('region', { name: 'Mes agents' });
  await expect(list.getByText('Outils : memory.remember, memory.search')).toBeVisible();
  await expect(list.getByText('Demande votre validation avant chaque écriture.')).toBeVisible();

  await list.getByRole('button', { name: 'Modifier Scribe' }).click();
  await list.getByRole('checkbox', { name: /Écrire sans demander/ }).check();
  await list.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(list.getByText('Écrit sans demander votre validation.')).toBeVisible();
  await page.reload();
  await expect(list.getByText('Écrit sans demander votre validation.')).toBeVisible();

  // The agent is offered when launching a mission.
  await go(page, isMobile, 'Missions');
  await expect(page.getByLabel('Agent').getByRole('option', { name: /Scribe/ })).toHaveCount(1);

  await go(page, isMobile, 'Agent Studio');
  page.once('dialog', (d) => d.accept());
  await list.getByRole('button', { name: 'Supprimer Scribe' }).click();
  await expect(list.getByText(/Aucun agent/)).toBeVisible();
});

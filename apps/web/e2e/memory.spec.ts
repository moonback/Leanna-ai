// Full stack: real browser, real API, real local Supabase. No AI provider is needed:
// memories are added by hand and searched lexically (semantic search needs embeddings).
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

async function go(page: Page, isMobile: boolean, module: string) {
  if (isMobile) await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
  await page
    .getByRole('navigation', { name: 'Navigation principale' })
    .getByRole('link', { name: module })
    .click();
}

test('memory: teach, search, correct, delete, and turn off', async ({ page, isMobile }) => {
  await page.goto('/signup');
  await page.getByLabel('Nom affiché').fill('Mémo');
  await page.getByLabel('E-mail').fill(`e2e-${randomUUID()}@example.test`);
  await page.getByLabel('Mot de passe').fill(`Pw-${randomUUID()}`);
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page.getByRole('heading', { name: 'Bonjour, Mémo' })).toBeVisible();

  await go(page, isMobile, 'Mémoire');
  await expect(page.getByText(/LEANA ne sait encore rien de vous/)).toBeVisible();

  const teach = async (content: string, kind: string) => {
    await page.getByLabel('Ce que LEANA doit retenir').fill(content);
    await page.getByLabel('Type').selectOption({ label: kind });
    await page.getByRole('button', { name: 'Retenir' }).click();
    await expect(page.getByLabel('Ce que LEANA doit retenir')).toHaveValue('');
  };
  await teach('Habite à Paris', 'Fait');
  await teach('Préfère les réponses courtes', 'Préférence');
  const list = page.getByRole('region', { name: 'Souvenirs' });
  await expect(list.getByText('Habite à Paris')).toBeVisible();
  await expect(list.getByText('Préfère les réponses courtes')).toBeVisible();

  // Duplicates are refused, whatever the case.
  await page.getByLabel('Ce que LEANA doit retenir').fill('habite à paris');
  await page.getByRole('button', { name: 'Retenir' }).click();
  await expect(page.getByRole('alert')).toHaveText('LEANA le sait déjà.');

  // Search goes through the SQL hybrid recall (accents and word forms ignored here).
  await page.getByLabel('Rechercher dans la mémoire').fill('preferer reponse');
  await page.getByRole('button', { name: 'Rechercher' }).click();
  await expect(list.getByText('Préfère les réponses courtes')).toBeVisible();
  await expect(list.getByText('Habite à Paris')).toBeHidden();
  await page.getByLabel('Rechercher dans la mémoire').fill('');

  // Correct, then delete; both persist across a reload.
  await list.getByRole('button', { name: 'Corriger « Habite à Paris »' }).click();
  await page.getByLabel('Corriger le souvenir').fill('Habite à Lyon');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(list.getByText('Habite à Lyon')).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await list.getByRole('button', { name: 'Supprimer « Préfère les réponses courtes »' }).click();
  await expect(list.getByText('Préfère les réponses courtes')).toBeHidden();
  await page.reload();
  await expect(list.getByText('Habite à Lyon')).toBeVisible();
  await expect(list.getByText('Préfère les réponses courtes')).toBeHidden();

  // Turning memory off is reflected on the memory page.
  await go(page, isMobile, 'Paramètres');
  const toggle = page.getByRole('checkbox', { name: 'Activer la mémoire' });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await go(page, isMobile, 'Mémoire');
  await expect(page.getByText(/La mémoire est désactivée/)).toBeVisible();
});

// Full stack: real browser, real API, real local Supabase (see README → Tests).
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const password = `Pw-${randomUUID()}`;

async function openNav(page: Page, isMobile: boolean) {
  if (isMobile) await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
}

async function signUp(page: Page, name: string) {
  const email = `e2e-${randomUUID()}@example.test`;
  await page.getByLabel('Nom affiché').fill(name);
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page.getByRole('heading', { name: `Bonjour, ${name}` })).toBeVisible();
  return email;
}

test('account lifecycle: signup, profile, logout, login', async ({ page, isMobile }) => {
  // Protected routes send signed-out visitors to the login page.
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();

  // Signup lands on the dashboard; the API answers with the user's token.
  await page.getByRole('link', { name: 'Créer un compte' }).click();
  const email = await signUp(page, 'Testeur E2E');
  await expect(page.getByRole('status').filter({ hasText: 'API' })).toHaveText(/API connectée/);

  // Profile changes go through the API and persist across reloads.
  await openNav(page, isMobile);
  await page.getByRole('link', { name: 'Paramètres' }).click();
  await expect(page.getByText('Espace personnel')).toBeVisible();
  await expect(page.getByText('Propriétaire')).toBeVisible();
  await page.getByLabel('Nom affiché').fill('Testeur Renommé');
  await page.getByLabel('Fuseau horaire').selectOption('America/Toronto');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Profil enregistré.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Nom affiché')).toHaveValue('Testeur Renommé');
  await expect(page.getByLabel('Fuseau horaire')).toHaveValue('America/Toronto');

  // Logout, then a wrong password is refused with a readable message.
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Mot de passe').fill('wrong-password');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('alert')).toHaveText('E-mail ou mot de passe incorrect.');

  // Correct credentials restore the session and the saved profile.
  await page.getByLabel('Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('heading', { name: 'Bonjour, Testeur Renommé' })).toBeVisible();
});

test('unknown routes show a not-found page inside the shell', async ({ page }) => {
  await page.goto('/signup');
  await signUp(page, 'Visiteur');

  await page.goto('/inconnu');
  await expect(page.getByRole('heading', { name: 'Page introuvable' })).toBeVisible();
  await page.getByRole('link', { name: 'Retour au tableau de bord' }).click();
  await expect(page.getByRole('heading', { name: 'Bonjour, Visiteur' })).toBeVisible();
});

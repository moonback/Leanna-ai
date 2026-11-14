// Full stack. If the running API has a Gemini key (from .env or the environment) this
// talks to the real Gemini API; otherwise it checks the honest "not configured" state.
// The running server decides, as reported by the UI, not a guess from config files.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

/** Signs up, opens the assistant and returns whether the server reports AI as configured. */
async function signUpAndOpenAssistant(page: Page, isMobile: boolean) {
  await page.goto('/signup');
  await page.getByLabel('Nom affiché').fill('Testeur IA');
  await page.getByLabel('E-mail').fill(`e2e-${randomUUID()}@example.test`);
  await page.getByLabel('Mot de passe').fill(`Pw-${randomUUID()}`);
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page.getByRole('heading', { name: 'Bonjour, Testeur IA' })).toBeVisible();
  if (isMobile) await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
  await page.getByRole('link', { name: 'Assistant' }).click();
  await expect(page.getByRole('heading', { name: 'Que puis-je faire pour vous ?' })).toBeVisible();

  const banner = page.getByText(/n’est pas configuré sur ce serveur/);
  const composer = page.getByLabel('Message pour LEANA');
  await expect
    .poll(async () => (await banner.isVisible()) || (await composer.isEnabled()))
    .toBe(true);
  return !(await banner.isVisible());
}

test('without an AI key the assistant says so and cannot send', async ({ page, isMobile }) => {
  const configured = await signUpAndOpenAssistant(page, isMobile);
  test.skip(configured, 'The server has a Gemini key: the real-chat test covers this run.');
  await expect(page.getByLabel('Message pour LEANA')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Envoyer' })).toBeDisabled();
});

test('chat with LEANA through the real Gemini API', async ({ page, isMobile }) => {
  test.setTimeout(120_000);
  const configured = await signUpAndOpenAssistant(page, isMobile);
  test.skip(!configured, 'The server has no Gemini key: real chat NOT verified.');

  const log = page.getByRole('log', { name: 'Messages' });
  const composer = page.getByLabel('Message pour LEANA');
  const assistantBubbles = log.locator('[data-role="assistant"]');

  await composer.fill('Réponds uniquement par le mot « banane », sans ponctuation.');
  await composer.press('Enter');
  await expect(page).toHaveURL(/\/assistant\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  await expect(page.getByRole('log', { name: 'Messages' })).toHaveAttribute('aria-busy', 'false');
  await expect(assistantBubbles.first()).toContainText(/banane/i);
  await expect(log.getByText(/n’a pas répondu|indisponible|refusée/)).toHaveCount(0);

  // A follow-up uses the history and the conversation survives a reload.
  await composer.fill('Répète exactement le mot que tu viens d’écrire.');
  await composer.press('Enter');
  await expect(assistantBubbles).toHaveCount(2, { timeout: 60_000 });
  await expect(log).toHaveAttribute('aria-busy', 'false');
  await expect(assistantBubbles.nth(1)).toContainText(/banane/i);

  await page.reload();
  await expect(page.getByRole('log', { name: 'Messages' }).locator('[data-role]')).toHaveCount(4);
});

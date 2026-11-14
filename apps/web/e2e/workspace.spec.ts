// Phase 7 proof — full stack CRUD: projects, tasks, documents and calendar events go
// through the real API and database and survive a reload.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

async function go(page: Page, isMobile: boolean, module: string) {
  if (isMobile) await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
  await page
    .getByRole('navigation', { name: 'Navigation principale' })
    .getByRole('link', { name: module })
    .click();
}

const localInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

test.beforeEach(async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Nom affiché').fill('Organisée');
  await page.getByLabel('E-mail').fill(`e2e-${randomUUID()}@example.test`);
  await page.getByLabel('Mot de passe').fill(`Pw-${randomUUID()}`);
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page.getByRole('heading', { name: 'Bonjour, Organisée' })).toBeVisible();
});

test('projects and tasks: create, edit, complete, filter, delete', async ({ page, isMobile }) => {
  await go(page, isMobile, 'Projets');
  await page.getByLabel('Nom du projet').fill('Déménagement');
  await page.getByRole('button', { name: 'Créer le projet' }).click();
  const projects = page.getByRole('region', { name: 'Liste des projets' });
  await expect(projects.getByText('Déménagement')).toBeVisible();

  await go(page, isMobile, 'Tâches');
  const add = page.getByRole('form', { name: 'Ajouter une tâche' });
  await add.getByLabel('Nouvelle tâche').fill('Résilier le bail');
  await add.getByLabel('Priorité').selectOption({ label: 'Urgente' });
  await add.getByLabel('Échéance').fill(localInput(new Date(Date.now() + 2 * 86_400_000)));
  await add.getByLabel('Projet').selectOption({ label: 'Déménagement' });
  await add.getByRole('button', { name: 'Ajouter' }).click();
  await expect(page.getByText('Résilier le bail')).toBeVisible();
  await expect(add.getByLabel('Priorité')).toHaveValue('normal'); // reset after each add
  await add.getByLabel('Projet').selectOption({ label: 'Aucun' });
  await add.getByLabel('Nouvelle tâche').fill('Acheter des cartons');
  await add.getByRole('button', { name: 'Ajouter' }).click();

  const list = page.getByRole('region', { name: 'Liste des tâches' });
  await expect(list.getByText('Résilier le bail')).toBeVisible();
  await expect(list.getByText('Urgente')).toBeVisible();
  await expect(list.getByText('· Déménagement')).toBeVisible();

  // Edit
  await list.getByRole('button', { name: 'Modifier « Acheter des cartons »' }).click();
  await list.getByLabel('Titre').fill('Acheter 30 cartons');
  await list.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(list.getByText('Acheter 30 cartons')).toBeVisible();

  // Complete: leaves the open list, appears under « Terminées », persists.
  await list.getByRole('checkbox', { name: 'Terminer « Acheter 30 cartons »' }).check();
  await expect(list.getByText('Acheter 30 cartons')).toBeHidden();
  await page.reload();
  await page.getByRole('tab', { name: 'Terminées' }).click();
  await expect(list.getByText('Acheter 30 cartons')).toBeVisible();

  // Filter by project
  await page.getByRole('tab', { name: 'Toutes' }).click();
  await page.getByLabel('Filtrer par projet').selectOption({ label: 'Déménagement' });
  await expect(list.getByText('Résilier le bail')).toBeVisible();
  await expect(list.getByText('Acheter 30 cartons')).toBeHidden();

  // Delete
  page.once('dialog', (d) => d.accept());
  await list.getByRole('button', { name: 'Supprimer « Résilier le bail »' }).click();
  await expect(list.getByText('Aucune tâche ici.')).toBeVisible();

  // Archive then delete the project
  await go(page, isMobile, 'Projets');
  await projects.getByRole('button', { name: 'Archiver Déménagement' }).click();
  await expect(projects.getByText('Aucun projet.')).toBeVisible();
  await page.getByLabel('Afficher les projets archivés').check();
  page.once('dialog', (d) => d.accept());
  await projects.getByRole('button', { name: 'Supprimer Déménagement' }).click();
  await expect(projects.getByText('Aucun projet.')).toBeVisible();
});

test('documents: create, write, search, delete', async ({ page, isMobile }) => {
  await go(page, isMobile, 'Documents');
  await page.getByRole('button', { name: 'Nouveau document' }).click();
  await page.getByLabel('Titre').fill('Inventaire du salon');
  await page.getByLabel('Contenu').fill('Canapé, bibliothèque et vaisselle fragile.');
  await expect(page.getByText(/Modifications non enregistrées/)).toBeVisible();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText(/^Enregistré/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Contenu')).toHaveValue(
    'Canapé, bibliothèque et vaisselle fragile.',
  );

  await page.getByRole('link', { name: 'Documents' }).first().click();
  await page.getByLabel('Rechercher dans les documents').fill('vaisselles');
  await page.getByRole('button', { name: 'Rechercher' }).click();
  const results = page.getByRole('region', { name: 'Liste des documents' });
  await expect(results.getByText('Inventaire du salon')).toBeVisible();
  await expect(results.getByText(/«vaisselle»/)).toBeVisible();

  await results.getByText('Inventaire du salon').click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Supprimer' }).click();
  await expect(page.getByText('Aucun document.')).toBeVisible();
});

test('calendar: add an event, see it in its week and on the dashboard, delete it', async ({
  page,
  isMobile,
}) => {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(14, 30, 0, 0);
  const end = new Date(start.getTime() + 90 * 60_000);

  await go(page, isMobile, 'Calendrier');
  const form = page.getByRole('form', { name: 'Nouvel événement' });
  await form.getByLabel('Titre').fill('Camion de location');
  await form.getByLabel('Lieu (facultatif)').fill('Lyon');
  await form.getByLabel('Début').fill(localInput(start));
  await form.getByLabel('Fin').fill(localInput(end));
  await form.getByRole('button', { name: 'Ajouter à l’agenda' }).click();

  await expect(form.getByLabel('Titre')).toHaveValue('');
  const week = page.getByRole('region', { name: 'Semaine' });
  // Weeks start on Monday: tomorrow is in next week when today is Sunday.
  const nextWeek = new Date().getDay() === 0;
  if (nextWeek) await week.getByRole('button', { name: 'Semaine suivante' }).click();
  await expect(week.getByText('Camion de location')).toBeVisible();
  await expect(week.getByText('14:30 – 16:00')).toBeVisible();
  await expect(week.getByText('Lyon')).toBeVisible();

  await go(page, isMobile, 'Dashboard');
  await expect(
    page.getByRole('region', { name: 'Agenda' }).getByText('Camion de location'),
  ).toBeVisible();

  await go(page, isMobile, 'Calendrier');
  if (nextWeek) await week.getByRole('button', { name: 'Semaine suivante' }).click();
  page.once('dialog', (d) => d.accept());
  await week.getByRole('button', { name: 'Supprimer « Camion de location »' }).click();
  await expect(week.getByText('Camion de location')).toBeHidden();
});

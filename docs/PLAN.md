# Plan d'exécution — LEANA AI

« Terminé » = `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` verts **+ une preuve nommée**.

| Phase | Contenu                                                                                       | Preuve                                                          | Dépendances externes   |
| ----- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------- |
| 1     | Monorepo, design system, shell (sidebar/header), Dashboard vide réel, API `/health` + OpenAPI | Vitest + Playwright smoke du shell                              | aucune                 |
| 2     | Supabase init, migrations (profiles, workspaces, memberships…), RLS, auth UI                  | `supabase test db` (isolation entre 2 users) + E2E signup/login | **Docker**             |
| 3     | AI Gateway (1 provider réel derrière une interface), conversations, streaming SSE             | tests gateway (fake injecté) + E2E chat avec clé réelle         | **clé IA**             |
| 4     | Memory Engine (pgvector, hybride, contradictions), Context Engine                             | tests SQL + unitaires                                           | Docker, clé embeddings |
| 5     | Mission Engine + worker BullMQ, approvals, activity log                                       | test cycle complet + reprise après crash                        | Docker (Redis)         |
| 6     | Agent Studio, registre d'outils typés                                                         | tests permissions outils                                        | —                      |
| 7     | Tâches, projets, documents, calendrier                                                        | E2E CRUD                                                        | —                      |
| 8     | Connecteurs OAuth, automatisations, Web Intelligence                                          | tests intégration                                               | comptes OAuth          |
| 9     | Stripe, rate limiting, observabilité                                                          | tests webhooks Stripe (mode test)                               | clés Stripe test       |
| 10    | E2E complets, durcissement, guide de déploiement                                              | suite Playwright complète                                       | —                      |

## Checklist Phase 1

- [x] Workspace pnpm (`apps/web`, `apps/api`) — `packages/shared` reporté à la Phase 2 (premier contrat partagé)
- [x] `.gitattributes`, Prettier, ESLint, tsconfig base
- [x] Design tokens (palette) + composants de base
- [x] App shell : sidebar (modules non implémentés affichés désactivés « Bientôt »), header, tiroir mobile
- [x] Dashboard avec états vides réels (aucune donnée fictive)
- [x] API Fastify `/health` + OpenAPI `/docs`
- [x] Tests Vitest (4 API + 5 web) + Playwright smoke (4 : desktop + mobile, vraie API)
- [x] lint / typecheck / test / build verts

## Checklist Phase 2

- [x] Supabase local (ports 593xx pour cohabiter avec d'autres projets locaux)
- [x] Migration `foundations` : profiles, workspaces, memberships, preferences, consents
- [x] RLS sur toutes les tables, `GRANT` explicites (rien pour `anon`), helpers `security definer` dans le schéma non exposé `private`
- [x] Triggers : compte → profil + espace personnel (owner) + préférences ; suppression RGPD sans workspace orphelin
- [x] `supabase db advisors` : aucune alerte
- [x] **Preuve** : pgTAP `supabase/tests/database/rls_isolation.test.sql` (29 assertions : isolation entre 2 utilisateurs, validation en base)
- [x] API : vérification JWT (`getClaims`), client Supabase agissant au nom de l'utilisateur, `GET /me`, `PATCH /me/profile` (validation zod)
- [x] Web : inscription, connexion, déconnexion, routes protégées (sans open redirect), Paramètres (profil, espaces)
- [x] **Preuve** : E2E Playwright inscription → profil → déconnexion → connexion (desktop + mobile, stack réelle)
- [ ] `packages/shared` : toujours reporté (un seul contrat `/me`, dupliqué en types web) — à créer en Phase 3
- [ ] Hors périmètre Phase 2 : réinitialisation du mot de passe, invitations dans un workspace, consentements dans l'UI, export RGPD

## Checklist Phase 3

- [x] Migration `assistant` : conversations, messages, journal `ai_usage` (ajout seul), fonction de quota `security invoker`
- [x] **Preuve** : pgTAP `assistant.test.sql` (22 assertions : isolation, contraintes, immuabilité, suppression RGPD)
- [x] AI Gateway : interface fournisseur + adaptateur Gemini, liste blanche, timeout, nouvelles tentatives avant le premier fragment, erreurs normalisées, journaux sans contenu
- [x] API : conversations (CRUD), envoi en SSE, quota quotidien, préférence de modèle, 503 explicite sans clé
- [x] Web : module Assistant (liste, fil, streaming, arrêt, états non configuré, quota et erreur), choix du modèle dans Paramètres
- [x] **Preuve** : E2E dialogue réel avec Gemini (desktop + mobile : réponse, suite avec historique, persistance après rechargement)
- [ ] Bascule automatique vers un modèle de secours quand le modèle choisi est surchargé
- [ ] `packages/shared` toujours reporté (contrats dupliqués en types web)

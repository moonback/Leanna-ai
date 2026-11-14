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

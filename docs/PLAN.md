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
- [x] Second fournisseur **OpenRouter** (adaptateur fetch, erreurs en cours de flux, 402) ; choix fournisseur + modèle dans Paramètres, validé côté serveur
- [ ] **Preuve OpenRouter réelle** : E2E prêt, ignoré tant que `OPENROUTER_API_KEY` est absente
- [ ] Bascule automatique vers un modèle de secours quand le modèle choisi est surchargé
- [ ] `packages/shared` toujours reporté (contrats dupliqués en types web)

## Checklist Phase 4

- [x] Migration `memory` : pgvector (768 d), table `memories` (RLS, `GRANT` par colonne, références vérifiées contre l'appelant), recherche plein texte française sans accents, résumés de conversation, `ai_usage.kind`
- [x] Rappel hybride en SQL (`match_memories`) : plein texte + cosinus, fusion RRF, seuil de distance, vecteurs comparés par modèle
- [x] Contradictions : `update` remplace (ancien `superseded`, restaurable), `forget` archive ; jamais rappelés
- [x] **Preuve** : pgTAP `memory.test.sql` (28 assertions : isolation, contraintes, rappel lexical/sémantique/fusionné, contradictions, résumés) — `supabase db advisors` sans alerte
- [x] Embeddings derrière une interface : Gemini (`RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY`) et OpenRouter ; repli lexical en cas d'échec ; réindexation
- [x] Extraction en un appel, en parallèle de la réponse ; analyse défensive (ids connus seulement, doublons, plafond)
- [x] Context Engine : budgets, souvenirs comme données, résumé glissant en tâche de fond, coupe de sécurité
- [x] **Preuve** : tests unitaires (Context Engine, extraction, adaptateurs d'embeddings) + intégration contre Supabase local (12 scénarios de bout en bout)
- [x] Web : page Mémoire (ajout, recherche, correction, historique, restauration, suppression, tout effacer), interrupteur dans Paramètres, note « Retenu : … » dans le chat
- [x] E2E Playwright Mémoire (desktop + mobile, stack réelle, sans IA)
- [ ] **Calibrage réel** : seuil `MEMORY_MAX_DISTANCE` et qualité d'extraction à mesurer avec une clé Gemini / OpenRouter
- [ ] `packages/shared` toujours reporté (contrats dupliqués en types web)

## Checklist Phase 5

- [x] Migration `missions` : missions, étapes, validations, journal d'activité, notifications ; rôle `leana_worker` (sans `BYPASSRLS`, droits par colonne) ; machine à états en trigger ; journal et notifications écrits par triggers uniquement
- [x] **Preuve** : pgTAP `missions.test.sql` (37 assertions : isolation, droits utilisateur vs worker, transitions interdites, décision unique, écriture « zombie » refusée, journal infalsifiable) — `supabase db advisors` sans alerte
- [x] Mission Engine : planification, validation du plan, étapes ordonnées, validation par étape, quota, liste blanche des modèles, erreurs définitives vs transitoires
- [x] Worker BullMQ : un seul processeur par mission (verrou consultatif), tentatives clôturées, reprise des jobs abandonnés, balayage des missions orphelines, arrêt propre
- [x] API : `/missions` (+ annulation), `/approvals` (+ décision), `/activity`, `/notifications` (+ lu)
- [x] **Preuve** : tests d'intégration contre Redis + Postgres réels : cycle complet, refus, annulation pendant une étape, panne transitoire puis reprise, erreur fatale, plan inexploitable, **crash d'un worker en pleine étape** (reprise en tentative 2, écriture tardive refusée), job perdu rattrapé
- [x] Web : Missions (création, suivi en direct, validations, arrêt), Activité, Notifications (badge), tableau de bord avec données réelles
- [x] E2E Playwright (desktop + mobile, sans clé IA : état « non configuré »)
- [ ] **Preuve réelle** : mission de bout en bout avec un vrai fournisseur IA (aucune clé disponible)
- [ ] Notifications en temps réel (Supabase Realtime ou SSE) au lieu du rafraîchissement périodique
- [ ] `packages/shared` toujours reporté (contrats dupliqués en types web)

## Checklist Phase 6

- [x] Migration `agents` : catalogue `tools`, `agents` (outils validés, écriture autonome optionnelle), `tool_calls`, validations de type `tool`. Une **barrière de permissions en trigger** contrôle chaque appel : outil autorisé à cet instant, validation pour `write`, toujours pour `sensitive`, appel lié au propriétaire et à une étape en cours. Fonctions `private.tool_*` liées à un appel en cours
- [x] **Preuve** : pgTAP `agents.test.sql` (36 assertions : isolation, outils inconnus, outil hors liste, usurpation d'agent, validation des écritures, `auto_write`, `sensitive`, révocation immédiate, accès aux données limité au propriétaire, appels terminés inertes)
- [x] Registre typé (5 outils), protocole JSON neutre vis-à-vis du fournisseur, calculatrice sans `eval`
- [x] Moteur : boucle d'outils par étape, refus et entrées invalides enregistrés et signalés au modèle, pause et reprise sur validation, refus d'outil sans annulation, incidents distincts des pauses
- [x] **Preuve** : tests d'intégration (registre identique au catalogue, données du propriétaire seulement, refus, pause et validation, refus d'outil, `auto_write`, révocation en cours de mission) + tests unitaires
- [x] Web : Agent Studio (création, outils et risques, écriture autonome, édition, suppression), choix de l'agent à la création d'une mission, appels d'outils et validations d'outils dans le détail
- [x] E2E Playwright Agent Studio (desktop + mobile, stack réelle)
- [ ] **Preuve réelle** : agent avec un vrai fournisseur IA (aucune clé disponible)
- [ ] Agents dans l'Assistant (aujourd'hui : missions uniquement)

# LEANA AI

Assistant personnel agentique (SaaS web). Monorepo pnpm : `apps/web` (React/Vite), `apps/api` (Fastify), `supabase/` (Postgres, Auth, migrations).

- Diagnostic initial et risques : [docs/DIAGNOSTIC.md](docs/DIAGNOSTIC.md)
- Roadmap et définition de « terminé » par phase : [docs/PLAN.md](docs/PLAN.md)

## État actuel — Phase 4 (mémoire et contexte)

| Disponible                                                                                                         | Pas encore disponible                                 |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Assistant (Google Gemini ou OpenRouter) : conversations, historique, streaming, bouton « Arrêter »                 | Outils, sources, actions proposées (Phases 5-6)       |
| **Mémoire** : LEANA retient les faits durables partagés dans le chat, les rappelle quand ils sont pertinents       | Pièces jointes / multimodal, rendu Markdown           |
| Page Mémoire : ajouter, rechercher (mots-clés + sens), corriger, restaurer, supprimer, tout effacer ; interrupteur | Invitations, gestion des membres, mot de passe oublié |
| Context Engine : souvenirs pertinents + résumé glissant des anciens échanges + derniers tours, dans un budget fixe | Autres modules (affichés « Bientôt », non cliquables) |
| AI Gateway : liste blanche, timeout, nouvelles tentatives, quota quotidien (chat, mémoire, résumés, embeddings)    |                                                       |
| Inscription, connexion, isolation multi-tenant par RLS                                                             |                                                       |

## Prérequis

Node ≥ 22, pnpm 10, Docker Desktop (démarré), Supabase CLI, Google Chrome (E2E).

## Installation

```bash
pnpm install
```

```bash
supabase start
```

Copier les deux fichiers d'exemple, puis y reporter `API_URL` et `PUBLISHABLE_KEY` affichés par `supabase status -o env` :

```bash
cp apps/api/.env.example apps/api/.env
```

```bash
cp apps/web/.env.example apps/web/.env
```

```bash
pnpm dev
```

| Service                         | URL                                                |
| ------------------------------- | -------------------------------------------------- |
| Web                             | http://localhost:5173                              |
| API + OpenAPI                   | http://127.0.0.1:3001 — http://127.0.0.1:3001/docs |
| Supabase API / Studio / Mailpit | http://127.0.0.1:59321 — :59323 — :59324           |

Les ports Supabase sont en 593xx pour cohabiter avec d'autres projets Supabase locaux.

## Variables d'environnement

| Fichier         | Variable                                                                                 | Rôle                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/api/.env` | `NODE_ENV`, `HOST`, `PORT`                                                               | Serveur                                                                                          |
| `apps/api/.env` | `CORS_ORIGINS`                                                                           | Origines navigateur autorisées (5173 dev, 4173 preview/E2E)                                      |
| `apps/api/.env` | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`                                               | Vérification des JWT et accès aux données au nom de l'utilisateur                                |
| `apps/api/.env` | `GEMINI_API_KEY`, `OPENROUTER_API_KEY`                                                   | Clés des fournisseurs (ou variables d'environnement système). Chaque clé active son fournisseur  |
| `apps/api/.env` | `GEMINI_MODELS`, `GEMINI_DEFAULT_MODEL`, `OPENROUTER_MODELS`, `OPENROUTER_DEFAULT_MODEL` | Liste blanche et modèle par défaut de chaque fournisseur                                         |
| `apps/api/.env` | `AI_DEFAULT_PROVIDER`                                                                    | Fournisseur utilisé quand l'utilisateur n'a rien choisi                                          |
| `apps/api/.env` | `AI_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS`, `AI_DAILY_TOKEN_LIMIT`                          | Garde-fous de coût et de latence                                                                 |
| `apps/api/.env` | `EMBEDDINGS_PROVIDER`, `GEMINI_EMBEDDING_MODEL`, `OPENROUTER_EMBEDDING_MODEL`            | Embeddings de la mémoire (`auto` : le premier fournisseur qui a une clé ; `none` : lexical seul) |
| `apps/api/.env` | `MEMORY_MAX_DISTANCE`, `MEMORY_RECALL_COUNT`                                             | Seuil de distance cosinus d'un souvenir « lié » et nombre de souvenirs rappelés par message      |
| `apps/web/.env` | `VITE_API_URL`                                                                           | URL publique de l'API                                                                            |
| `apps/web/.env` | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`                                     | Auth côté navigateur                                                                             |

Tout ce qui commence par `VITE_` est visible dans le navigateur : **aucun secret** n'y va. La clé `service_role` n'est utilisée nulle part.

## Scripts (racine)

| Commande                       | Effet                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm typecheck` | ESLint / `tsc --noEmit`                                                                                                                                        |
| `pnpm test`                    | Vitest : API (unitaires + intégration contre Supabase local) et web                                                                                            |
| `pnpm test:db`                 | pgTAP : isolation RLS entre utilisateurs (`supabase test db`)                                                                                                  |
| `pnpm build`                   | Build Vite + compilation API                                                                                                                                   |
| `pnpm e2e`                     | Playwright desktop + mobile contre la stack réelle (API, Supabase). `PW_CHANNEL=msedge` pour Edge, `PW_EXECUTABLE_PATH=/chemin/chrome` pour un Chromium précis |

`pnpm test` (intégration), `pnpm test:db` et `pnpm e2e` exigent `supabase start`. `pnpm e2e` démarre sa propre API (3001) et sa propre preview (4173) : arrêtez `pnpm dev` avant, sinon les ports sont occupés.

Les tests d'intégration de l'API utilisent un fournisseur IA de test injecté (jamais Gemini). L'E2E `assistant.spec.ts` dialogue avec le **vrai** Gemini quand le serveur a une clé, sinon il vérifie l'état « non configuré ». Un seul des deux s'exécute, l'autre est signalé comme ignoré.

## Architecture et sécurité

```
apps/web   src/auth/          session (onAuthStateChange), RequireAuth, messages d'erreur
           src/pages/         Dashboard, Assistant, Paramètres, Connexion/Inscription
           src/lib/api.ts     appels API avec le jeton de l'utilisateur ; src/lib/sse.ts  lecture du streaming
apps/api   src/plugins/auth.ts  vérifie le JWT (getClaims), crée un client Supabase « au nom de l'utilisateur »
           src/modules/me.ts    GET /me, PATCH /me/profile, PATCH /me/preferences (modèle IA)
           src/modules/conversations.ts  conversations, envoi en SSE, quota, rappel + extraction mémoire
           src/modules/memories.ts       CRUD /memories, recherche hybride, réindexation
           src/ai/            gateway.ts (catalogue multi-fournisseurs, timeout, nouvelles tentatives, journaux)
                              gemini.ts, openrouter.ts (adaptateurs chat), embeddings.ts (Gemini, OpenRouter)
           src/memory/        extract.ts (prompt + analyse défensive des opérations), service.ts (rappel, écriture)
           src/context/       engine.ts (Context Engine : budgets, prompt système, résumé glissant)
supabase/  migrations/        schéma versionné ; tests/database/  pgTAP
```

**Assistant IA** : `POST /conversations/:id/messages` renvoie un flux SSE (`start`, `delta`, `done` ou `error`, avec un battement toutes les 15 s).

- **Persistance** : le message de l'utilisateur et la réponse finale (ou partielle, en cas d'erreur) sont enregistrés.
- **Contexte** : il ne contient que les tours complets ; une réponse en échec n'y entre pas.
- **Nouvelles tentatives** : la gateway ne réessaie qu'avant le premier fragment, et seulement sur les erreurs 429, 5xx ou réseau. L'utilisateur ne voit donc jamais une réponse dupliquée.
- **Quota** : il est calculé en SQL sur le journal `ai_usage`, où l'on ne peut qu'ajouter des lignes, jamais en modifier ou en supprimer. Les jetons de réflexion y sont comptés en sortie.
- **Journaux** : ils contiennent le modèle, la latence, les jetons et l'issue, **jamais** le texte des conversations.

**Mémoire** (`memories`, `match_memories`) :

- **Rappel hybride** : recherche plein texte française (accents ignorés, racines des mots, OR entre les mots) et similarité cosinus pgvector sur 768 dimensions, fusionnées par Reciprocal Rank Fusion. Un souvenir n'est rappelé sémantiquement que sous `MEMORY_MAX_DISTANCE`, et seuls les vecteurs du même modèle sont comparés. Sans fournisseur d'embeddings, ou si l'appel échoue, le rappel reste lexical.
- **Extraction** : un seul appel au modèle, lancé **en parallèle** de la réponse, propose des opérations `add` / `update` / `forget` à partir du dernier message de l'utilisateur et des souvenirs rappelés. Les identifiants inconnus, les doublons et tout ce qui dépasse 5 opérations sont ignorés. Les messages de moins de 12 caractères ne déclenchent rien. Le résultat arrive dans l'événement SSE `memory`, après `done`.
- **Contradictions** : `update` crée le nouveau souvenir et marque l'ancien `superseded` (lien `superseded_by`), jamais rappelé mais restaurable ; `forget` archive sans supprimer. Seule la page Mémoire supprime.
- **Sécurité** : les souvenirs sont insérés dans le prompt système comme des **données** ; l'extracteur reçoit le message entre guillemets et ne peut citer qu'un message `user` de l'appelant (vérifié en base). L'utilisateur peut tout voir, corriger, effacer, ou désactiver la mémoire.

**Context Engine** : souvenirs pertinents (3 000 caractères max) + résumé glissant + tours récents. Au-delà de 24 000 caractères d'historique non résumé, les plus anciens tours sont résumés **après** la réponse (tâche de fond) pour revenir sous 12 000 ; au-delà de 48 000 (résumés en échec), les plus anciens sont coupés.

- **Validation** : l'API valide avec zod, mais un client peut appeler PostgREST directement avec son JWT. La base reste donc la barrière finale : contraintes `check`, trigger de validation du fuseau horaire, colonnes modifiables restreintes par `GRANT`.
- **Isolation** : toutes les tables `public` ont la RLS activée et des `GRANT` explicites. `anon` n'a aucun accès. L'API n'a pas de clé privilégiée : chaque requête passe par la RLS avec le JWT de l'appelant.
- **Fonctions privilégiées** : les helpers `security definer` sont dans le schéma `private`, non exposé par l'API Data, et ne vérifient que `auth.uid()`.
- **Erreurs** : les erreurs 5xx sont journalisées côté serveur et renvoyées sous la forme générique `Internal error`.
- **Redirections** : après connexion, seuls les chemins internes sont acceptés (pas d'open redirect).
- **CSRF** : l'API s'authentifie par en-tête `Authorization`, pas par cookie.
- **RGPD** : supprimer un compte supprime ses données et les espaces dont il était le seul membre. Les consentements sont stockés en journal append-only.

## Migrations et déploiement

- Nouvelle migration : `supabase migration new <nom>`, puis `supabase db reset` en local.
- Production (Supabase hébergé) : `supabase link`, puis `supabase db push`. Dans le dashboard, configurer `site_url` et les URL de redirection, et activer la confirmation d'e-mail : l'UI gère déjà le cas « Vérifiez vos e-mails ».
- Le guide complet Vercel / Railway arrive en Phase 10.

## Limitations connues

- TypeScript épinglé en 6.0 : typescript-eslint ne supporte pas encore TS 7.
- Bundle web de 618 kB (supabase-js inclus) : découpage par route prévu avec les modules suivants.
- Les comptes créés par les tests d'intégration et E2E restent dans la base locale. `supabase db reset` les efface.
- **Disponibilité des modèles** : chaque modèle Gemini de la liste a été vérifié le 2026-11-14 avec la configuration exacte de l'adaptateur. `gemini-3.8-flash` en a été exclu : il répondait « 503 high demand » ou ne répondait pas. Les modèles OpenRouter par défaut viennent du catalogue public, mais n'ont **pas** été testés avec une vraie clé. Pas encore de bascule automatique vers un autre modèle.
- **Quota estimé** : quand une réponse est arrêtée ou échoue, ou si le fournisseur ne renvoie pas l'usage, le quota compte une **estimation** (environ 4 caractères par jeton, `ai_usage.estimated = true`).
- Les messages sont écrits avec le JWT de l'utilisateur : celui-ci peut donc insérer des lignes `role='assistant'` dans **ses propres** conversations. La Mémoire n'en tient compte que comme contexte de l'extracteur et ne cite que des messages `user` (vérifié en base) ; les Missions ne devront pas non plus les traiter comme produites par le serveur.
- **Mémoire non calibrée** : `MEMORY_MAX_DISTANCE=0.5` et la qualité de l'extraction n'ont **pas** été mesurés avec un vrai modèle (aucune clé pendant le développement) : les tests utilisent un modèle et des embeddings simulés. À ajuster sur données réelles.
- **Embeddings OpenRouter non testés** avec une vraie clé : le paramètre `dimensions` (768) doit être accepté par le modèle choisi, sinon l'appel échoue et la mémoire reste lexicale.
- Pas d'index ANN (HNSW) : le rappel scanne exactement les souvenirs d'un seul utilisateur (quelques centaines), ce qui est rapide et exact. À revoir si ce volume explose.
- Un message envoyé pendant qu'un résumé est en cours n'en profite pas encore ; deux résumés concurrents ne s'écrasent pas (le second est ignoré).
- Les conversations de plus de 120 messages créées avant la Phase 4 ne sont résumées qu'à partir de leurs 120 derniers messages.

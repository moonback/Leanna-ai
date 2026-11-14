# LEANA AI

Assistant personnel agentique (SaaS web). Monorepo pnpm : `apps/web` (React/Vite), `apps/api` (Fastify), `supabase/` (Postgres, Auth, migrations).

- Diagnostic initial et risques : [docs/DIAGNOSTIC.md](docs/DIAGNOSTIC.md)
- Roadmap et définition de « terminé » par phase : [docs/PLAN.md](docs/PLAN.md)

## État actuel — Phase 7 (tâches, projets, documents, calendrier)

| Disponible                                                                                                     | Pas encore disponible                                          |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Tâches** (priorité, échéance, retard, projet), **Projets** (archivage), **Documents** (éditeur, recherche)   | Connecteurs externes : e-mail, agenda Google… (Phase 8)        |
| **Calendrier** : vue semaine, événements sur plusieurs jours ; tableau de bord avec tâches et agenda réels     | Vue mois, événements récurrents, rappels                       |
| Agents : 12 outils typés, dont tâches, agenda et documents ; permissions et validations appliquées par la base | Invitations dans un espace de travail (données déjà partagées) |
| Missions (plan validé, worker BullMQ, reprise après crash), journal d'activité, notifications                  | Pièces jointes / multimodal, rendu Markdown                    |
| Assistant (Gemini ou OpenRouter) avec Mémoire et Context Engine ; quota quotidien ; isolation par RLS          | Autres modules (affichés « Bientôt », non cliquables)          |

## Prérequis

Node ≥ 22, pnpm 10, Docker Desktop (démarré), Supabase CLI, Redis (missions), Google Chrome (E2E).

## Installation

```bash
pnpm install
```

```bash
supabase start
```

```bash
docker run -d --name leana-redis -p 6379:6379 redis:7-alpine
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

Dans un second terminal, le worker des missions :

```bash
pnpm dev:worker
```

| Service                         | URL                                                |
| ------------------------------- | -------------------------------------------------- |
| Web                             | http://localhost:5173                              |
| API + OpenAPI                   | http://127.0.0.1:3001 — http://127.0.0.1:3001/docs |
| Supabase API / Studio / Mailpit | http://127.0.0.1:59321 — :59323 — :59324           |

Les ports Supabase sont en 593xx pour cohabiter avec d'autres projets Supabase locaux.

## Variables d'environnement

| Fichier         | Variable                                                                                 | Rôle                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/api/.env` | `NODE_ENV`, `HOST`, `PORT`                                                               | Serveur                                                                                           |
| `apps/api/.env` | `CORS_ORIGINS`                                                                           | Origines navigateur autorisées (5173 dev, 4173 preview/E2E)                                       |
| `apps/api/.env` | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`                                               | Vérification des JWT et accès aux données au nom de l'utilisateur                                 |
| `apps/api/.env` | `GEMINI_API_KEY`, `OPENROUTER_API_KEY`                                                   | Clés des fournisseurs (ou variables d'environnement système). Chaque clé active son fournisseur   |
| `apps/api/.env` | `GEMINI_MODELS`, `GEMINI_DEFAULT_MODEL`, `OPENROUTER_MODELS`, `OPENROUTER_DEFAULT_MODEL` | Liste blanche et modèle par défaut de chaque fournisseur                                          |
| `apps/api/.env` | `AI_DEFAULT_PROVIDER`                                                                    | Fournisseur utilisé quand l'utilisateur n'a rien choisi                                           |
| `apps/api/.env` | `AI_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS`, `AI_DAILY_TOKEN_LIMIT`                          | Garde-fous de coût et de latence                                                                  |
| `apps/api/.env` | `EMBEDDINGS_PROVIDER`, `GEMINI_EMBEDDING_MODEL`, `OPENROUTER_EMBEDDING_MODEL`            | Embeddings de la mémoire (`auto` : le premier fournisseur qui a une clé ; `none` : lexical seul)  |
| `apps/api/.env` | `REDIS_URL`, `MISSIONS_QUEUE`                                                            | File BullMQ des missions (sans `REDIS_URL` : missions « non configurées », 503)                   |
| `apps/api/.env` | `DATABASE_URL`, `WORKER_CONCURRENCY`                                                     | Worker uniquement : connexion Postgres d'un rôle membre de `leana_worker` (jamais `service_role`) |
| `apps/api/.env` | `MISSION_STEP_LEASE_MS`, `MISSION_MAX_ATTEMPTS`, `MISSION_SWEEP_MS`                      | Bail d'une étape, tentatives max par étape, période de récupération des missions orphelines       |
| `apps/api/.env` | `MEMORY_MAX_DISTANCE`, `MEMORY_RECALL_COUNT`                                             | Seuil de distance cosinus d'un souvenir « lié » et nombre de souvenirs rappelés par message       |
| `apps/web/.env` | `VITE_API_URL`                                                                           | URL publique de l'API                                                                             |
| `apps/web/.env` | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`                                     | Auth côté navigateur                                                                              |

Tout ce qui commence par `VITE_` est visible dans le navigateur : **aucun secret** n'y va. La clé `service_role` n'est utilisée nulle part.

## Scripts (racine)

| Commande                       | Effet                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm typecheck` | ESLint / `tsc --noEmit`                                                                                                                                        |
| `pnpm dev:worker`              | Worker des missions (BullMQ), rechargé à chaud                                                                                                                 |
| `pnpm test`                    | Vitest : API (unitaires + intégration contre Supabase local et Redis) et web                                                                                   |
| `pnpm test:db`                 | pgTAP : isolation RLS entre utilisateurs (`supabase test db`)                                                                                                  |
| `pnpm build`                   | Build Vite + compilation API                                                                                                                                   |
| `pnpm e2e`                     | Playwright desktop + mobile contre la stack réelle (API, Supabase). `PW_CHANNEL=msedge` pour Edge, `PW_EXECUTABLE_PATH=/chemin/chrome` pour un Chromium précis |

`pnpm test` (intégration), `pnpm test:db` et `pnpm e2e` exigent `supabase start` ; `pnpm test` exige aussi Redis (`REDIS_URL` et `DATABASE_URL` dans `apps/api/.env`). `pnpm e2e` démarre sa propre API (3001) et sa propre preview (4173) : arrêtez `pnpm dev` avant, sinon les ports sont occupés.

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
           src/modules/missions.ts       /missions, /approvals, /activity, /notifications
           src/missions/      engine.ts (Mission Engine + boucle d'outils), plan.ts (prompts), queue.ts, worker.ts
           src/tools/         registry.ts (outils typés : schéma zod, risque, implémentation), protocol.ts, calculator.ts
           src/modules/agents.ts         /tools, /agents (Agent Studio)
           src/modules/workspace-data.ts /projects, /tasks, /documents, /events (CRUD partagé par espace)
           src/worker.ts      processus worker (rôle Postgres leana_worker)
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

**Missions** (`missions`, `mission_steps`, `approvals`, `activity`, `notifications`) :

- **Cycle** : l'API crée la mission (JWT de l'utilisateur) et réveille le worker par la file BullMQ. Le worker planifie (un appel au modèle, 2 à 8 étapes), demande la validation du plan, exécute les étapes dans l'ordre en donnant à chacune les résultats des précédentes, et demande une nouvelle validation avant chaque étape marquée « engage l'utilisateur ». Le résultat est la sortie de la dernière étape. Sans outils (Phase 6), une action dans le monde devient sa **préparation** (« Rédiger l'e-mail »), jamais son exécution.
- **La base est la source de vérité** : la file ne sert qu'à réveiller. Un job en double est sans effet (verrou consultatif Postgres par mission, sur une connexion dédiée : un worker mort libère le sien) ; un job perdu est rattrapé par le balayage périodique du worker.
- **Reprise après crash** : BullMQ détecte le job abandonné et le relance ; le nouveau worker reprend l'étape en cours comme **tentative suivante**. Chaque écriture de résultat est conditionnée à son numéro de tentative : un worker figé qui se réveille ne peut rien écraser. Au-delà de `MISSION_MAX_ATTEMPTS`, l'étape et la mission échouent. Les erreurs définitives du fournisseur (clé, crédits, modèle) font échouer immédiatement.
- **Moindre privilège** : le worker se connecte sous le rôle `leana_worker` (sans `BYPASSRLS`). Il lit et pilote les missions, lit profil, préférences et quota, et rien d'autre : ni mémoires, ni conversations, ni comptes. L'utilisateur, lui, ne peut que créer, annuler, décider d'une validation en attente (une seule fois) et marquer ses notifications lues. La machine à états est appliquée par un trigger.
- **Journal et notifications** : écrits uniquement par des triggers `security definer` à chaque changement d'état (création, validation demandée/accordée/refusée, étape terminée/en échec/**reprise**, fin de mission). Personne ne peut les écrire ou les modifier directement.

**Agents et outils** (`tools`, `agents`, `tool_calls`) :

- **Registre typé** : chaque outil a un schéma d'entrée zod strict, un niveau de risque (`read`, `write`, `sensitive`) et une implémentation. Aucun agent n'accède à SQL ni à du code arbitraire. La table `tools` est le miroir du registre ; un test d'intégration vérifie qu'ils sont identiques.
- **Protocole** : à chaque tour, le modèle répond par un objet JSON, `{"tool":…,"input":…}` ou `{"final":…}`. Le protocole est identique pour Gemini et OpenRouter. Les résultats d'outils lui sont rendus comme des **données**. Au plus 6 appels par étape.
- **Permissions appliquées par la base**. Un trigger contrôle chaque appel : l'outil doit figurer **à cet instant** dans la liste de l'agent de la mission, l'appel doit appartenir au propriétaire et à une étape en cours. Un outil `write` exige une validation accordée, sauf si l'agent peut « écrire sans demander » ; un outil `sensitive` l'exige **toujours**. Retirer un outil à un agent prend effet à l'appel suivant, même pour un appel déjà validé.
- **Accès aux données** : le worker ne lit toujours ni mémoires ni conversations. Les outils passent par des fonctions `private.tool_*`, qui n'agissent que pour un appel **en cours** du bon outil, sur les données de son utilisateur.
- **Audit** : tout est enregistré dans `tool_calls`, y compris les appels refusés (outil non autorisé ou inconnu), les entrées invalides et les refus de l'utilisateur. Le journal d'activité reçoit les refus et les écritures.
- **Validations d'outils** : un outil qui attend une validation met l'étape en pause. À la reprise, les appels précédents sont rejoués au modèle. Refuser un outil n'annule pas la mission : l'agent termine sans lui. Les pauses ne comptent pas comme des incidents : seuls les crashs et les pannes rapprochent une étape de `MISSION_MAX_ATTEMPTS`.

**Tâches, projets, documents, calendrier** :

- **Partagés dans l'espace de travail** : contrairement aux conversations, mémoires et missions, qui sont privées, ces données sont lisibles et modifiables par tous les membres de l'espace. Le créateur est enregistré et ne peut pas être usurpé. Un élément ne peut ni changer d'espace ni pointer vers le projet d'un autre espace (trigger). Supprimer un projet conserve ses tâches et documents.
- **Règles en base** : priorités et statuts fixés, `completed_at` posé et effacé par trigger, un événement ne finit pas avant de commencer et dure au plus un an, documents limités à 100 000 caractères. La recherche plein texte réutilise la configuration française sans accents de la Mémoire ; les extraits surlignés sont affichés en texte brut.
- **Outils d'agents** : `tasks.list/create/complete`, `calendar.list/create`, `documents.search/create`. Ils agissent dans l'espace de **la mission**, seulement pendant un appel en cours et tant que l'utilisateur en est membre. Ce qu'ils créent est attribué au propriétaire de la mission.

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
- **Worker en production** : créer un rôle de connexion membre de `leana_worker` (`create role leana_worker_login login password '…' in role leana_worker;`), mettre son URL dans `DATABASE_URL` du service worker, et un Redis managé dans `REDIS_URL` (API et worker). Lancer `pnpm --filter @leana/api build` puis `pnpm --filter @leana/api worker`.
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
- **Missions non testées avec un vrai modèle** (aucune clé) : la qualité des plans et des étapes n'est pas mesurée ; les tests utilisent un modèle simulé. Le cycle complet et la reprise sont, eux, prouvés contre Redis et Postgres réels.
- La reprise après crash est testée en **processus** (worker figé, connexions coupées, job abandonné), pas par un `kill -9` d'un vrai processus : cela demanderait un fournisseur IA réel dans le worker.
- Pas encore de notification en temps réel : la page d'une mission se rafraîchit toutes les 2 s tant qu'elle est active, le badge toutes les 30 s.
- Une mission ne peut être ni modifiée ni supprimée (seulement annulée) ; son historique reste dans le journal.
- **Agents non testés avec un vrai modèle** : le respect du protocole JSON par Gemini et OpenRouter n'est pas mesuré. Une réponse hors protocole est traitée comme la réponse finale de l'étape, jamais comme un appel d'outil.
- Aucun outil `sensitive` n'existe encore : la règle « validation toujours requise » est prouvée en base avec un outil de test, et servira aux connecteurs (Phase 8).
- Les agents ne sont utilisables que dans les missions, pas encore dans l'Assistant.
- Calendrier : vue semaine uniquement, pas d'événements récurrents ni de rappels ; un événement se supprime mais ne se modifie pas encore depuis l'interface (l'API `PATCH /events/:id` existe).
- Les filtres de la page Tâches ne sont pas conservés dans l'URL : seul le lien « tâches d'un projet » l'est.

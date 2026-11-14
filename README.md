# LEANA AI

Assistant personnel agentique (SaaS web). Monorepo pnpm : `apps/web` (React/Vite) et `apps/api` (Fastify).

- Diagnostic initial et risques : [docs/DIAGNOSTIC.md](docs/DIAGNOSTIC.md)
- Roadmap et définition de « terminé » par phase : [docs/PLAN.md](docs/PLAN.md)

## État actuel — Phase 1 (fondations)

| Disponible                                                                    | Pas encore disponible                                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Shell responsive (sidebar, tiroir mobile, header), design system verre sombre | Auth, base de données, RLS (Phase 2, nécessite Docker)         |
| Dashboard avec états vides réels                                              | Assistant / AI Gateway (Phase 3, nécessite une clé IA)         |
| Indicateur d'état API (chargement, connecté, erreur + réessayer, hors ligne)  | Tous les autres modules (affichés « Bientôt », non cliquables) |
| API `GET /health`, OpenAPI sur `/docs`                                        | Worker BullMQ, Stripe, connecteurs                             |

## Prérequis

Node ≥ 22, pnpm 10, Google Chrome (pour l'E2E). Docker Desktop + Supabase CLI à partir de la Phase 2.

## Installation

```bash
pnpm install
```

```bash
cp apps/api/.env.example apps/api/.env
```

```bash
cp apps/web/.env.example apps/web/.env
```

```bash
pnpm dev
```

Web : http://localhost:5173 — API : http://127.0.0.1:3001 — documentation OpenAPI : http://127.0.0.1:3001/docs

## Variables d'environnement

| Fichier         | Variable                   | Rôle                                                       |
| --------------- | -------------------------- | ---------------------------------------------------------- |
| `apps/api/.env` | `NODE_ENV`, `HOST`, `PORT` | Serveur                                                    |
| `apps/api/.env` | `CORS_ORIGINS`             | Origines navigateur autorisées (séparées par des virgules) |
| `apps/web/.env` | `VITE_API_URL`             | URL publique de l'API                                      |

Règle : tout ce qui commence par `VITE_` est visible dans le navigateur. **Aucun secret** n'y va ; les clés IA, Stripe et OAuth resteront dans `apps/api/.env`.

## Scripts (racine)

| Commande         | Effet                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`      | ESLint (TS + règles React hooks)                                                                                          |
| `pnpm typecheck` | `tsc --noEmit` sur chaque app                                                                                             |
| `pnpm test`      | Vitest (API via `app.inject`, web via Testing Library)                                                                    |
| `pnpm build`     | Build Vite + compilation API vers `apps/api/dist`                                                                         |
| `pnpm e2e`       | Playwright (desktop + mobile) : build web, lance l'API, teste contre la vraie API. `PW_CHANNEL=msedge` pour utiliser Edge |

## Architecture

```
apps/web   src/modules.ts      registre des modules (phase de livraison → lien actif ou « Bientôt »)
           src/router.tsx      routes ; src/components/AppShell.tsx  layout
           src/index.css       tokens du design system (@theme Tailwind v4, utilitaire `glass`)
apps/api   src/env.ts          validation zod de l'environnement (échec au démarrage si invalide)
           src/app.ts          construction Fastify (CORS, OpenAPI, routes) — testable sans réseau
           src/server.ts       point d'entrée
```

## Limitations connues

- TypeScript épinglé en 6.0 : typescript-eslint ne supporte pas encore TS 7.
- Migrations, déploiement (Vercel / Railway / Supabase) : documentés à partir de la Phase 2.

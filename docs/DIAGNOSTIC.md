# Diagnostic initial — LEANA AI (2026-11-14)

## État du dépôt

- Dossier `Leanna-ai` **vide**, pas de dépôt git au départ → projet greenfield, aucun code existant à préserver.
- Dépôt initialisé directement sur la branche `feat/phase-1-foundations` : `main` n'a jamais été créée ni modifiée.
- Dossiers voisins potentiellement liés (`Leanna-ide`, `Leanna-IDE-context.txt`) : **non lus**, à confirmer avec l'utilisateur.

## Environnement

| Outil        | Version | État              |
| ------------ | ------- | ----------------- |
| Node         | 24.16   | OK                |
| pnpm         | 10.33   | OK                |
| git          | 2.50    | OK                |
| Supabase CLI | 3.0.0   | OK (3.1 dispo)    |
| Docker       | 28.1    | **daemon arrêté** |

## Risques et bloqueurs

1. **Docker arrêté** → impossible de lancer `supabase start`, d'appliquer les migrations, de tester les RLS, ni de lancer Redis (BullMQ). Les migrations peuvent être écrites mais ne seront pas déclarées terminées avant application + test. Solution : démarrer Docker Desktop, ou fournir un projet Supabase hébergé.
2. **Aucune clé IA** → l'AI Gateway sera testé unitairement avec un faux provider injecté **dans les tests uniquement**. Le critère « discuter avec LEANA » reste non vérifié tant qu'une clé n'est pas dans `apps/api/.env` (jamais via le chat).
3. **Périmètre** : 10 phases ne tiennent pas dans une session. Chaque phase a une définition de « terminé » vérifiable (voir `PLAN.md`).
4. **TypeScript 7** (latest) n'est pas supporté par typescript-eslint (`<6.1`) → épinglé sur TypeScript 6.0.
5. **Windows** : fins de ligne normalisées en LF (`.gitattributes`, Prettier).
6. **Sécurité frontend** : seule la clé `anon` Supabase sera exposée (`VITE_*`). Aucun secret côté navigateur.

## Architecture cible

```
apps/web         React + Vite + TS + Tailwind v4 + composants style shadcn, Zustand, TanStack Query
apps/api         Fastify (monolithe modulaire : modules/auth, ai-gateway, memory, missions, agents…), OpenAPI
apps/worker      BullMQ (Phase 5 : exécution des missions, idempotence, reprise)
packages/shared  schémas zod partagés (contrats API)
supabase/        config + migrations SQL versionnées + tests RLS
```

- Le navigateur parle à Supabase Auth (anon key) et à l'API (JWT Supabase vérifié côté serveur).
- Les agents n'accèdent qu'à des **outils typés** (schéma zod, permissions, journalisation) — jamais à SQL brut.
- Actions sensibles → table `approvals`, exécution bloquée tant que non approuvée.

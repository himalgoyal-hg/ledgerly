# Ledgerly

Multi-entity books with a double-entry engine underneath. Built per the
v3 consolidated spec — Phase 1 (Core) is complete.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1. Core | Auth, single-admin model, permission matrix, entity + bank account managers, audit, soft-delete | ✅ done |
| 2. Accounting engine | CoA auto-seed, journal posting, ledgers, trial balance, period lock, reversal-based edit/delete/undo | ⏳ next |
| 3. Statement pipeline | Upload → detect → extract → dedupe → auto-verify/queue → tag → post | – |
| 4–9 | Operations, tax, reports, suggestions, AI layer, hardening | – |

## Stack

- Next.js 16 (App Router, server actions) + TypeScript + Tailwind
- Prisma 7 + PostgreSQL 17 (local dev instance on port 55432)
- iron-session (encrypted cookie sessions), bcryptjs, zod

## Running locally

```bash
# 1. Start the local Postgres (installed under ~/.local/ledgerly-pg)
~/.local/ledgerly-pg/pg-start     # pg-stop / pg-status also available

# 2. Start the app
cd ~/Desktop/Project/ledgerly
npm run dev                        # or: npm run build && npm start
```

App: http://localhost:3000 — sign in with the seeded users
(passwords come from `SEED_ADMIN_PASSWORD` / `SEED_MEMBER_PASSWORD` in `.env`):

- Admin: `himal.goyal@accurest.co`
- Members: `greeshma@` / `prakash@` / `sanjeevani@accurest.co` (zero permissions until granted)

## Key invariants (enforced, tested)

- **Exactly one Main Admin** — partial unique DB index `one_main_admin`;
  a second ADMIN row cannot exist. Admin cannot be deactivated/demoted in code.
- **Zero-trust UI** — every page and server action re-checks role/permission
  server-side (`requireAdmin` / `requirePermission` in `src/lib/auth.ts`).
- **Audit rows are transactional** — written in the same DB transaction as
  the mutation they describe (`src/lib/audit.ts`).
- **Archive over delete** — entities/accounts/locations archive (soft);
  hard delete only when nothing hangs off them.

## Verification

```bash
npm run build                      # typecheck + compile
node scripts/verify-phase1.mjs     # 24 runtime checks against a running server
```

The runtime suite proves: anonymous → redirected; admin sees everything;
a zero-permission member sees nothing gated; granting one flag opens
exactly that capability; revocation/deactivation take effect immediately;
forged cookies are rejected.

## Database

```bash
npx prisma migrate dev             # apply migrations
npx prisma db seed                 # idempotent seed (admin + members)
```

Connection settings live in `.env` (never committed). `prisma/schema.prisma`
is the source of truth for the data model.

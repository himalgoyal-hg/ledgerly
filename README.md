# Ledgerly

Multi-entity books with a double-entry engine underneath. Built per the
v3 consolidated spec.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1. Core | Auth, single-admin model, permission matrix, entity + bank account managers, audit, soft-delete | ✅ done |
| 2. Accounting engine | CoA auto-seed, journal posting, ledgers, trial balance, period lock, reversal-based edit/delete/undo | ✅ done |
| 3. Statement pipeline | Upload → detect → extract → dedupe → auto-verify/queue → tag → post → balance validation | ✅ done |
| 4. Operations | Reimbursements, cash, bills, salary, tasks, invoices — thin screens over posting rules | ✅ done |
| 5. Tax | GST/TDS fields, split-posting, GSTR-1/3B + ITC, TDS register, deposit reminders | ✅ done |
| 6. Reports & dashboard | P&L, Balance Sheet, Cash Flow, budget, cost centres, parties, salary + Overview tiles | ✅ done |
| 7. Smart suggestions & automation | Payment-source engine, reminders, recurring generators, weekly email | ✅ done |
| 8. AI layer | PDF/scanned statement reading, tagging suggestions | ✅ done |
| 9. Hardening | Verification plan §11, backups, restore drill, performance | ✅ done |

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
- **Total Dr = total Cr, always** — a deferred DB constraint trigger rejects
  any commit containing an unbalanced journal entry; a CHECK forces each line
  to exactly one positive side.
- **Append-only ledger** — DB triggers forbid UPDATE/DELETE on journal lines
  and entries (state bookkeeping excepted). Edits and deletes post reversals;
  undo is LIFO with unlimited depth and a "Recently deleted" bin.
- **Period locks live in the DB** — a trigger rejects any posting dated in a
  locked month, so edit/delete/undo of locked-month records is impossible
  even via raw SQL. Unlock is admin-only and audit-logged.
- **All money in integer paise** (`src/lib/ledger/money.ts`) — no floats.

## Verification

```bash
npm run build                      # typecheck + compile
node scripts/verify-phase1.mjs     # 24 runtime checks against a running server
npm run verify:2                   # 19 ledger checks through the service layer
npm run verify:3                   # 37 statement-pipeline checks
npm run verify:4                   # 34 operations checks
npm run verify:5                   # 25 taxation checks
npm run verify:6                   # 34 reporting checks
npm run verify:7                   # 28 automation checks
npm run verify:8                   # 27 AI-layer checks (live calls need a key)
npm run verify                     # phases 2–8 in sequence
npm run backup                     # gzipped NDJSON dump → ./backups/
npm run restore-drill              # prove the newest backup restores cleanly
npm run perf                       # seed ~50k entries, time every user-facing query
```

The scripts run through the real service layer with `tsx --conditions=react-server`
— that condition makes Next's `server-only` guard resolve the way it does
inside the server bundle, instead of throwing.

Phase 1 suite: anonymous → redirected; admin sees everything; a
zero-permission member sees nothing gated; granting one flag opens exactly
that capability; revocation/deactivation take effect immediately; forged
cookies are rejected.

Phase 2 suite (spec §11): the §11.4 undo chain (edit → edit → delete →
undo ×3 restores the exact original, ledger balanced at every step); §11.5
period locks reject post/edit/delete/undo and raw-SQL tampering; direct
UPDATE/DELETE against ledger rows is rejected by triggers; and the §11.1
invariant holds after a 60-operation random storm (Dr = Cr to the paisa).

Phase 3 suite (spec §11.2/§3): CSV + XLSX parsing across bank layouts;
auto-routing by account number (full + masked), IFSC, and remembered
mappings; occurrence-aware dedupe (same file re-imported → all rows flagged
"previously imported", identical same-day rows kept); rules engine learns
from manual tags and auto-verifies later imports; posting rules produce the
spec's Dr/Cr table; own-account transfers post once and auto-match the
mirror row; closing-balance validation holds imports open until resolved;
retag/delete/undo of posted rows stay balanced; cost-centre report trace.

Phase 4 suite (spec §6): approve/reject/settle reimbursements with live
member-payable ledgers; cash receipt/payment/transfer/adjustment (reason
mandatory) with the where-is-cash view; bills posting and clearing vendor
payables, recurring instances spawning on payment; salary runs (draft →
approve → pay) with per-person payables, TDS split and the auto-created
deposit task; recurring finance tasks; invoice numbering, partial payments,
aging buckets and settled debtors — books balanced across every module.

Phase 5 suite (spec §7): paise-exact GST/TDS arithmetic (forward, inclusive
and net-of-TDS grossing, with rounding that never loses a paisa); invoice
GST splitting to Output Liability; bill GST → Input Credit with TDS withheld
from the vendor; statement rows splitting inclusive GST and grossing up
net-of-TDS payments; GSTR-1 rate-wise, GSTR-3B ITC tracker → net payable;
TDS register by section and deductee; deposit tasks accumulating per month;
deleted postings dropping out of the registers; filing locks the period.

Phase 6 suite (spec §10, §11.6): the identities that prove each statement —
Balance Sheet (Assets = Liabilities + Equity + profit-to-date) and Cash Flow
(opening + movements = closing); every P&L line traced back to the trial
balance and down to its source document; cash-flow classification (operating
/ investing / financing) with own-account transfers self-eliminating;
cost-centre, party, budget-variance and salary reports; reports reacting
correctly to delete and undo; and the dashboard tiles agreeing with the
ledger.

Phase 7 suite (spec §8, §6.5, §10): suggestions falling back to liquidity
without a mapping, honouring a mapping when one exists, preferring the more
specific mapping, and abandoning a mapped account that cannot cover the
amount; commitments inside the 7-day window reserving against their mapped
account (and beyond it, not reserving); ad-hoc spend being steered away from
reserved money with a warning rather than a silent allow; recurring
generation being idempotent; and the whole job being a no-op on a second run
in the same period.

Phase 8 suite (spec §12.8) tests the guard rails rather than the model: rows
with no amount, both amounts, an unreadable date or an empty narration are
dropped rather than guessed; a suggested account code that doesn't exist for
the entity (or belongs to another entity) is dropped rather than created; an
unknown nature, a reply for a row we never asked about, and duplicate replies
are all rejected; confidence is clamped; accepting a suggestion tags the row
and teaches the rule engine; and without an API key PDF uploads are refused
with an actionable message. Live model calls run only when a key is present.

Phase 9 hardening (spec §12.9): `npm run backup` streams every table to a
gzipped NDJSON file (keyset-paginated, so memory stays flat at any ledger
size). `npm run restore-drill` loads the newest backup into a scratch
database built from the migrations and proves it: row counts match
row-for-row, every entity still tallies Dr = Cr, the append-only triggers
are live again, and a raw UPDATE on a restored journal line is still
refused. `npm run perf` seeds a ~50k-entry multi-year ledger and times
every report, dashboard tile, and tax register a user actually waits on
(all 17 currently run well under the 400 ms budget), then cleans up after
itself. A backup nobody has restored is a hope, not a backup — the drill
is the test.

## AI layer

Two features call Claude, and **both produce proposals a person confirms** —
nothing the model outputs reaches the ledger on its own:

- **PDF and scanned statements** — Claude transcribes the rows, which then land
  as an ordinary DETECTED import you confirm. The closing-balance check catches
  a misread exactly as it would catch a bad CSV.
- **Tagging suggestions** — for queue rows no rule matches. Accepting one tags
  the row *and* teaches the rule engine, so that party is matched without AI
  next time. Suggestions resolve against the entity's own chart of accounts;
  an account code the model invents is dropped, never created.

```bash
# .env — optional; without it PDFs are refused with a clear message
# and the tagging queue works on rules alone.
ANTHROPIC_API_KEY=sk-ant-...
```

Model: `claude-opus-5`, with a server-side fallback to `claude-opus-4-8` so an
occasional safety-classifier false positive on a bank statement isn't a dead
end. Every call is logged with its token usage — Admin → Automation shows the
30-day totals, so AI spend is visible rather than a surprise on the bill.

## Automation

Nothing fires on a timer by itself — a scheduler has to call the job. The job
is idempotent, so a missed or repeated run is harmless.

```bash
# .env
CRON_SECRET=<a long random string>     # required; without it the endpoint is disabled
SMTP_HOST=…                            # optional; without it messages queue instead of sending
SMTP_PORT=587
SMTP_USER=…
SMTP_PASS=…
SMTP_FROM="Ledgerly <books@example.com>"

# crontab — once a day
0 7 * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
             https://<your-host>/api/automation/run
```

Each run generates recurring bills and tasks coming due within 14 days,
queues reminders and low-balance alerts, adds the weekly summary on Mondays,
and delivers whatever is queued. Admin → Automation shows the last run, the
payment mapping, and the full outbox (including messages still queued because
no SMTP is configured) — and has a "Run now" button.

## Database

```bash
npx prisma migrate dev             # apply migrations
npx prisma db seed                 # idempotent seed (admin + members)
```

Connection settings live in `.env` (never committed). `prisma/schema.prisma`
is the source of truth for the data model.

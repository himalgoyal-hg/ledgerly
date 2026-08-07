# Ledgerly — combined requirements (as told by Himal, to date)

> **SPEC SOURCE OF TRUTH (7 Aug 2026):** the "Ledgerly v2" standalone HTML
> prototype Himal shared. Its features — exactly those, nothing more — are the
> target. Sidebar now mirrors it (Overview · Books · Statements · Operations ·
> Setup & masters). GST/TDS, journal, trial balance, ledgers, periods,
> automation, AI and audit screens are HIDDEN from nav (still URL-reachable;
> GST kept because ACPL is GST-registered, audit because approvals must stay
> recorded). Build order — ALL DONE: B) Loans & advances + all-entities view,
> C) report tabs (month-matrix, weekly, usage, net capital, ITR, capital
> gains), D) USD invoices + FIRC, reimbursement member tabs, consultants,
> E) frequency budgets (weekly/monthly/quarterly/half-yearly/annual,
> annualised) + insurance fields on bills (policy no, insured value, for
> whom, half-yearly recurrence, lapse alerts off the renewal date).

Single consolidated list of everything asked for across the prompt log, the
26-27 spreadsheet, the access-control message, the implementation plan, and
in-session requests. ✅ built & verified · 🔶 partly done · ⬜ pending.

## A. Core system (the original spec)

- ✅ Multi-entity books — HG, MG, PG, ACPL — with a "Books of" switcher on every screen (⬜ HG/MG/PG entities not yet created — data task)
- ✅ Statement upload in any format (CSV/XLSX/TSV; PDF via AI key), auto-detect bank account + entity from the file header, dedupe on re-upload, closing-balance validation
- ✅ 3-tier tagging (nature → account head → cost centre) with rules that learn from every manual tag; auto-verified rows skip the queue
- ✅ Double-entry ledger underneath: Dr = Cr enforced in DB, append-only, edits/deletes as reversals, unlimited undo, period locks, audit trail on everything
- ✅ Reports: P&L, Balance Sheet, Cash Flow, Trial balance, ledgers, cash transactions view, cost centres, parties, budget vs actual, salary
- ✅ GST/TDS: rates, HSN, GSTIN, sections 194x, GSTR-1/3B + ITC, TDS register, deposit reminders (7th)
- ✅ Operations: Invoices & receivables · Reimbursements with admin-only approve/reject (recorded) · Finance tasks with due-date reminders · Bills & insurance with Google Drive links · Salary register (team, cost centre, TDS) · Cash with multi-location + transfers, admin-locked
- ✅ Smart payment-source suggestions: purpose mappings, live balances, low-balance warnings, 7-day EMI/due protection, alerts on Overview
- ✅ Strict access control: members default to zero rights; admin grants per-screen flags; enforced server-side
- ✅ Automation: recurring bills/tasks generation, reminder + weekly-summary emails (needs SMTP + cron), AI tagging suggestions and PDF reading (needs API key)
- ✅ Hardening: backups (`npm run backup`), restore drill, 50k-entry perf bench, 228 automated checks

## B. Asked for recently — done

- ✅ Premium UI redesign: sidebar shell, dark mode, stat cards with trends, analytics charts, activity timeline, responsive (desktop/tablet/mobile)
- ✅ Delete uploaded statements (posted rows reversed, dedupe forgotten); add/edit/delete in bills, invoices, tasks; rename cost centres & accounts
- ✅ Readable transaction titles from bank remarks ("Digitalocean · Card") shown in the queue
- ✅ Easy tagging: one tag applies to every same-party row still pending (64 rows ≈ 15 decisions)
- ✅ Real ACPL HDFC account created (…7838? → 50200057577838, HDFC0000007), July statement imported: 64 rows (bank's own Dr 54 + Cr 10), balance ties to ₹55,491.99

## C. Asked for — pending

1. ⬜ Create HG, MG, PG entities + all bank accounts (HG ICICI/Kotak/Fed, MG ICICI, Meena Axis, ACPL 7838) so every statement auto-routes
2. ⬜ Seed real expense heads + cost centres from the 26-27 sheet (Food & Dining, Gym & Health, Hyrox, ACPL Business Exp, …) as accounts, budgets and tag vocabulary
3. ⬜ Role presets, one click per person: Admin (Himal) · Accounting = tagging + P&L/BS (Pranay, Greeshma) · Finance & Ops = operations + cash flow (Greeshma) · Reimbursement entry (Prakash, Greeshma, Sanjeevani); add Pranay as user
4. ⬜ Cash locations: Office Drawer, Locker, Car, With Mom
5. ⬜ From the sheet: credit-card accounts (AMEX, Tata Neo), frequency-based budgets (weekly/quarterly/annual), "claimable as" tax tag, weekly expense report, planned-vs-actual funding source report
6. ⬜ UI: drag-and-drop uploader; reimbursement sub-tabs per member with running balance in the tab header
7. ⬜ Remaining CRUD: cancel draft salary run, withdraw own pending claim, edit bank account details, reverse GST/TDS payment, clear budget line

## Open decision (only Himal can answer)

- Admin login email: `cahimalgoyal@gmail.com` (per access-control note & plan) vs `himal.goyal@accurest.co` (live today). Which is canonical?

Superseded: the "keep only my list, remove the rest" instruction — the later
implementation plan explicitly includes GST/TDS, invoices, salary, tasks and
smart suggestions, so nothing is being removed.

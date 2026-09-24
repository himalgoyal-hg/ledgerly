// Fresh start: wipe the accounting history, keep the setup and the
// statements that are still in the tagging queue.
//
//   DOTENV_CONFIG_PATH=.env.prod npm run fresh-start              → dry run (counts only)
//   DOTENV_CONFIG_PATH=.env.prod npm run fresh-start -- --yes     → do it
//   flags: --drop-budgets (also clear per-month budgets)  --keep-audit (leave AuditLog)
//
// Kept: users, permissions, books, bank accounts, cash locations, chart of
// accounts, cost centres, tag rules, statement mappings, head modes, plan
// lines, salary persons, finance task definitions, net-capital lines,
// StatementImport + StatementTransaction (their tags survive; any posted
// link is cleared so they go back to TAGGED and can be posted again).
//
// Deleted: every journal doc/entry/line (opening balances, cash entries,
// bin), bills, invoices + payments, reimbursements, cash entries, tax lines,
// salary runs, finance task ticks, period locks, notification queue, AI call
// log, stored documents (and their blobs), audit log (unless --keep-audit),
// budgets (only with --drop-budgets).
//
// Take a backup first:  DOTENV_CONFIG_PATH=.env.prod npm run backup
import 'dotenv/config'
import { Client } from 'pg'
import { del } from '@vercel/blob'

const args = process.argv.slice(2)
const yes = args.includes('--yes')
const dropBudgets = args.includes('--drop-budgets')
const keepAudit = args.includes('--keep-audit')

// Order matters: rows that point at JournalDoc go before the docs.
const WIPE: string[] = [
  'InvoicePayment', 'Invoice', 'Bill', 'Reimbursement', 'CashEntry', 'TaxLine',
  'SalaryRunLine', 'SalaryRun', 'FinanceTaskCell', 'PeriodLock',
  'NotificationOutbox', 'AiCall', 'StoredFile',
  ...(keepAudit ? [] : ['AuditLog']),
  ...(dropBudgets ? ['Budget'] : []),
]
const KEEP: string[] = [
  'User', 'MemberPermission', 'UserEntityScope', 'Entity', 'BankAccount', 'CashLocation',
  'LedgerAccount', 'CostCentre', 'TagRule', 'StatementMapping', 'HeadMode', 'BudgetLine',
  'PaymentPreference', 'SalaryPerson', 'FinanceTask', 'FinanceMonth', 'NetCapitalLine',
  'StatementImport', 'StatementTransaction',
  ...(keepAudit ? ['AuditLog'] : []),
  ...(dropBudgets ? [] : ['Budget']),
]

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  const c = new Client({ connectionString: url })
  await c.connect()
  const count = async (t: string) => Number((await c.query(`SELECT count(*)::text n FROM "${t}"`)).rows[0].n)

  try {
    console.log(yes ? 'FRESH START — deleting' : 'DRY RUN — nothing will change')
    console.log('\nWill delete:')
    for (const t of ['JournalLine', 'JournalEntry', 'JournalDoc', ...WIPE]) {
      console.log(`  ${t.padEnd(20)}${(await count(t)).toLocaleString('en-IN')}`)
    }
    const posted = Number(
      (await c.query(`SELECT count(*)::text n FROM "StatementTransaction" WHERE "docId" IS NOT NULL OR status = 'POSTED'`)).rows[0].n,
    )
    console.log(`\nStatement transactions to un-post (back to TAGGED): ${posted}`)
    console.log('\nWill keep:')
    for (const t of KEEP) console.log(`  ${t.padEnd(20)}${(await count(t)).toLocaleString('en-IN')}`)
    if (!yes) {
      console.log('\nRe-run with --yes to apply.')
      return
    }

    const storedIds = (await c.query<{ id: string }>('SELECT id FROM "StoredFile"')).rows.map((r) => r.id)

    await c.query('BEGIN')
    try {
      // Append-only guards on the journal sleep for this transaction only.
      await c.query('ALTER TABLE "JournalLine" DISABLE TRIGGER USER')
      await c.query('ALTER TABLE "JournalEntry" DISABLE TRIGGER USER')
      await c.query(
        `UPDATE "StatementTransaction" SET "docId" = NULL, "mirrorTxnId" = NULL, status = 'TAGGED' WHERE "docId" IS NOT NULL OR status = 'POSTED'`,
      )
      for (const t of WIPE) await c.query(`DELETE FROM "${t}"`)
      await c.query('DELETE FROM "JournalLine"')
      await c.query('UPDATE "JournalDoc" SET "currentEntryId" = NULL')
      await c.query('UPDATE "JournalEntry" SET "reversesId" = NULL')
      await c.query('DELETE FROM "JournalEntry"')
      await c.query('DELETE FROM "JournalDoc"')
      await c.query('ALTER TABLE "JournalLine" ENABLE TRIGGER USER')
      await c.query('ALTER TABLE "JournalEntry" ENABLE TRIGGER USER')
      await c.query('COMMIT')
    } catch (e) {
      await c.query('ROLLBACK')
      throw e
    }

    if (storedIds.length && process.env.BLOB_READ_WRITE_TOKEN) {
      await del(storedIds.map((id) => `uploads/${id}`)).catch((e) => console.warn('blob delete:', e.message))
      console.log(`Removed ${storedIds.length} document blob(s)`)
    }

    console.log('\nDone. After:')
    for (const t of ['JournalDoc', 'JournalEntry', 'JournalLine', 'Bill', 'StatementImport', 'StatementTransaction', 'LedgerAccount', 'User']) {
      console.log(`  ${t.padEnd(20)}${(await count(t)).toLocaleString('en-IN')}`)
    }
  } finally {
    await c.end()
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})

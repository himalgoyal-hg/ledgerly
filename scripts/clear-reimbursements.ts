// Clear the Reimbursements module so it can be re-entered from scratch:
// every claim / advance record, plus the journal documents they posted
// (claim approvals, advance confirmations, settlements). Statement rows
// tagged to an "Advance — <member>" head are NOT touched — they belong to
// the tagging queue, not this module.
//
//   DOTENV_CONFIG_PATH=.env.prod npm run clear-reimbursements            → dry run
//   DOTENV_CONFIG_PATH=.env.prod npm run clear-reimbursements -- --yes   → do it
import 'dotenv/config'
import { Client } from 'pg'

const SOURCE_TYPES = ['reimbursement', 'reimbursement_settlement', 'member_advance']
const yes = process.argv.includes('--yes')

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  const c = new Client({ connectionString: url })
  await c.connect()
  try {
    const rows = Number((await c.query(`SELECT count(*)::text n FROM "Reimbursement"`)).rows[0].n)
    const docs = (await c.query<{ id: string }>(
      `SELECT id FROM "JournalDoc" WHERE "sourceType" = ANY($1)`, [SOURCE_TYPES],
    )).rows.map((r) => r.id)
    const entries = docs.length
      ? Number((await c.query(`SELECT count(*)::text n FROM "JournalEntry" WHERE "docId" = ANY($1)`, [docs])).rows[0].n)
      : 0
    console.log(yes ? 'CLEARING reimbursements' : 'DRY RUN — nothing will change')
    console.log(`  Reimbursement records   ${rows}`)
    console.log(`  Journal documents       ${docs.length} (${entries} entries)`)
    if (!yes) { console.log('\nRe-run with --yes to apply.'); return }

    await c.query('BEGIN')
    try {
      await c.query('ALTER TABLE "JournalLine" DISABLE TRIGGER USER')
      await c.query('ALTER TABLE "JournalEntry" DISABLE TRIGGER USER')
      await c.query(`DELETE FROM "Reimbursement"`)
      if (docs.length) {
        await c.query(`DELETE FROM "JournalLine" WHERE "entryId" IN (SELECT id FROM "JournalEntry" WHERE "docId" = ANY($1))`, [docs])
        await c.query(`UPDATE "JournalDoc" SET "currentEntryId" = NULL WHERE id = ANY($1)`, [docs])
        await c.query(`UPDATE "JournalEntry" SET "reversesId" = NULL WHERE "docId" = ANY($1)`, [docs])
        await c.query(`DELETE FROM "JournalEntry" WHERE "docId" = ANY($1)`, [docs])
        await c.query(`DELETE FROM "JournalDoc" WHERE id = ANY($1)`, [docs])
      }
      await c.query('ALTER TABLE "JournalLine" ENABLE TRIGGER USER')
      await c.query('ALTER TABLE "JournalEntry" ENABLE TRIGGER USER')
      await c.query('COMMIT')
    } catch (e) {
      await c.query('ROLLBACK')
      throw e
    }
    const left = Number((await c.query(`SELECT count(*)::text n FROM "Reimbursement"`)).rows[0].n)
    const bal = (await c.query(
      `SELECT la.name, (COALESCE(SUM(jl.debit),0)-COALESCE(SUM(jl.credit),0))::text balance
       FROM "LedgerAccount" la LEFT JOIN "JournalLine" jl ON jl."accountId" = la.id
       WHERE la.name LIKE 'Advance — %' GROUP BY la.name HAVING COUNT(jl.id) > 0`,
    )).rows
    console.log(`\nDone. Reimbursement records left: ${left}. Member ledgers still carrying entries: ${bal.length ? JSON.stringify(bal) : 'none'}`)
  } finally {
    await c.end()
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})

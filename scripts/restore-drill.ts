// Restore drill (spec §12.9): prove the newest backup is actually recoverable.
//
//   npm run restore-drill [path/to/backup.ndjson.gz]
//
// The drill restores into a scratch database — never the live one — and then
// re-checks the things that make the books trustworthy: row counts match, and
// every entity still tallies Dr = Cr. The scratch database is dropped at the
// end whether the drill passes or fails.
import 'dotenv/config'
import { readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { execFileSync } from 'child_process'
import { Client } from 'pg'
import { readBackup, restoreInto, tallyByEntity, TABLES } from '../src/lib/backup/dump'

const DRILL_DB = 'ledgerly_restore_drill'

function newestBackup(dir = './backups'): string {
  let entries: string[]
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.ndjson.gz'))
  } catch {
    throw new Error(`No backups directory at ${resolve(dir)} — run "npm run backup" first.`)
  }
  if (entries.length === 0) throw new Error('No backups found — run "npm run backup" first.')
  return entries
    .map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0].f
}

function drillUrl(base: string): string {
  const url = new URL(base)
  url.pathname = `/${DRILL_DB}`
  return url.toString()
}

async function adminQuery(base: string, sql: string) {
  // CREATE/DROP DATABASE cannot run inside a transaction or against the
  // database being dropped, so connect to `postgres` for these.
  const url = new URL(base)
  url.pathname = '/postgres'
  const client = new Client({ connectionString: url.toString() })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const base = process.env.DATABASE_URL
  if (!base) throw new Error('DATABASE_URL is not set')
  const file = resolve(process.argv[2] ?? newestBackup())
  console.log(`Restore drill using ${file}\n`)

  const source = await readBackup(file)
  const sourceTotal = [...source.values()].reduce((n, list) => n + list.length, 0)
  check('backup file is readable and non-empty', sourceTotal > 0, `${sourceTotal} rows`)

  // --- Scratch database, from scratch every time ---
  await adminQuery(base, `DROP DATABASE IF EXISTS "${DRILL_DB}"`)
  await adminQuery(base, `CREATE DATABASE "${DRILL_DB}"`)
  const target = drillUrl(base)

  try {
    // Schema comes from the migrations, exactly as production would get it.
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: target },
      stdio: 'pipe',
    })
    check('migrations apply cleanly to an empty database', true)

    const restored = await restoreInto(target, file)
    check(
      'restore loads every row from the backup',
      restored.total === sourceTotal,
      `${restored.total} of ${sourceTotal}`,
    )

    // Per-table counts must match the source exactly.
    const client = new Client({ connectionString: target })
    await client.connect()
    const mismatches: string[] = []
    let liveRows = 0
    try {
      for (const table of TABLES) {
        const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`)
        const actual = Number(rows[0].n)
        const expected = (source.get(table) ?? []).length
        liveRows += actual
        if (actual !== expected) mismatches.push(`${table}: ${actual}≠${expected}`)
      }
    } finally {
      await client.end()
    }
    check(
      'every table matches the source row-for-row',
      mismatches.length === 0,
      mismatches.slice(0, 4).join(', ') || `${liveRows} rows`,
    )

    // The check that matters: the restored ledger still balances.
    const tallies = await tallyByEntity(target)
    check(
      'restored ledger balances (Dr = Cr) in every entity',
      tallies.every((t) => t.balanced),
      tallies.length
        ? tallies.map((t) => `${t.entityId.slice(0, 6)}…: ${t.debit}/${t.credit}`).join(' ')
        : 'no postings in backup',
    )

    // The safeguards must be live again after the restore, not left disabled.
    const guardClient = new Client({ connectionString: target })
    await guardClient.connect()
    try {
      const { rows } = await guardClient.query<{ relname: string; disabled: string }>(`
        SELECT c.relname, count(*) FILTER (WHERE t.tgenabled = 'D')::text AS disabled
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND c.relname IN ('JournalLine', 'JournalEntry')
        GROUP BY c.relname
      `)
      check(
        'append-only and period-lock triggers are re-enabled after restore',
        rows.length > 0 && rows.every((r) => Number(r.disabled) === 0),
        rows.map((r) => `${r.relname}: ${r.disabled} disabled`).join(', ') || 'no triggers found',
      )

      // And they actually bite: a raw UPDATE against a restored ledger line
      // must still be refused.
      const line = await guardClient.query<{ id: string }>(`SELECT id FROM "JournalLine" LIMIT 1`)
      if (line.rows.length === 0) {
        check('restored ledger rejects tampering (no lines to test)', true, 'skipped')
      } else {
        await guardClient
          .query(`UPDATE "JournalLine" SET debit = debit + 1 WHERE id = $1`, [line.rows[0].id])
          .then(
            () => check('restored ledger still rejects a raw UPDATE on a journal line', false),
            () => check('restored ledger still rejects a raw UPDATE on a journal line', true),
          )
      }
    } finally {
      await guardClient.end()
    }
  } finally {
    await adminQuery(base, `DROP DATABASE IF EXISTS "${DRILL_DB}" WITH (FORCE)`).catch(() => {})
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} drill checks passed`)
  console.log(failed.length ? 'RESTORE DRILL FAILED — do not rely on this backup.' : 'Backup is recoverable.')
  process.exitCode = failed.length ? 1 : 0
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})

import { Client } from 'pg'
import { createWriteStream, createReadStream } from 'fs'
import { createInterface } from 'readline'
import { pipeline } from 'stream/promises'
import { createGzip, createGunzip } from 'zlib'

// Logical backup and restore (spec §12.9).
//
// The embedded Postgres this project runs locally ships only initdb/pg_ctl/
// postgres — no pg_dump, psql, or pg_restore — so backups go through the
// driver instead. That turns out to be the portable choice anyway: the same
// script works against the cloud-hosted production database.
//
// Format is gzipped NDJSON, one line per row, prefixed by a table marker.
// Postgres does the type work in both directions: row_to_json on the way out,
// json_populate_recordset on the way in, so Decimals, dates and JSON columns
// round-trip exactly rather than through a hand-written mapper.

/**
 * Tables in dependency order — parents first. Restore walks this forward,
 * truncate walks it backward.
 *
 * Two shapes need care and are handled in the restore path, not here:
 *   - LedgerAccount.parentId is a self-reference (tree of accounts)
 *   - JournalDoc.currentEntryId ↔ JournalEntry.docId is a genuine cycle
 */
export const TABLES = [
  'User',
  'MemberPermission',
  'Entity',
  'UserEntityScope',
  'BankAccount',
  'CashLocation',
  'LedgerAccount',
  'CostCentre',
  'JournalDoc',
  'JournalEntry',
  'JournalLine',
  'PeriodLock',
  'StatementImport',
  'StatementTransaction',
  'TagRule',
  'StatementMapping',
  'Reimbursement',
  'CashEntry',
  'Bill',
  'SalaryPerson',
  'SalaryRun',
  'SalaryRunLine',
  'Invoice',
  'InvoicePayment',
  'Budget',
  'TaxLine',
  'PaymentPreference',
  'NotificationOutbox',
  'AiCall',
  'StoredFile',
  'AuditLog',
] as const

export type TableName = (typeof TABLES)[number]

/** Tables without a single `id` column — small enough to read in one go. */
const NO_ID_COLUMN = new Set<string>(['MemberPermission', 'UserEntityScope'])

const BATCH = 2000

export interface BackupStats {
  file: string
  rows: Record<string, number>
  total: number
  startedAt: string
  finishedAt: string
}

/**
 * Stream every table to a gzipped NDJSON file. Reads with keyset pagination
 * so memory stays flat regardless of ledger size.
 */
export async function backupTo(connectionString: string, file: string): Promise<BackupStats> {
  const client = new Client({ connectionString })
  await client.connect()
  const startedAt = new Date().toISOString()
  const rows: Record<string, number> = {}

  const gzip = createGzip()
  const out = createWriteStream(file)
  const done = pipeline(gzip, out)

  const write = (line: string) =>
    new Promise<void>((resolve, reject) => {
      // Respect backpressure — a large ledger will fill the buffer.
      gzip.write(line, (e) => (e ? reject(e) : resolve()))
    })

  try {
    await write(
      JSON.stringify({ _meta: { version: 1, startedAt, tables: TABLES } }) + '\n',
    )

    for (const table of TABLES) {
      let count = 0
      if (NO_ID_COLUMN.has(table)) {
        const result = await client.query(`SELECT row_to_json(t) AS row FROM "${table}" t`)
        for (const r of result.rows) {
          await write(JSON.stringify({ t: table, r: r.row }) + '\n')
          count++
        }
      } else {
        let after: string | null = null
        for (;;) {
          const result: { rows: { id: string; row: unknown }[] } = after
            ? await client.query(
                `SELECT id, row_to_json(t) AS row FROM "${table}" t WHERE id > $1 ORDER BY id LIMIT ${BATCH}`,
                [after],
              )
            : await client.query(
                `SELECT id, row_to_json(t) AS row FROM "${table}" t ORDER BY id LIMIT ${BATCH}`,
              )
          if (result.rows.length === 0) break
          for (const r of result.rows) {
            await write(JSON.stringify({ t: table, r: r.row }) + '\n')
            count++
          }
          after = result.rows[result.rows.length - 1].id
          if (result.rows.length < BATCH) break
        }
      }
      rows[table] = count
    }
  } finally {
    gzip.end()
    await done
    await client.end()
  }

  return {
    file,
    rows,
    total: Object.values(rows).reduce((a, b) => a + b, 0),
    startedAt,
    finishedAt: new Date().toISOString(),
  }
}

/** Read a backup file back into memory, grouped by table. */
export async function readBackup(file: string): Promise<Map<string, unknown[]>> {
  const byTable = new Map<string, unknown[]>()
  const lines = createInterface({
    input: createReadStream(file).pipe(createGunzip()),
    crlfDelay: Infinity,
  })
  for await (const line of lines) {
    if (!line.trim()) continue
    const parsed = JSON.parse(line) as { _meta?: unknown; t?: string; r?: unknown }
    if (parsed._meta) continue
    if (!parsed.t) continue
    const list = byTable.get(parsed.t) ?? []
    list.push(parsed.r)
    byTable.set(parsed.t, list)
  }
  return byTable
}

export interface RestoreStats {
  rows: Record<string, number>
  total: number
}

/**
 * Load a backup into a target database.
 *
 * User triggers are disabled for the load and re-enabled after. That is what
 * pg_restore does too, and it is required here rather than merely faster:
 * the ledger's own safeguards (append-only, period locks, deferred Dr=Cr)
 * would otherwise reject a faithful restore of, say, a locked month.
 * The caller is expected to re-verify the invariants afterwards — the
 * restore drill does exactly that.
 */
export async function restoreInto(
  connectionString: string,
  file: string,
): Promise<RestoreStats> {
  const data = await readBackup(file)
  const client = new Client({ connectionString })
  await client.connect()
  const rows: Record<string, number> = {}

  const guarded = ['JournalLine', 'JournalEntry']
  try {
    await client.query('BEGIN')
    for (const t of guarded) await client.query(`ALTER TABLE "${t}" DISABLE TRIGGER USER`)

    // Clear the target, children first.
    for (const table of [...TABLES].reverse()) {
      await client.query(`DELETE FROM "${table}"`)
    }

    for (const table of TABLES) {
      const list = data.get(table) ?? []
      rows[table] = list.length
      if (list.length === 0) continue

      // The two structural exceptions: null out the forward references on the
      // first pass, then fix them up once every row exists.
      let payload = list
      if (table === 'LedgerAccount') {
        payload = list.map((r) => ({ ...(r as object), parentId: null }))
      } else if (table === 'JournalDoc') {
        payload = list.map((r) => ({ ...(r as object), currentEntryId: null }))
      }

      for (let i = 0; i < payload.length; i += BATCH) {
        const chunk = payload.slice(i, i + BATCH)
        await client.query(
          `INSERT INTO "${table}" SELECT * FROM json_populate_recordset(null::"${table}", $1::json)`,
          [JSON.stringify(chunk)],
        )
      }
    }

    // Second pass for the deferred references.
    const accounts = (data.get('LedgerAccount') ?? []) as { id: string; parentId: string | null }[]
    for (const a of accounts.filter((x) => x.parentId)) {
      await client.query(`UPDATE "LedgerAccount" SET "parentId" = $1 WHERE id = $2`, [a.parentId, a.id])
    }
    const docs = (data.get('JournalDoc') ?? []) as { id: string; currentEntryId: string | null }[]
    for (const d of docs.filter((x) => x.currentEntryId)) {
      await client.query(`UPDATE "JournalDoc" SET "currentEntryId" = $1 WHERE id = $2`, [
        d.currentEntryId,
        d.id,
      ])
    }

    for (const t of guarded) await client.query(`ALTER TABLE "${t}" ENABLE TRIGGER USER`)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    await client.end()
  }

  return { rows, total: Object.values(rows).reduce((a, b) => a + b, 0) }
}

/** Whole-database Dr = Cr, per entity. The check a restore has to survive. */
export async function tallyByEntity(connectionString: string) {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    const result = await client.query<{ entityId: string; debit: string; credit: string }>(`
      SELECT e."entityId", SUM(l.debit)::text AS debit, SUM(l.credit)::text AS credit
      FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId"
      GROUP BY e."entityId"
    `)
    return result.rows.map((r) => ({
      entityId: r.entityId,
      debit: r.debit,
      credit: r.credit,
      balanced: Number(r.debit) === Number(r.credit),
    }))
  } finally {
    await client.end()
  }
}

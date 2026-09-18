// Restore a backup into the database at DATABASE_URL — the real one, unlike
// the restore drill. Used to move the books onto a new server.
//
//   npm run restore -- path/to/backup.ndjson.gz            (target must hold no entries)
//   npm run restore -- path/to/backup.ndjson.gz --replace  (wipe whatever is there)
//
// The target's schema must already exist (`npx prisma migrate deploy`). The
// matching "<backup>-uploads" folder, when present, is copied into ./uploads —
// or uploaded to Vercel Blob when BLOB_READ_WRITE_TOKEN is set.
import 'dotenv/config'
import { cpSync, existsSync } from 'fs'
import { resolve } from 'path'
import { Client } from 'pg'
import { restoreInto, tallyByEntity } from '../src/lib/backup/dump'
import { blobConfigured, uploadDirToBlob } from './lib/blob-uploads'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  const args = process.argv.slice(2)
  const replace = args.includes('--replace')
  const fileArg = args.find((a) => !a.startsWith('--'))
  if (!fileArg) throw new Error('Usage: npm run restore -- <backup.ndjson.gz> [--replace]')
  const file = resolve(fileArg)
  if (!existsSync(file)) throw new Error(`No backup at ${file}`)

  // restoreInto clears every table first — refuse to do that to live books
  // unless explicitly told to.
  const client = new Client({ connectionString: url })
  await client.connect()
  let existing: number
  try {
    const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM "JournalEntry"`)
    existing = Number(rows[0].n)
  } finally {
    await client.end()
  }
  if (existing > 0 && !replace) {
    throw new Error(
      `Target already holds ${existing.toLocaleString('en-IN')} journal entries. ` +
        `Re-run with --replace to wipe it and load the backup.`,
    )
  }

  console.log(`Restoring ${file}`)
  const stats = await restoreInto(url, file)
  for (const [table, n] of Object.entries(stats.rows).filter(([, n]) => n > 0)) {
    console.log(`  ${table.padEnd(24)}${n.toLocaleString('en-IN')}`)
  }
  console.log(`\n${stats.total.toLocaleString('en-IN')} rows restored`)

  const uploads = file.replace(/\.ndjson\.gz$/, '-uploads')
  if (existsSync(uploads)) {
    if (blobConfigured()) {
      const n = await uploadDirToBlob(uploads, url)
      console.log(`Documents: ${n} file(s) from ${uploads} uploaded to Vercel Blob`)
    } else {
      cpSync(uploads, resolve('./uploads'), { recursive: true })
      console.log(`Documents: ${uploads} copied to uploads/`)
    }
  }

  const tallies = await tallyByEntity(url)
  const broken = tallies.filter((t) => !t.balanced)
  if (broken.length > 0) {
    throw new Error(`Dr ≠ Cr after restore in: ${broken.map((t) => t.entityId).join(', ')}`)
  }
  console.log(`Ledger balances (Dr = Cr) in all ${tallies.length} book(s)`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})

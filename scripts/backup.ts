// Take a backup (spec §12.9).
//
//   npm run backup            → ./backups/ledgerly-<timestamp>.ndjson.gz
//   npm run backup -- /path/to/file.ndjson.gz
//
// Restores are proven by `npm run restore-drill`, which loads the newest
// backup into a scratch database and re-checks the ledger invariants there.
// A backup nobody has restored is a hope, not a backup.
import 'dotenv/config'
import { cpSync, existsSync, mkdirSync, statSync } from 'fs'
import { dirname, resolve } from 'path'
import { backupTo } from '../src/lib/backup/dump'
import { blobConfigured, downloadBlobUploads } from './lib/blob-uploads'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = resolve(process.argv[2] ?? `./backups/ledgerly-${stamp}.ndjson.gz`)
  mkdirSync(dirname(file), { recursive: true })

  console.log(`Backing up to ${file}`)
  const stats = await backupTo(url, file)

  const nonEmpty = Object.entries(stats.rows).filter(([, n]) => n > 0)
  for (const [table, n] of nonEmpty) {
    console.log(`  ${table.padEnd(24)}${n.toLocaleString('en-IN')}`)
  }
  const bytes = statSync(file).size
  console.log(
    `\n${stats.total.toLocaleString('en-IN')} rows across ${nonEmpty.length} table(s), ` +
      `${(bytes / 1024).toFixed(1)} KB compressed`,
  )

  // Uploaded documents live outside the database — snapshot them next to the
  // dump so a restore can put the bytes back too. They come from Vercel Blob
  // on the hosted deployment, from uploads/ everywhere else.
  const dest = file.replace(/\.ndjson\.gz$/, '-uploads')
  if (blobConfigured()) {
    const n = await downloadBlobUploads(dest)
    console.log(`Documents: ${n} file(s) downloaded from Vercel Blob to ${dest}`)
  } else if (existsSync(resolve('./uploads'))) {
    cpSync(resolve('./uploads'), dest, { recursive: true })
    console.log(`Documents: uploads/ copied to ${dest}`)
  }
  console.log('Verify it restores:  npm run restore-drill')
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})

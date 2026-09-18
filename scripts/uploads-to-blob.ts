// One-time move of the local documents into Vercel Blob, when switching the
// app from disk storage to the hosted deployment.
//
//   BLOB_READ_WRITE_TOKEN=... DATABASE_URL=<production> npm run uploads-to-blob
//   (or DOTENV_CONFIG_PATH=.env.prod npm run uploads-to-blob)
//
// Safe to re-run: existing blobs are overwritten with the same bytes.
import 'dotenv/config'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { blobConfigured, uploadDirToBlob } from './lib/blob-uploads'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  if (!blobConfigured()) throw new Error('BLOB_READ_WRITE_TOKEN is not set')
  const dir = resolve(process.argv[2] ?? './uploads')
  if (!existsSync(dir)) throw new Error(`No folder at ${dir}`)
  console.log(`Uploading ${dir} to Vercel Blob`)
  const n = await uploadDirToBlob(dir, url)
  console.log(`${n} document(s) uploaded`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})

// Move stored documents between the local uploads/ folder and Vercel Blob.
// The key is the StoredFile id in both places (see src/lib/files.ts), so no
// database row changes when files move.
import { createWriteStream, mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { get, list, put } from '@vercel/blob'
import { Client } from 'pg'

const PREFIX = 'uploads/'

export function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN)
}

/** Upload every file in `dir` to the private Blob store. Returns the count. */
export async function uploadDirToBlob(dir: string, databaseUrl: string): Promise<number> {
  // Content types come from the StoredFile rows; unknown ids still upload.
  const mimes = new Map<string, string>()
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const { rows } = await client.query<{ id: string; mime: string }>('SELECT id, mime FROM "StoredFile"')
    for (const row of rows) mimes.set(row.id, row.mime)
  } finally {
    await client.end()
  }

  let count = 0
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    await put(PREFIX + name, readFileSync(join(dir, name)), {
      access: 'private',
      contentType: mimes.get(name) ?? 'application/octet-stream',
      addRandomSuffix: false,
      allowOverwrite: true,
    })
    count++
  }
  return count
}

/** Download every document in the Blob store into `dir`. Returns the count. */
export async function downloadBlobUploads(dir: string): Promise<number> {
  mkdirSync(dir, { recursive: true })
  let count = 0
  let cursor: string | undefined
  do {
    const page = await list({ prefix: PREFIX, cursor, limit: 1000 })
    for (const blob of page.blobs) {
      const id = blob.pathname.slice(PREFIX.length)
      if (!id || id.includes('/')) continue
      const result = await get(blob.pathname, { access: 'private' })
      if (!result?.stream) continue
      const body = Readable.fromWeb(result.stream as unknown as import('stream/web').ReadableStream<Uint8Array>)
      await pipeline(body, createWriteStream(join(dir, id)))
      count++
    }
    cursor = page.hasMore ? page.cursor : undefined
  } while (cursor)
  return count
}

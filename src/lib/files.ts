import 'server-only'
import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import { get, put } from '@vercel/blob'
import { prisma } from '@/lib/db'

// Document storage: metadata in StoredFile, bytes in one of two places,
// served behind auth at /files/<id>. Callers put the returned "/files/<id>"
// URL into the same link fields Drive links use, so every existing row
// renderer works unchanged.
//
//   - Vercel Blob (private store) when BLOB_READ_WRITE_TOKEN is set — the
//     hosted deployment, where the function filesystem does not persist.
//   - Disk under uploads/<id> (gitignored) otherwise — local dev and the
//     Docker/VPS stack.
//
// Both keep the same key, the StoredFile id, so a file can be moved between
// them (scripts/uploads-to-blob.ts) without touching any database row.

const UPLOAD_DIR = path.join(process.cwd(), 'uploads')
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

export function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN)
}

/** Blob pathname for a stored file id. */
export function blobPathname(id: string): string {
  return `uploads/${id}`
}

/** Absolute disk path for a stored file id (validated by the caller). */
export function storedFilePath(id: string): string {
  return path.join(UPLOAD_DIR, id)
}

/** Persist an uploaded file; returns the app URL to store in a link field. */
export async function saveUpload(file: File, actorId: string): Promise<string> {
  if (file.size === 0) throw new Error(`${file.name || 'File'} is empty`)
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is over 10 MB`)
  const record = await prisma.storedFile.create({
    data: {
      fileName: file.name || 'document',
      mime: file.type || 'application/octet-stream',
      size: file.size,
      uploadedById: actorId,
    },
  })
  const bytes = Buffer.from(await file.arrayBuffer())
  await putStoredBytes(record.id, bytes, record.mime)
  return `/files/${record.id}`
}

/** Write bytes for a stored file id to whichever store is configured. */
export async function putStoredBytes(id: string, bytes: Buffer, mime: string): Promise<void> {
  if (blobConfigured()) {
    await put(blobPathname(id), bytes, {
      access: 'private',
      contentType: mime,
      addRandomSuffix: false,
      allowOverwrite: true,
    })
    return
  }
  await mkdir(UPLOAD_DIR, { recursive: true })
  await writeFile(storedFilePath(id), bytes)
}

/**
 * Read a stored file as a byte stream, or null when the bytes are missing.
 * Streams rather than buffering so a 10 MB PDF does not sit in memory twice.
 */
export async function readStoredStream(id: string): Promise<ReadableStream<Uint8Array> | null> {
  if (blobConfigured()) {
    const result = await get(blobPathname(id), { access: 'private' }).catch(() => null)
    return result?.stream ?? null
  }
  const bytes = await readFile(storedFilePath(id)).catch(() => null)
  if (!bytes) return null
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes))
      controller.close()
    },
  })
}

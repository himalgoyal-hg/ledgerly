import 'server-only'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { prisma } from '@/lib/db'

// Document storage: bytes on disk under uploads/<id> (gitignored), metadata
// in StoredFile, serving behind auth at /files/<id>. Callers put the
// returned "/files/<id>" URL into the same link fields Drive links use, so
// every existing row renderer works unchanged.

const UPLOAD_DIR = path.join(process.cwd(), 'uploads')
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

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
  await mkdir(UPLOAD_DIR, { recursive: true })
  await writeFile(path.join(UPLOAD_DIR, record.id), Buffer.from(await file.arrayBuffer()))
  return `/files/${record.id}`
}

/** Absolute disk path for a stored file id (validated by the caller). */
export function storedFilePath(id: string): string {
  return path.join(UPLOAD_DIR, id)
}

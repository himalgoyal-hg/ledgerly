import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { readStoredStream } from '@/lib/files'

// Serve uploaded documents. Financial paperwork must never be public: any
// signed-in member may fetch (the link only appears on screens their
// permissions already gate); anonymous hits bounce to /login via requireUser.
// The bytes come from Vercel Blob or local disk — see lib/files.

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await requireUser()
  const { id } = await ctx.params
  // cuid ids are alphanumeric — anything else is a path-traversal attempt.
  if (!/^[a-z0-9]+$/i.test(id)) return new NextResponse('Not found', { status: 404 })
  const record = await prisma.storedFile.findUnique({ where: { id } })
  if (!record) return new NextResponse('Not found', { status: 404 })
  const stream = await readStoredStream(id)
  if (!stream) return new NextResponse('File missing from storage', { status: 404 })
  // ?download=1 hands the file back as a download instead of showing it.
  const asDownload = new URL(req.url).searchParams.has('download')
  return new NextResponse(stream, {
    headers: {
      'Content-Type': record.mime,
      'Content-Disposition': `${asDownload ? 'attachment' : 'inline'}; filename="${record.fileName.replace(/["\\]/g, '')}"`,
      'Content-Length': String(record.size),
      'Cache-Control': 'private, max-age=3600',
    },
  })
}

'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

// Net capital: a hand-kept sources-and-application statement. Rows are
// edited in place; the nets are computed on the page. Nothing posts.

const SECTIONS = ['INCOME', 'LIABILITY', 'APPLICATION', 'TAXPAID', 'BANK'] as const

const field = (fd: FormData, name: string) => String(fd.get(name) ?? '').trim()

/** "₹45,00,000" / "4500000" → "4500000.00"-style string, or null when blank. */
function amount(fd: FormData, name: string): string | null {
  const raw = field(fd, name).replace(/[,₹\s]/g, '')
  if (!raw) return null
  if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) throw new Error(`Bad amount for ${name}`)
  return raw
}

function lineData(fd: FormData) {
  return {
    name: field(fd, 'name'),
    taxStatus: field(fd, 'taxStatus') || null,
    amountNew: amount(fd, 'amountNew'),
    amountTotal: amount(fd, 'amountTotal'),
    synergy: amount(fd, 'synergy'),
    fyFigure: amount(fd, 'fyFigure'),
    remaining: amount(fd, 'remaining'),
  }
}

export async function saveNetCapitalLineAction(formData: FormData) {
  await requireAdmin()
  const id = field(formData, 'lineId')
  const data = lineData(formData)
  if (!data.name) throw new Error('Name is required')
  await prisma.netCapitalLine.update({ where: { id }, data })
  revalidatePath('/net-capital')
}

export async function addNetCapitalLineAction(formData: FormData) {
  await requireAdmin()
  const section = field(formData, 'section')
  if (!SECTIONS.includes(section as (typeof SECTIONS)[number])) throw new Error('Bad section')
  const data = lineData(formData)
  if (!data.name) throw new Error('Name is required')
  const last = await prisma.netCapitalLine.findFirst({ orderBy: { sortOrder: 'desc' } })
  await prisma.netCapitalLine.create({
    data: { section, sortOrder: (last?.sortOrder ?? 0) + 1, ...data },
  })
  revalidatePath('/net-capital')
}

/** Remove = archive; the row leaves the statement but stays in the DB. */
export async function deleteNetCapitalLineAction(formData: FormData) {
  await requireAdmin()
  await prisma.netCapitalLine.update({
    where: { id: field(formData, 'lineId') },
    data: { archivedAt: new Date() },
  })
  revalidatePath('/net-capital')
}

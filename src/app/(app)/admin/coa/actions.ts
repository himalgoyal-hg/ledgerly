'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { nextChildCode } from '@/lib/ledger/coa'
import { resolveCostCentre } from '@/lib/ops/cost-centres'

// Chart of Accounts management — Admin can add heads under any group
// (spec §4). System accounts cannot be archived; accounts with postings
// cannot be archived either (they'd hide balances).

const accountSchema = z.object({
  entityId: z.string().min(1),
  parentId: z.string().min(1, 'Choose a group'),
  name: z.string().trim().min(1, 'Name is required'),
})

export async function createAccount(formData: FormData) {
  const admin = await requireAdmin()
  const parsed = accountSchema.safeParse({
    entityId: formData.get('entityId'),
    parentId: formData.get('parentId'),
    name: formData.get('name'),
  })
  if (!parsed.success) throw new Error(parsed.error.issues[0].message)
  const { entityId, parentId, name } = parsed.data

  await auditedTransaction(async (tx) => {
    const parent = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: parentId } })
    if (parent.entityId !== entityId || !parent.isGroup) {
      throw new Error('Parent must be a group account of this entity')
    }
    const code = await nextChildCode(tx, entityId, parent.code)
    const account = await tx.ledgerAccount.create({
      data: { entityId, parentId, code, name, kind: parent.kind },
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'coa.create',
      targetType: 'LedgerAccount',
      targetId: account.id,
      summary: `Added account ${code} · ${name} under ${parent.name}`,
      after: { code, name, kind: parent.kind, parent: parent.name },
    })
  })
  revalidatePath('/admin/coa')
}

export async function archiveAccount(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  await auditedTransaction(async (tx) => {
    const account = await tx.ledgerAccount.findUniqueOrThrow({
      where: { id },
      include: { _count: { select: { lines: true, children: true } } },
    })
    if (account.system) throw new Error('System accounts cannot be archived')
    if (account._count.lines > 0)
      throw new Error('Account has postings — it cannot be archived')
    if (account._count.children > 0)
      throw new Error('Archive the child accounts first')
    await tx.ledgerAccount.update({ where: { id }, data: { archivedAt: new Date() } })
    await audit(tx, {
      actorId: admin.id,
      action: 'coa.archive',
      targetType: 'LedgerAccount',
      targetId: id,
      summary: `Archived account ${account.code} · ${account.name}`,
    })
  })
  revalidatePath('/admin/coa')
}

export async function restoreAccount(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  await auditedTransaction(async (tx) => {
    const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { id } })
    if (!account.archivedAt) throw new Error('Account is not archived')
    await tx.ledgerAccount.update({ where: { id }, data: { archivedAt: null } })
    await audit(tx, {
      actorId: admin.id,
      action: 'coa.restore',
      targetType: 'LedgerAccount',
      targetId: id,
      summary: `Restored account ${account.code} · ${account.name}`,
    })
  })
  revalidatePath('/admin/coa')
}

// setDefaultCostCentre used to live here — a per-head cost-centre setter
// that wrote LedgerAccount.defaultCostCentreId directly. Removed 19 Aug
// 2026: it bypassed the master register entirely (no HeadMode row updated,
// no retro-propagation to tags, rules, cash entries or posted lines), so
// any screen wired to it would have silently desynced the books from the
// master. Cost centres are set on the master row — saveMasterRowAction →
// applyMasterRow — which is the only path that keeps everything in step.

/** Rename a ledger account — code, kind and history stay put. */
export async function renameAccount(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Name is required')

  await auditedTransaction(async (tx) => {
    const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { id } })
    await tx.ledgerAccount.update({ where: { id }, data: { name } })
    await audit(tx, {
      actorId: admin.id,
      action: 'account.rename',
      targetType: 'LedgerAccount',
      targetId: id,
      summary: `Renamed account ${account.code} "${account.name}" → "${name}"`,
      before: { name: account.name },
      after: { name },
    })
  })
  revalidatePath('/admin/coa')
}

/**
 * Edit one master row in the app — the same propagation as the sheet sync,
 * for a single category: plan lines, HeadMode mirror (bank link), budgets,
 * cost-centre defaults. The app is a first-class editor of the master.
 */
export async function saveMasterRowAction(formData: FormData) {
  const admin = await requireAdmin()
  const f = (n: string) => String(formData.get(n) ?? '').trim()
  const num = (n: string) => {
    const raw = f(n).replace(/[,₹\s]/g, '')
    if (!raw) return 0
    const v = Number(raw)
    if (!Number.isFinite(v)) throw new Error(`Bad amount in ${n}`)
    return v
  }
  const books = f('books')
  if (books && !['HG', 'ACPL', 'MG', 'PG', 'CASH'].includes(books)) throw new Error('Bad books')
  // The category's Accounting Head: same as the category (the default the
  // column shows) normalizes to NULL — "by default je aahe te, expense head".
  const acctRaw = f('accountingHead') || f('accountingHeadNew')
  const accountingHead =
    acctRaw && acctRaw.toLowerCase() !== f('category').toLowerCase() ? acctRaw : null
  const row = {
    category: f('category'),
    ...(formData.has('section') || formData.has('sectionNew')
      ? { section: f('section') || f('sectionNew') || null }
      : {}),
    books: books || null,
    bankMode: f('bankMode') || null,
    // a picked option or a typed new name — applyMasterRow finds-or-creates
    // the centre in every books this category's heads live in
    expenseType: f('expenseType') || f('expenseTypeNew') || null,
    bankBudget: num('bankBudget'),
    cashBudget: num('cashBudget'),
    frequency: f('frequency') || null,
    dayNote: f('dayNote') || null,
    nature: f('nature') || null,
    ...(formData.has('accountingHead') || formData.has('accountingHeadNew') ? { accountingHead } : {}),
  }
  if ((row.bankBudget !== 0 || row.cashBudget !== 0) && !row.frequency) {
    throw new Error('A budget needs its frequency')
  }
  const { applyMasterRow } = await import('@/lib/budget/master-sync')
  await applyMasterRow(row)
  await auditedTransaction(async (tx) => {
    await audit(tx, {
      actorId: admin.id,
      action: 'master.row_save',
      targetType: 'HeadMode',
      targetId: row.category,
      summary: `Master row "${row.category}": bank ₹${row.bankBudget} / cash ₹${row.cashBudget} ${row.frequency ?? ''} · ${row.bankMode ?? 'no mode'} · ${row.expenseType ?? 'no CC'}`,
      after: { ...row },
    })
  })
  for (const p of ['/admin/coa', '/reports/cash-flow', '/reports/budget', '/reports/monthly', '/reports/mode', '/tagging']) revalidatePath(p)
}

export async function removeMasterRowAction(formData: FormData) {
  const admin = await requireAdmin()
  const category = String(formData.get('category') ?? '').trim()
  if (!category) throw new Error('Category is required')
  const { removeMasterRow } = await import('@/lib/budget/master-sync')
  await removeMasterRow(category)
  await auditedTransaction(async (tx) => {
    await audit(tx, {
      actorId: admin.id,
      action: 'master.row_remove',
      targetType: 'HeadMode',
      targetId: category,
      summary: `Master row removed: "${category}" (plan lines + FY budgets cleared; heads and postings stay)`,
    })
  })
  for (const p of ['/admin/coa', '/reports/cash-flow', '/reports/budget', '/reports/monthly', '/reports/mode']) revalidatePath(p)
}

/**
 * A head's opening balance, set from the register. The posting itself lives
 * in `lib/ledger/opening.ts` so it can be tested without Next's
 * server-action plumbing.
 */
export async function setHeadOpeningBalanceAction(formData: FormData) {
  const admin = await requireAdmin()
  const entityId = String(formData.get('entityId') ?? '')
  const category = String(formData.get('category') ?? '').trim()
  const amount = String(formData.get('openingBalance') ?? '')
  if (!category) throw new Error('Which head?')

  await auditedTransaction(async (tx) => {
    const { setHeadOpeningBalance, openingDateFor } = await import('@/lib/ledger/opening')
    const res = await setHeadOpeningBalance(tx, { entityId, category, amount, actorId: admin.id })
    if (res.action === 'unchanged') return
    await audit(tx, {
      actorId: admin.id,
      action: res.action === 'cleared' ? 'opening_balance.clear' : 'opening_balance.set',
      targetType: 'LedgerAccount',
      targetId: res.headId!,
      summary:
        res.action === 'cleared'
          ? `Cleared opening balance for ${category}`
          : `Opening balance for ${category}: \u20b9${res.amount} as at ${openingDateFor().toISOString().slice(0, 10)}`,
    })
  })
  for (const p of ['/admin/coa', '/reports/balance-sheet', '/admin/ledgers']) revalidatePath(p)
}

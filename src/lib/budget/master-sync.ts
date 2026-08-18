import 'server-only'
import { prisma } from '@/lib/db'
import { resolveHeadAccount } from '@/lib/ops/heads'
import { syncBudgetForHead } from '@/lib/budget/plan'

// One master, everywhere: "New Finance setup HG" (the Google Sheet tab) is
// fetched LIVE and pushed through the whole app in one sweep —
//   1. recurring plan lines (cashflow) rebuilt wholesale, ONCE lines kept
//   2. heads created where missing (so tagging knows every category)
//   3. HeadMode refreshed (Actual vs Plan Mode reads the same truth)
//   4. default cost centres set on every same-named head, all books
//   5. Budget rows (Budget vs Actual / Expenses M/M) re-synced per head,
//      and CLEARED for categories the master zeroes out
// Run it from the button on Accounts whenever the sheet changes.

const MASTER_CSV_URL =
  'https://docs.google.com/spreadsheets/d/15kvgIkhuJTQRmCJF4tq1gvKJl7os4Hpl3bmLZmmR2mA/export?format=csv&gid=611479732'

export interface MasterRow {
  category: string
  bankMode: string | null
  expenseType: string | null
  bankBudget: number
  cashBudget: number
  frequency: string | null
  dayNote: string | null
}

const FREQ: Record<string, string> = {
  Daily: 'DAILY', Weekly: 'WEEKLY', Monthly: 'MONTHLY',
  Quarterly: 'QUARTERLY', 'Half yearly': 'HALF_YEARLY', Annual: 'ANNUAL',
}
const TYPES = new Set(['Compulsory', 'Optional-Lifestyle', 'Optional-growth', 'Optional-Investment'])

/** Minimal CSV parser — quoted fields may hold commas and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') inQuotes = false
      else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      rows.push(row); row = []
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

export function parseMaster(csv: string): MasterRow[] {
  const num = (s: string) => {
    const n = Number(s.replace(/[,₹\s]/g, ''))
    return Number.isFinite(n) ? n : 0
  }
  const out: MasterRow[] = []
  for (const r of parseCsv(csv).slice(3)) {
    if (r.length < 8) continue
    const category = (r[0] ?? '').trim()
    if (!category) continue
    let dayNote = (r[6] ?? '').trim()
    if (dayNote === '#REF!') dayNote = ''
    const etype = (r[2] ?? '').trim()
    out.push({
      category,
      bankMode: (r[1] ?? '').trim() || null,
      expenseType: TYPES.has(etype) ? etype : null,
      bankBudget: num(r[3] ?? ''),
      cashBudget: num(r[4] ?? ''),
      frequency: FREQ[(r[5] ?? '').trim()] ?? null,
      dayNote: dayNote || null,
    })
  }
  return out
}

/** "HDFC 2762" → the app's own BankAccount, by number digits or name. */
function resolveBank(
  banks: { id: string; nickname: string; accountNumber: string }[],
  mode: string,
): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/meena/g, 'mg').replace(/himal/g, 'hg')
  const m = norm(mode)
  const digits = m.match(/\d{3,}/g) ?? []
  if (digits.length) {
    const hit = banks.find((b) => digits.some((d) => b.accountNumber.endsWith(d) || norm(b.nickname).includes(d)))
    if (hit) return hit.id
  }
  const tokens = m.split(/[^a-z0-9]+/).filter((t) => t && !['bank', 'account', 'balance'].includes(t))
  const hit = banks.find((b) => tokens.length > 0 && tokens.every((t) => norm(b.nickname).includes(t)))
  return hit?.id ?? null
}

function poolOf(bankMode: string | null, oldPool: string | null): string {
  if (!bankMode) return oldPool ?? 'CASH'
  const m = bankMode.toLowerCase()
  if (m === 'cash') return 'CASH'
  if (m.includes('7838') || m.startsWith('acpl')) return 'ACPL'
  if (m.includes('meena')) return 'MG'
  return 'HG' // 2762 / 4271 / HG ICICI / Greeshma balance
}

export interface MasterSyncSummary {
  recurring: number
  onceKept: number
  headsSynced: number
  costCentresSet: number
  budgetsCleared: number
}

export async function syncFromMaster(csvText?: string): Promise<MasterSyncSummary> {
  const csv =
    csvText ??
    (await (async () => {
      const res = await fetch(MASTER_CSV_URL, { cache: 'no-store' })
      if (!res.ok) throw new Error(`Master sheet fetch failed (${res.status}) — is the sheet link-shared?`)
      return res.text()
    })())
  const rows = parseMaster(csv)
  if (rows.length < 20) throw new Error(`Master sheet looks wrong — only ${rows.length} rows parsed`)
  const active = rows.filter((r) => r.frequency && (r.bankBudget !== 0 || r.cashBudget !== 0))

  const old = await prisma.budgetLine.findMany({ where: { archivedAt: null, frequency: { not: 'ONCE' } } })
  const oldByLabel = new Map(old.map((l) => [l.label.toLowerCase(), l]))
  const banks = await prisma.bankAccount.findMany({
    where: { archivedAt: null },
    select: { id: true, nickname: true, accountNumber: true },
  })

  const touchedHeads = new Set<string>()
  await prisma.$transaction(
    async (tx) => {
      await tx.budgetLine.deleteMany({ where: { archivedAt: null, frequency: { not: 'ONCE' } } })
      for (const r of active) {
        const prev = oldByLabel.get(r.category.toLowerCase()) ?? null
        const parts: { source: string; amount: number }[] = []
        if (r.bankBudget !== 0) parts.push({ source: poolOf(r.bankMode, prev?.source ?? null), amount: r.bankBudget })
        if (r.cashBudget !== 0) parts.push({ source: 'CASH', amount: r.cashBudget })
        for (const part of parts) {
          const heads = await tx.ledgerAccount.findMany({
            where: { isGroup: false, archivedAt: null, name: { equals: r.category, mode: 'insensitive' } },
            include: { entity: { select: { code: true } } },
          })
          const head =
            heads.find((h) => h.entity.code === part.source) ??
            heads.find((h) => h.entity.code === 'HG') ??
            heads[0] ??
            null
          const entity = head
            ? await tx.entity.findUniqueOrThrow({ where: { id: head.entityId } })
            : await tx.entity.findFirstOrThrow({ where: { code: part.source === 'CASH' ? 'HG' : part.source } })
          const headAccountId =
            head?.id ??
            (await resolveHeadAccount(tx, { entityId: entity.id, headText: r.category, isOutflow: part.amount > 0 }))
          await tx.budgetLine.create({
            data: {
              entityId: entity.id,
              headAccountId,
              label: r.category,
              source: part.source,
              frequency: r.frequency as string,
              amount: part.amount.toFixed(2),
              onMonth: null,
              expenseType: r.expenseType,
              taxTreatment: prev?.taxTreatment ?? null,
              dayNote: r.dayNote,
            },
          })
          touchedHeads.add(headAccountId)
        }
        if (r.bankMode || r.expenseType) {
          const bankAccountId = r.bankMode ? resolveBank(banks, r.bankMode) : null
          await tx.headMode.upsert({
            where: { category: r.category },
            create: { category: r.category, modeBank: r.bankMode, modeCc: null, expenseType: r.expenseType, bankAccountId },
            update: { modeBank: r.bankMode ?? undefined, expenseType: r.expenseType ?? undefined, bankAccountId },
          })
        }
      }
    },
    { timeout: 120_000 },
  )

  for (const headId of touchedHeads) {
    await prisma.$transaction((tx) => syncBudgetForHead(tx, headId))
  }

  // Categories the master zeroes out lose their FY 2026-27 budget rows —
  // Budget vs Actual and Expenses M/M then read exactly what the sheet says.
  let budgetsCleared = 0
  const inactive = rows.filter((r) => !r.frequency || (r.bankBudget === 0 && r.cashBudget === 0))
  for (const r of inactive) {
    const heads = await prisma.ledgerAccount.findMany({
      where: { isGroup: false, name: { equals: r.category, mode: 'insensitive' } },
      select: { id: true },
    })
    if (!heads.length) continue
    const del = await prisma.budget.deleteMany({
      where: {
        accountId: { in: heads.map((h) => h.id) },
        OR: [
          { year: 2026, month: { gte: 4 } },
          { year: 2027, month: { lte: 3 } },
        ],
      },
    })
    budgetsCleared += del.count
  }

  // Default cost centres from the sheet's column, on every same-named head.
  const strip = (s: string) => s.toLowerCase().trim().replace(/^optional-?\s*/, '')
  const ALIAS: Record<string, string> = { investment: 'invesment' }
  let costCentresSet = 0
  for (const r of rows.filter((x) => x.expenseType)) {
    const heads = await prisma.ledgerAccount.findMany({
      where: { isGroup: false, archivedAt: null, name: { equals: r.category, mode: 'insensitive' } },
    })
    for (const head of heads) {
      const existing = await prisma.costCentre.findMany({ where: { entityId: head.entityId, archivedAt: null } })
      const want = r.expenseType as string
      const ws = strip(want)
      const cc =
        existing.find((c) => c.name.toLowerCase() === want.toLowerCase()) ??
        existing.find((c) => strip(c.name) === ws || c.name.toLowerCase() === ws || c.name.toLowerCase() === (ALIAS[ws] ?? ws)) ??
        (await prisma.costCentre.create({ data: { entityId: head.entityId, name: want } }))
      if (head.defaultCostCentreId !== cc.id) {
        await prisma.ledgerAccount.update({ where: { id: head.id }, data: { defaultCostCentreId: cc.id } })
        costCentresSet++
      }
    }
  }

  const after = await prisma.budgetLine.findMany({ where: { archivedAt: null } })
  return {
    recurring: after.filter((l) => l.frequency !== 'ONCE').length,
    onceKept: after.filter((l) => l.frequency === 'ONCE').length,
    headsSynced: touchedHeads.size,
    costCentresSet,
    budgetsCleared,
  }
}

import 'server-only'
import { prisma } from '@/lib/db'
import { resolveHeadAccount } from '@/lib/ops/heads'
import { nextChildCode } from '@/lib/ledger/coa'
import { syncBudgetForHead } from '@/lib/budget/plan'

// RETIRED (18 Aug 2026): the Google-Sheet pull is switched off — the app's
// own master register on Accounts is the single source of truth, edited via
// applyMasterRow/removeMasterRow below. syncFromMaster stays only as a
// manual one-off import tool (call it from code deliberately, never from UI):
// it OVERWRITES every app-side edit with the sheet —
//   1. recurring plan lines (cashflow) rebuilt wholesale, ONCE lines kept
//   2. heads created where missing (so tagging knows every category)
//   3. HeadMode refreshed (Actual vs Plan Mode reads the same truth)
//   4. default cost centres set on every same-named head, all books
//   5. Budget rows (Budget vs Actual / Expenses M/M) re-synced per head,
//      and CLEARED for categories the master zeroes out

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
  nature: string | null
  /** Explicit books for the plan/head (HG/ACPL/MG/PG); blank = derive from bank mode. */
  books?: string | null
  /** Claimable-as for income tax; undefined = keep the previous line's value. */
  taxTreatment?: string | null
  /** Register section; a NEW category slots at that section's end. */
  section?: string | null
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
      nature: (r[7] ?? '').trim() || null,
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

// nature → where a master-born head lives in the chart
const NATURE_GROUP: Record<string, { code: string; kind: 'ASSET' | 'LIABILITY' | 'INCOME' | 'EXPENSE' }> = {
  Expense: { code: '5000', kind: 'EXPENSE' },
  Income: { code: '4000', kind: 'INCOME' },
  Asset: { code: '1900', kind: 'ASSET' },
  Liability: { code: '2300', kind: 'LIABILITY' },
  Contra: { code: '5000', kind: 'EXPENSE' },
  Personal: { code: '5000', kind: 'EXPENSE' },
}

function poolOf(bankMode: string | null, oldPool: string | null): string {
  if (!bankMode) return oldPool ?? 'CASH'
  const m = bankMode.toLowerCase()
  if (m === 'cash') return 'CASH'
  if (m.includes('7838') || m.startsWith('acpl')) return 'ACPL'
  if (m.includes('meena')) return 'MG'
  return 'HG' // 2762 / 4271 / HG ICICI / Greeshma balance
}

/**
 * One category, applied everywhere — the app-side editor's counterpart of
 * syncFromMaster: replaces the category's recurring plan lines, mirrors the
 * row in HeadMode (bank link resolved), re-syncs or clears its budgets, and
 * sets the default cost centre on every same-named head. Editing a row in
 * the app IS editing the master.
 */
export async function applyMasterRow(r: MasterRow): Promise<void> {
  if (!r.category.trim()) throw new Error('Category name is required')
  const banks = await prisma.bankAccount.findMany({
    where: { archivedAt: null },
    select: { id: true, nickname: true, accountNumber: true },
  })
  const prev = await prisma.budgetLine.findFirst({
    where: { archivedAt: null, frequency: { not: 'ONCE' }, label: { equals: r.category, mode: 'insensitive' } },
  })
  const active = Boolean(r.frequency && (r.bankBudget !== 0 || r.cashBudget !== 0))
  const touched = new Set<string>()

  await prisma.$transaction(
    async (tx) => {
      await tx.budgetLine.deleteMany({
        where: { archivedAt: null, frequency: { not: 'ONCE' }, label: { equals: r.category, mode: 'insensitive' } },
      })
      if (active) {
        const bankSource =
          r.books === 'CASH' ? 'CASH' : r.books || poolOf(r.bankMode, prev?.source ?? null)
        const parts: { source: string; amount: number }[] = []
        if (r.bankBudget !== 0) parts.push({ source: bankSource, amount: r.bankBudget })
        if (r.cashBudget !== 0) parts.push({ source: 'CASH', amount: r.cashBudget })
        for (const part of parts) {
          const heads = await tx.ledgerAccount.findMany({
            where: { isGroup: false, archivedAt: null, name: { equals: r.category, mode: 'insensitive' } },
            include: { entity: { select: { code: true } } },
          })
          // An explicit books choice pins both the plan's pool and where a
          // missing head is born; otherwise the pool's own books lead.
          const wantCode =
            part.source === 'CASH' ? (r.books && r.books !== 'CASH' ? r.books : 'HG') : part.source
          const head =
            heads.find((h) => h.entity.code === wantCode) ??
            heads.find((h) => h.entity.code === 'HG') ??
            heads[0] ??
            null
          const entity = head
            ? await tx.entity.findUniqueOrThrow({ where: { id: head.entityId } })
            : await tx.entity.findFirstOrThrow({ where: { code: wantCode } })
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
              taxTreatment: r.taxTreatment !== undefined ? r.taxTreatment : (prev?.taxTreatment ?? null),
              dayNote: r.dayNote,
            },
          })
          touched.add(headAccountId)
        }
      }
      // The head itself is born WITH the master row — budget or no budget —
      // so tagging, cash entry and reports see it the moment it is added.
      {
        const anywhere = await tx.ledgerAccount.findFirst({
          where: { isGroup: false, name: { equals: r.category, mode: 'insensitive' } },
        })
        if (!anywhere && r.category.toLowerCase() !== 'cash') {
          const booksCode =
            r.books && r.books !== 'CASH' ? r.books : poolOf(r.bankMode, prev?.source ?? null)
          const entity = await tx.entity.findFirstOrThrow({
            where: { code: booksCode === 'CASH' ? 'HG' : booksCode },
          })
          const spot = NATURE_GROUP[r.nature ?? 'Expense'] ?? NATURE_GROUP.Expense
          const group = await tx.ledgerAccount.findUniqueOrThrow({
            where: { entityId_code: { entityId: entity.id, code: spot.code } },
          })
          await tx.ledgerAccount.create({
            data: {
              entityId: entity.id,
              code: await nextChildCode(tx, entity.id, spot.code),
              name: r.category,
              kind: spot.kind,
              parentId: group.id,
            },
          })
        }
      }
      const bankAccountId = r.bankMode ? resolveBank(banks, r.bankMode) : null
      const mirror = {
        modeBank: r.bankMode,
        expenseType: r.expenseType,
        bankAccountId,
        nature: r.nature,
        books: r.books ?? null,
        frequency: r.frequency,
        dayNote: r.dayNote,
        bankBudget: r.bankBudget !== 0 ? r.bankBudget.toFixed(2) : null,
        cashBudget: r.cashBudget !== 0 ? r.cashBudget.toFixed(2) : null,
      }
      const existingHm = await tx.headMode.findUnique({ where: { category: r.category } })
      if (existingHm) {
        await tx.headMode.update({
          where: { category: r.category },
          data: { ...mirror, ...(r.section !== undefined ? { section: r.section } : {}) },
        })
      } else {
        // a new category slots at the END of its section (rows after shift
        // down one), or at the very end when no section is named
        let sortOrder: number
        if (r.section) {
          const inSection = await tx.headMode.aggregate({
            where: { section: r.section },
            _max: { sortOrder: true },
          })
          if (inSection._max.sortOrder != null) {
            sortOrder = inSection._max.sortOrder + 1
            await tx.headMode.updateMany({
              where: { sortOrder: { gte: sortOrder } },
              data: { sortOrder: { increment: 1 } },
            })
          } else {
            const all = await tx.headMode.aggregate({ _max: { sortOrder: true } })
            sortOrder = (all._max.sortOrder ?? 0) + 1
          }
        } else {
          const all = await tx.headMode.aggregate({ _max: { sortOrder: true } })
          sortOrder = (all._max.sortOrder ?? 0) + 1
        }
        await tx.headMode.create({
          data: { category: r.category, modeCc: null, sortOrder, section: r.section ?? null, ...mirror },
        })
      }
    },
    { timeout: 60_000 },
  )

  for (const headId of touched) {
    await prisma.$transaction((tx) => syncBudgetForHead(tx, headId))
  }
  if (!active) {
    const heads = await prisma.ledgerAccount.findMany({
      where: { isGroup: false, name: { equals: r.category, mode: 'insensitive' } },
      select: { id: true },
    })
    if (heads.length) {
      await prisma.budget.deleteMany({
        where: {
          accountId: { in: heads.map((h) => h.id) },
          OR: [
            { year: 2026, month: { gte: 4 } },
            { year: 2027, month: { lte: 3 } },
          ],
        },
      })
    }
  }
  if (r.expenseType) {
    const strip = (s: string) => s.toLowerCase().trim().replace(/^optional-?\s*/, '')
    const ALIAS: Record<string, string> = { investment: 'invesment' }
    const heads = await prisma.ledgerAccount.findMany({
      where: { isGroup: false, archivedAt: null, name: { equals: r.category, mode: 'insensitive' } },
    })
    for (const head of heads) {
      const existing = await prisma.costCentre.findMany({ where: { entityId: head.entityId, archivedAt: null } })
      const want = r.expenseType
      const ws = strip(want)
      const cc =
        existing.find((c) => c.name.toLowerCase() === want.toLowerCase()) ??
        existing.find((c) => strip(c.name) === ws || c.name.toLowerCase() === ws || c.name.toLowerCase() === (ALIAS[ws] ?? ws)) ??
        (await prisma.costCentre.create({ data: { entityId: head.entityId, name: want } }))
      if (head.defaultCostCentreId !== cc.id) {
        await prisma.ledgerAccount.update({ where: { id: head.id }, data: { defaultCostCentreId: cc.id } })
      }
    }
  } else {
    // a blanked cost-centre column means BLANK — the head defaults clear too
    await prisma.ledgerAccount.updateMany({
      where: { isGroup: false, name: { equals: r.category, mode: 'insensitive' }, defaultCostCentreId: { not: null } },
      data: { defaultCostCentreId: null },
    })
  }

  // The master's word reaches BACK as well (Himal, 18 Aug 2026): everything
  // already classified under this category — tag rows, tag rules, cash
  // entries and posted journal lines — re-derives its cost centre from the
  // head's fresh default. The ledger guard admits costCentreId-only updates
  // (classification, not money), so no trigger games are needed.
  const catHeads = await prisma.ledgerAccount.findMany({
    where: { isGroup: false, name: { equals: r.category, mode: 'insensitive' } },
    select: { id: true, defaultCostCentreId: true },
  })
  for (const head of catHeads) {
    const to = head.defaultCostCentreId
    await prisma.statementTransaction.updateMany({ where: { headAccountId: head.id }, data: { costCentreId: to } })
    await prisma.tagRule.updateMany({ where: { headAccountId: head.id }, data: { costCentreId: to } })
    await prisma.cashEntry.updateMany({ where: { headAccountId: head.id }, data: { costCentreId: to } })
    await prisma.journalLine.updateMany({ where: { accountId: head.id }, data: { costCentreId: to } })
  }
}

/** Take a category off the master: its row, plan lines and FY budgets go; heads and postings stay. */
export async function removeMasterRow(category: string): Promise<void> {
  await prisma.headMode.deleteMany({ where: { category } })
  await prisma.budgetLine.deleteMany({
    where: { archivedAt: null, frequency: { not: 'ONCE' }, label: { equals: category, mode: 'insensitive' } },
  })
  const heads = await prisma.ledgerAccount.findMany({
    where: { isGroup: false, name: { equals: category, mode: 'insensitive' } },
    select: { id: true },
  })
  if (heads.length) {
    await prisma.budget.deleteMany({
      where: {
        accountId: { in: heads.map((h) => h.id) },
        OR: [
          { year: 2026, month: { gte: 4 } },
          { year: 2027, month: { lte: 3 } },
        ],
      },
    })
  }
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
      }
      // EVERY sheet row lands in HeadMode — the app's mirror of the whole
      // master, zero-budget and note-only rows included.
      for (const r of rows) {
        const bankAccountId = r.bankMode ? resolveBank(banks, r.bankMode) : null
        const mirror = {
          modeBank: r.bankMode,
          expenseType: r.expenseType,
          bankAccountId,
          nature: r.nature,
          frequency: r.frequency,
          dayNote: r.dayNote,
          bankBudget: r.bankBudget !== 0 ? r.bankBudget.toFixed(2) : null,
          cashBudget: r.cashBudget !== 0 ? r.cashBudget.toFixed(2) : null,
        }
        await tx.headMode.upsert({
          where: { category: r.category },
          create: { category: r.category, modeCc: null, ...mirror },
          update: mirror,
        })
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

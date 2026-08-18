import 'dotenv/config'
import { readFileSync } from 'fs'
import { join } from 'path'
import { prisma } from '../src/lib/db'
import { resolveHeadAccount } from '../src/lib/ops/heads'
import { syncBudgetForHead } from '../src/lib/budget/plan'

// "New Finance setup HG" is the MASTER: the recurring plan is rebuilt from
// it, wholesale. Every non-ONCE budget line is replaced by the sheet's
// rows (60 with a budget + frequency); ONCE lines (one-off future plans)
// are kept. Pool comes from the row's Bank mode (2762/4271/ICICI → HG,
// 7838 → ACPL, Meena → MG, Cash → CASH); a blank mode keeps the old
// line's pool, else CASH. Claimable-as survives from the old lines (the
// new tab dropped that column). HeadMode.modeBank/expenseType refresh
// too, so Actual-vs-Plan-Mode reads the same master. Heads are created
// where missing, and Budget-vs-Actual rows re-sync per touched head.
// Re-run me whenever the master sheet changes.

type Row = {
  category: string
  bankMode: string | null
  expenseType: string | null
  bankBudget: number
  cashBudget: number
  frequency: string | null
  dayNote: string | null
  nature: string | null
}

function poolOf(bankMode: string | null, oldPool: string | null): string {
  if (!bankMode) return oldPool ?? 'CASH'
  const m = bankMode.toLowerCase()
  if (m === 'cash') return 'CASH'
  if (m.includes('7838') || m.startsWith('acpl')) return 'ACPL'
  if (m.includes('meena')) return 'MG'
  return 'HG' // 2762 / 4271 / HG ICICI / Greeshma balance
}

async function main() {
  const rows: Row[] = JSON.parse(readFileSync(join(__dirname, 'data', 'new-finance-setup-hg.json'), 'utf8'))
  const active = rows.filter((r) => r.frequency && (r.bankBudget !== 0 || r.cashBudget !== 0))

  const old = await prisma.budgetLine.findMany({ where: { archivedAt: null, frequency: { not: 'ONCE' } } })
  const oldByLabel = new Map(old.map((l) => [l.label.toLowerCase(), l]))
  const before = old.length

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

        // the same master feeds the Actual-vs-Plan-Mode report
        if (r.bankMode || r.expenseType) {
          await tx.headMode.upsert({
            where: { category: r.category },
            create: { category: r.category, modeBank: r.bankMode, modeCc: null, expenseType: r.expenseType },
            update: { modeBank: r.bankMode ?? undefined, expenseType: r.expenseType ?? undefined },
          })
        }
      }
    },
    { timeout: 120_000 },
  )

  for (const headId of touchedHeads) {
    await prisma.$transaction((tx) => syncBudgetForHead(tx, headId))
  }

  const after = await prisma.budgetLine.findMany({ where: { archivedAt: null } })
  const recurring = after.filter((l) => l.frequency !== 'ONCE')
  const once = after.filter((l) => l.frequency === 'ONCE')
  console.log(`recurring: ${before} old → ${recurring.length} from master; ONCE kept: ${once.length}`)
  console.log(`budget model re-synced for ${touchedHeads.size} heads`)

  // The sheet's "Default cost centre" column: set it on every same-named
  // head, in whichever books the head lives. Reuses an existing cost
  // centre when the name matches (Optional-Lifestyle ↔ Lifestyle, and the
  // books' "Invesment" spelling); creates it in those books otherwise.
  const strip = (s: string) => s.toLowerCase().trim().replace(/^optional-?\s*/, '')
  const ALIAS: Record<string, string> = { investment: 'invesment' }
  let ccSet = 0
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
        ccSet++
      }
    }
  }
  console.log(`default cost centres set on ${ccSet} heads (from the sheet's column)`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

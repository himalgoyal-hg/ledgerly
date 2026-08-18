import 'dotenv/config'
import { prisma } from '../src/lib/db'

// Every EXPENSE head gets its cost-centre link (Himal, 19 Aug): the master's
// type where it spoke; for the 63 it left blank — Compulsory as the working
// default, with a small lifestyle/growth/investment list, and transfer /
// contra heads (2762 <<-->> …) skipped since transfers carry no cost centre.
// The master register (HeadMode) learns the same type so both stay in step.

const SPECIAL: Record<string, string> = {
  'new car': 'Optional-Lifestyle',
  sports: 'Optional-Lifestyle',
  gifting: 'Optional-Lifestyle',
  learning: 'Optional-growth',
  'investment in land': 'Optional-Investment',
  forex: 'Optional-Investment',
}
const isTransfer = (n: string) => /<<|-->|<->/.test(n)

const strip = (s: string) => s.toLowerCase().trim().replace(/^optional-?\s*/, '')
const ALIAS: Record<string, string> = { investment: 'invesment' }

async function main() {
  const heads = await prisma.ledgerAccount.findMany({
    where: { isGroup: false, archivedAt: null, defaultCostCentreId: null, kind: 'EXPENSE' },
  })
  let linked = 0
  let skipped = 0
  let masterTyped = 0
  for (const head of heads) {
    if (isTransfer(head.name)) { skipped++; continue }
    const want = SPECIAL[head.name.toLowerCase().trim()] ?? 'Compulsory'
    const existing = await prisma.costCentre.findMany({ where: { entityId: head.entityId, archivedAt: null } })
    const ws = strip(want)
    const cc =
      existing.find((c) => c.name.toLowerCase() === want.toLowerCase()) ??
      existing.find((c) => strip(c.name) === ws || c.name.toLowerCase() === (ALIAS[ws] ?? ws)) ??
      (await prisma.costCentre.create({ data: { entityId: head.entityId, name: want } }))
    await prisma.ledgerAccount.update({ where: { id: head.id }, data: { defaultCostCentreId: cc.id } })
    linked++
    const hm = await prisma.headMode.findFirst({
      where: { category: { equals: head.name, mode: 'insensitive' }, expenseType: null },
    })
    if (hm) {
      await prisma.headMode.update({ where: { id: hm.id }, data: { expenseType: want } })
      masterTyped++
    }
  }
  const left = await prisma.ledgerAccount.count({
    where: { isGroup: false, archivedAt: null, defaultCostCentreId: null, kind: 'EXPENSE' },
  })
  console.log(`${linked} expense heads linked, ${skipped} transfer heads skipped, ${masterTyped} master rows typed; ${left} expense heads remain (transfers)`)
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

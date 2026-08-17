import 'dotenv/config'
import { prisma } from '../src/lib/db'

// One-time: month rows for the finance-task grid — the sheet's Dec-25..Nov-26
// plus any month that already has cells. Idempotent (unique on month).

async function main() {
  const wanted = new Set<string>()
  for (let y = 2025, m = 12, i = 0; i < 12; i++) {
    wanted.add(`${y}-${String(m).padStart(2, '0')}`)
    m++; if (m > 12) { m = 1; y++ }
  }
  const cells = await prisma.financeTaskCell.findMany({ select: { month: true } })
  for (const c of cells) wanted.add(c.month.toISOString().slice(0, 7))
  let added = 0
  for (const key of wanted) {
    const r = await prisma.financeMonth.upsert({
      where: { month: new Date(`${key}-01`) },
      create: { month: new Date(`${key}-01`) },
      update: {},
    })
    if (r) added++
  }
  console.log(`${wanted.size} month rows ensured`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

import 'dotenv/config'
import { readFileSync } from 'fs'
import { join } from 'path'
import { prisma } from '../src/lib/db'

// Fill every Day the sheets ever specified: merged old Finance-setup +
// New Finance setup HG day columns → HeadMode.dayNote + live plan lines,
// only where the register is currently blank (never overwrites an app
// edit). Salon's corrupt "12/13/3799" becomes "12" (its first date).

async function main() {
  const merged: Record<string, string> = JSON.parse(
    readFileSync(join(__dirname, 'data', 'sheet-day-notes.json'), 'utf8'),
  )
  merged['salon'] = '12'
  let modes = 0
  let lines = 0
  for (const [cat, day] of Object.entries(merged)) {
    const hm = await prisma.headMode.findFirst({
      where: { category: { equals: cat, mode: 'insensitive' } },
    })
    if (hm && !hm.dayNote) {
      await prisma.headMode.update({ where: { id: hm.id }, data: { dayNote: day } })
      modes++
    }
    const upd = await prisma.budgetLine.updateMany({
      where: {
        archivedAt: null,
        frequency: { not: 'ONCE' },
        label: { equals: cat, mode: 'insensitive' },
        OR: [{ dayNote: null }, { dayNote: '' }],
      },
      data: { dayNote: day },
    })
    lines += upd.count
  }
  const blank = await prisma.headMode.count({ where: { dayNote: null } })
  console.log(`filled ${modes} register days + ${lines} plan-line days; ${blank} rows remain day-less (sheet had none)`)
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

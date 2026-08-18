import 'dotenv/config'
import { prisma } from '../src/lib/db'

// Fill HeadMode.books with the truth for every row: the active plan line's
// pool wins (that's where the money actually plans from — CASH included);
// otherwise the bank mode decides; blank mode with no line = Cash.
async function main() {
  const modes = await prisma.headMode.findMany()
  const lines = await prisma.budgetLine.findMany({ where: { archivedAt: null, frequency: { not: 'ONCE' } } })
  const bySrc = new Map<string, string>()
  for (const l of lines) {
    // bank-part line wins over the cash part when both exist
    const key = l.label.toLowerCase()
    if (!bySrc.has(key) || bySrc.get(key) === 'CASH') bySrc.set(key, l.source)
  }
  const derive = (mode: string | null): string => {
    if (!mode) return 'CASH'
    const m = mode.toLowerCase()
    if (m === 'cash') return 'CASH'
    if (m.includes('7838') || m.startsWith('acpl')) return 'ACPL'
    if (m.includes('meena')) return 'MG'
    return 'HG'
  }
  let n = 0
  for (const m of modes) {
    const books = bySrc.get(m.category.toLowerCase()) ?? derive(m.modeBank)
    if (m.books !== books) {
      await prisma.headMode.update({ where: { id: m.id }, data: { books } })
      n++
    }
  }
  console.log(`${n} rows backfilled with their true books/pool`)
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

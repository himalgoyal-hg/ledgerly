import 'dotenv/config'
import { prisma } from '../src/lib/db'

// Plan lines still pointing at the retired AC pool move to HG (AC merged
// into HG on 13 Aug), so they re-enter the projections. The Cashflow tab's
// rows (Synergy EMI etc.) were format EXAMPLES only — never import them;
// the real plan lines were imported earlier from the budget sheet.

async function main() {
  const ac = await prisma.budgetLine.updateMany({
    where: { source: 'AC', archivedAt: null },
    data: { source: 'HG' },
  })
  console.log(`AC→HG remapped: ${ac.count}`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

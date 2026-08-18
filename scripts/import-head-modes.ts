import 'dotenv/config'
import { readFileSync } from 'fs'
import { join } from 'path'
import { prisma } from '../src/lib/db'

// Finance-setup sheet → HeadMode: per category the planned bank account,
// credit card, and expense type. Idempotent (upsert by category).

async function main() {
  const rows: { category: string; modeBank: string | null; modeCc: string | null; expenseType: string | null }[] =
    JSON.parse(readFileSync(join(__dirname, 'data', 'finance-setup-modes.json'), 'utf8'))
  for (const r of rows) {
    await prisma.headMode.upsert({
      where: { category: r.category },
      create: r,
      update: { modeBank: r.modeBank, modeCc: r.modeCc, expenseType: r.expenseType },
    })
  }
  console.log(`${rows.length} category modes imported`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

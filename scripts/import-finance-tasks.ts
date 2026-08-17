import 'dotenv/config'
import { prisma } from '../src/lib/db'

// Import of the workbook's "Finance task" tab: 11 columns (Mom cash/bank,
// Comments, Sanjay Goyal, EMIs, credit cards) × months Dec-25..Nov-26.
// Cells come in verbatim — amounts, "Yes", notes — the sheet is the shape.
// Idempotent: matched by task name; existing cells are overwritten.

type TaskDef = { name: string; account: string | null; dueDay: number | null; sortOrder: number }

const TASKS: TaskDef[] = [
  { name: 'Mom 30000 cash', account: null, dueDay: 7, sortOrder: 1 },
  { name: 'Mom 40000', account: 'MG Axis bank', dueDay: 7, sortOrder: 2 },
  { name: 'Comments', account: null, dueDay: null, sortOrder: 3 },
  { name: 'Sanjay Goyal 20000', account: '4271 account', dueDay: 7, sortOrder: 4 },
  { name: 'EMI Synergy', account: '2762 account', dueDay: 28, sortOrder: 5 },
  { name: 'Hedged.in payment Rs.12558', account: '7838 account', dueDay: 15, sortOrder: 6 },
  { name: 'AMEX CC bill payment', account: '7838 account', dueDay: 14, sortOrder: 7 },
  { name: 'Tata Neo Credit card 9925', account: null, dueDay: 21, sortOrder: 8 },
  { name: 'ICICI Credit card 1001', account: 'HG ICICI bank', dueDay: 30, sortOrder: 9 },
  { name: 'Kapable Emi Rs.18,678.51', account: '7838 account', dueDay: 3, sortOrder: 10 },
  { name: 'Jeep Compass Emi Rs. 60973', account: '7838 account', dueDay: 5, sortOrder: 11 },
]

// month rows: [month, ...11 cell values in TASKS order] — verbatim from the sheet
const ROWS: [string, ...(string | null)[]][] = [
  ['2025-12', '₹30,000', '₹40,000', 'Paid cash & bank on 19th Dec', null, 'Yes', null, null, null, null, null, null],
  ['2026-01', '₹30,000', '₹40,000', 'Paid cash & bank on 19th Dec', null, 'Yes', null, null, null, null, null, null],
  ['2026-02', '₹30,000', '₹40,000', 'Paid cash & bank on 19th Dec', null, 'Yes', null, null, null, null, null, null],
  ['2026-03', '₹45,000', '₹25,000', 'Paid bank on 26th Feb (10k) and 27th Feb (65k)', null, 'Yes', '12558- April', '5899.49', '8662', null, null, null],
  ['2026-04', '₹45,000', '₹25,000', 'Paid bank on 26th Feb (10k) and 27th Feb (65k)', '₹20,000', 'Yes', '12558- April', '0', '8210', '252.44', '35000', null],
  ['2026-05', '₹45,000', '₹25,000', 'Paid bank on 26th Feb (10k) and 27th Feb (65k)', '₹20,000', 'Yes', '12558- May', '0', '11508', null, null, '60973+590 bounce charges'],
  ['2026-06', '₹40,000', '₹30,000', null, '₹20,000', null, null, '0', null, null, '18678.51', '60973'],
  ['2026-07', '₹40,000', '₹30,000', null, '₹20,000', null, null, '0', null, null, '18678.51', '60973'],
  [
    '2026-08', '₹60,000', '₹30,000',
    'Paid 30k in bank (on 25 June)\n20k cash paid already before\nTotal:\n70k for Sep + 20k balance of August +\n20k extra for Sunny/ Amisha kid= 1.1 lac\n60k paid in cash/ 50k paid in bank 27 July',
    null, null, null, null, null, null, null, null,
  ],
  ['2026-09', '₹20,000', '₹50,000', null, null, null, null, null, null, null, null, null],
  ['2026-10', null, null, null, null, null, null, null, null, null, null, null],
  ['2026-11', null, null, null, null, null, null, null, null, null, null, null],
]

async function main() {
  let cells = 0
  for (const def of TASKS) {
    const existing = await prisma.financeTask.findFirst({ where: { name: def.name } })
    const task = existing
      ? await prisma.financeTask.update({ where: { id: existing.id }, data: def })
      : await prisma.financeTask.create({ data: def })
    for (const row of ROWS) {
      const value = row[TASKS.indexOf(def) + 1]
      if (!value) continue
      const month = new Date(`${row[0]}-01`)
      await prisma.financeTaskCell.upsert({
        where: { taskId_month: { taskId: task.id, month } },
        create: { taskId: task.id, month, value },
        update: { value },
      })
      cells++
    }
  }
  console.log(`${TASKS.length} tasks, ${cells} cells imported`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

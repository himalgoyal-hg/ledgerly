import 'dotenv/config'
import { prisma } from '../src/lib/db'

// Import of the workbook's "Net capital" tab (Books of Himal), verbatim.
// Sections and columns as on the sheet; the unlabeled FY-books column goes
// to fyFigure. The bottom HG/MG Dr-Cr reconciliation notes are NOT imported
// (working notes, not part of the statement). Idempotent by section+name.

type L = {
  section: 'INCOME' | 'LIABILITY' | 'APPLICATION' | 'TAXPAID' | 'BANK'
  name: string
  taxStatus?: string
  amountNew?: string
  amountTotal?: string
  synergy?: string
  fyFigure?: string
  remaining?: string
}

const LINES: L[] = [
  // Sources — income & capital
  { section: 'INCOME', name: 'Mom Old Capital balance (Till FY 21-22)', taxStatus: 'Tax paid', amountTotal: '5000000', synergy: '5000000', remaining: '0' },
  { section: 'INCOME', name: 'Profit from sale of ABC', taxStatus: 'Tax paid', amountTotal: '4834000', remaining: '4834000' },
  { section: 'INCOME', name: 'Profit from sale of Vested shares', taxStatus: 'Tax paid', amountNew: '1000000', amountTotal: '1000000' },
  { section: 'INCOME', name: 'Capital FY 2022-23 (HG)', amountTotal: '1000000', fyFigure: '5902776' },
  { section: 'INCOME', name: 'Capital FY 2022-23 (MG)', amountTotal: '600000', fyFigure: '2500000' },
  { section: 'INCOME', name: 'Capital FY 2023-24 (HG)', amountTotal: '1000000', fyFigure: '6620723' },
  { section: 'INCOME', name: 'Capital FY 2023-24 (MG)', amountTotal: '600000', fyFigure: '5341756' },
  { section: 'INCOME', name: 'Capital FY 2024-25 (HG)', amountTotal: '8293993', fyFigure: '8293993' },
  { section: 'INCOME', name: 'Capital FY 2024-25 (MG)', amountTotal: '5638281', fyFigure: '5638281' },
  { section: 'INCOME', name: 'Capital FY 2025-26 (HG)', taxStatus: 'Tax paid', amountNew: '11198958', amountTotal: '2100000', fyFigure: '11198958' },
  { section: 'INCOME', name: 'Capital FY 2025-26 (MG)', taxStatus: 'Tax paid', amountNew: '8136825', amountTotal: '1000000', fyFigure: '8136825' },
  // Liabilities — loans taken
  { section: 'LIABILITY', name: 'Loan from Darshan HUF', taxStatus: 'Not paid', amountNew: '980000' },
  { section: 'LIABILITY', name: 'Loan from Devendra HUF', taxStatus: 'Not paid', amountNew: '730000' },
  { section: 'LIABILITY', name: 'Loan from Paridhi (FY 23-24)', taxStatus: 'Not paid', amountNew: '3900000', amountTotal: '3900000', remaining: '3900000' },
  { section: 'LIABILITY', name: 'Loan from Paridhi (FY 24-25)', taxStatus: 'Not paid', amountNew: '1275000', amountTotal: '1275000' },
  { section: 'LIABILITY', name: 'HG Synergy loan', amountNew: '39500000', amountTotal: '39500000', synergy: '39500000', remaining: '0' },
  // Application — where the money sits
  { section: 'APPLICATION', name: 'Synergy', amountNew: '44700000', amountTotal: '44700000', synergy: '44700000' },
  { section: 'APPLICATION', name: 'Investments in GG & TST', amountNew: '861260', amountTotal: '861260' },
  { section: 'APPLICATION', name: "Hedged' investments", amountNew: '6000000', amountTotal: '6000000' },
  { section: 'APPLICATION', name: 'Mutual funds (HG)', amountNew: '1500000', amountTotal: '1500000' },
  { section: 'APPLICATION', name: 'Mutual funds (MG)', amountNew: '480000', amountTotal: '480000' },
  { section: 'APPLICATION', name: 'Other fixed assets (Baleno/ Bike/ Assets)', amountNew: '1200000', amountTotal: '1200000' },
  { section: 'APPLICATION', name: 'Other MG assets (To check)', amountNew: '800000' },
  // Tax-paid assets / investments currently showing
  { section: 'TAXPAID', name: 'Investments in GG & TST', amountNew: '861260' },
  { section: 'TAXPAID', name: "Hedged' investments", amountNew: '6000000' },
  { section: 'TAXPAID', name: 'Mutual funds (HG)', amountNew: '1500000' },
  { section: 'TAXPAID', name: 'Mutual funds (MG)', amountNew: '480000' },
  { section: 'TAXPAID', name: 'Other fixed assets (Baleno/ Bike/ Assets)', amountNew: '1200000' },
  { section: 'TAXPAID', name: 'Other MG assets (To check)', amountNew: '800000' },
  { section: 'TAXPAID', name: 'Synergy furniture', amountNew: '5000000' },
  { section: 'TAXPAID', name: 'Synergy paid', amountNew: '5700000' },
  // Bank balance
  { section: 'BANK', name: 'MG', amountNew: '4730000' },
  { section: 'BANK', name: 'HG', amountNew: '3570000' },
]

async function main() {
  let n = 0
  for (const [i, l] of LINES.entries()) {
    const data = {
      section: l.section,
      name: l.name,
      taxStatus: l.taxStatus ?? null,
      amountNew: l.amountNew ?? null,
      amountTotal: l.amountTotal ?? null,
      synergy: l.synergy ?? null,
      fyFigure: l.fyFigure ?? null,
      remaining: l.remaining ?? null,
      sortOrder: i + 1,
    }
    const existing = await prisma.netCapitalLine.findFirst({ where: { section: l.section, name: l.name } })
    if (existing) await prisma.netCapitalLine.update({ where: { id: existing.id }, data })
    else await prisma.netCapitalLine.create({ data })
    n++
  }
  console.log(`${n} net-capital lines imported`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

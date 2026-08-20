import { prisma } from '@/lib/db'
import { requireUser, isAdmin, hasPermission } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { accountLedger } from '@/lib/ledger/queries'
import { profitAndLoss, balanceSheet, cashFlow } from '@/lib/reports/statements'
import {
  costCentreReport,
  partyLedgers,
  budgetVsActual,
  salaryReport,
} from '@/lib/reports/analysis'

// CSV export (spec §10 "exportable (Excel/PDF)"). CSV opens natively in
// Excel; PDF is the browser's print-to-PDF from the same screens.

function csvEscape(value: string | number): string {
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(rows: (string | number)[][]): string {
  // BOM so Excel reads UTF-8 (₹, en-dashes) correctly.
  return '﻿' + rows.map((r) => r.map(csvEscape).join(',')).join('\r\n')
}

export async function GET(request: Request) {
  const user = await requireUser()
  if (!isAdmin(user) && !hasPermission(user, 'viewFinancialReports')) {
    return new Response('Forbidden', { status: 403 })
  }
  const entity = await getCurrentEntity(user)
  if (!entity) return new Response('No entity selected', { status: 400 })

  const url = new URL(request.url)
  const report = url.searchParams.get('report') ?? 'pnl'
  const fromParam = url.searchParams.get('from')
  const toParam = url.searchParams.get('to')
  const range = {
    from: fromParam ? new Date(fromParam) : undefined,
    to: toParam ? new Date(toParam) : undefined,
  }
  const header = [`Ledgerly — ${entity.name} (${entity.code})`]
  const period = [`Period: ${fromParam ?? 'start'} to ${toParam ?? 'today'}`]

  let rows: (string | number)[][]
  let filename: string

  switch (report) {
    case 'pnl': {
      const pnl = await profitAndLoss(entity.id, range)
      rows = [
        header, period, [],
        ['Profit & Loss'], [],
        ['Section', 'Group', 'Code', 'Account', 'Amount'],
        ...pnl.income.lines.map((l) => ['Income', l.group, l.code, l.name, l.amount]),
        ['', '', '', 'Total income', pnl.income.total],
        [],
        ...pnl.expenses.lines.map((l) => ['Expenses', l.group, l.code, l.name, l.amount]),
        ['', '', '', 'Total expenses', pnl.expenses.total],
        [],
        ['', '', '', 'Net profit', pnl.netProfit],
      ]
      filename = 'profit-and-loss'
      break
    }
    case 'balance-sheet': {
      const bs = await balanceSheet(entity.id, range.to)
      rows = [
        header, [`As at: ${toParam ?? 'today'}`], [],
        ['Balance Sheet'], [],
        ['Section', 'Group', 'Code', 'Account', 'Amount'],
        ...bs.assets.lines.map((l) => ['Assets', l.group, l.code, l.name, l.amount]),
        ['', '', '', 'Total assets', bs.assets.total],
        [],
        ...bs.liabilities.lines.map((l) => ['Liabilities', l.group, l.code, l.name, l.amount]),
        ['', '', '', 'Total liabilities', bs.liabilities.total],
        [],
        ...bs.equity.lines.map((l) => ['Equity', l.group, l.code, l.name, l.amount]),
        ['Equity', '', '', 'Profit to date', bs.retainedEarnings],
        ['', '', '', 'Total liabilities + equity', bs.liabilitiesEquityTotal],
        [],
        ['', '', '', 'Balances', bs.balances ? 'yes' : 'NO'],
      ]
      filename = 'balance-sheet'
      break
    }
    case 'cash-flow': {
      const cf = await cashFlow(entity.id, range)
      rows = [
        header, period, [],
        ['Cash Flow'], [],
        ['Opening cash & bank', cf.opening],
        [],
        ['Bucket', 'Code', 'Account', 'Cash in / (out)'],
        ...cf.operating.lines.map((l) => ['Operating', l.code, l.name, l.amount]),
        ['', '', 'Net operating', cf.operating.total],
        ...cf.investing.lines.map((l) => ['Investing', l.code, l.name, l.amount]),
        ['', '', 'Net investing', cf.investing.total],
        ...cf.financing.lines.map((l) => ['Financing', l.code, l.name, l.amount]),
        ['', '', 'Net financing', cf.financing.total],
        [],
        ['Net movement', cf.netMovement],
        ['Closing cash & bank', cf.closing],
      ]
      filename = 'cash-flow'
      break
    }
    case 'cost-centres': {
      const cc = await costCentreReport(entity.id, range)
      rows = [
        header, period, [],
        ['Expense by cost centre'], [],
        ['Cost centre', 'Expense', 'Income', 'Net spend'],
        ...cc.rows.map((r) => [r.name, r.expense, r.income, r.net]),
        ['Total', '', '', cc.total],
      ]
      filename = 'cost-centres'
      break
    }
    case 'parties': {
      const parties = await partyLedgers(entity.id, range.to)
      rows = [
        header, [`As at: ${toParam ?? 'today'}`], [],
        ['Party ledgers'], [],
        ['Type', 'Party', 'Balance'],
        ...parties.customers.map((p) => ['Customer (receivable)', p.name, p.balance]),
        ...parties.vendors.map((p) => ['Vendor (payable)', p.name, p.balance]),
        ...parties.payables.map((p) => ['Member/employee (payable)', p.name, p.balance]),
      ]
      filename = 'party-ledgers'
      break
    }
    case 'budget': {
      // same FY window the screen uses: Apr fy … Mar fy+1
      const nowB = new Date()
      const year =
        Number(url.searchParams.get('year')) ||
        (nowB.getUTCMonth() + 1 >= 4 ? nowB.getUTCFullYear() : nowB.getUTCFullYear() - 1)
      const monthParam = Number(url.searchParams.get('month')) || 0
      const periods = monthParam
        ? [monthParam >= 4 ? { year, month: monthParam } : { year: year + 1, month: monthParam }]
        : Array.from({ length: 12 }, (_, i) =>
            i < 9 ? { year, month: i + 4 } : { year: year + 1, month: i - 8 },
          )
      const budget = await budgetVsActual(entity.id, periods)
      rows = [
        header,
        [`Period: ${monthParam ? `${monthParam >= 4 ? year : year + 1}-${String(monthParam).padStart(2, '0')}` : `FY ${year}-${String(year + 1).slice(2)}`}`],
        [],
        ['Budget vs Actual'], [],
        ['Code', 'Account', 'Budget', 'Actual', 'Variance', 'Used %'],
        ...budget.rows.map((r) => [
          r.code, r.name, r.budget, r.actual, r.variance, r.usedPct ?? '',
        ]),
        ['', 'Totals', budget.budgetTotal, budget.actualTotal, budget.varianceTotal, ''],
      ]
      filename = 'budget-vs-actual'
      break
    }
    case 'salary': {
      const year = Number(url.searchParams.get('year')) || new Date().getUTCFullYear()
      const salary = await salaryReport(entity.id, year)
      rows = [
        header, [`Year: ${year}`], [],
        ['Salary report'], [],
        ['Month', 'Status', 'Person', 'Type', 'Section', 'Cost centre', 'Gross', 'TDS', 'Net'],
        ...salary.months.flatMap((m) =>
          m.lines.map((l) => [
            `${year}-${String(m.month).padStart(2, '0')}`,
            m.status, l.name, l.type, l.section, l.costCentre, l.gross, l.tds, l.net,
          ]),
        ),
        ['Totals', '', '', '', '', '', salary.gross, salary.tds, salary.net],
      ]
      filename = `salary-${year}`
      break
    }
    case 'ledger': {
      const accountId = url.searchParams.get('accountId')
      if (!accountId) return new Response('accountId is required', { status: 400 })
      const account = await prisma.ledgerAccount.findUnique({ where: { id: accountId } })
      if (!account || account.entityId !== entity.id) {
        return new Response('Unknown account for these books', { status: 404 })
      }
      const ledger = await accountLedger(accountId, range)
      rows = [
        header, period, [],
        [`Ledger — ${account.code} ${account.name}`], [],
        ['Date', 'Narration', 'Reference', 'Kind', 'Debit', 'Credit', 'Balance'],
        ['', 'Opening balance', '', '', '', '', ledger.opening],
        ...ledger.lines.map((l) => [
          l.date.toISOString().slice(0, 10),
          l.narration,
          l.reference ?? '',
          l.kind,
          Number(l.debit) > 0 ? l.debit : '',
          Number(l.credit) > 0 ? l.credit : '',
          l.running,
        ]),
        ['', 'Closing balance', '', '', '', '', ledger.closing],
      ]
      filename = `ledger-${account.code}`
      break
    }
    default:
      return new Response('Unknown report', { status: 400 })
  }

  const stamp = new Date().toISOString().slice(0, 10)
  return new Response(toCsv(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${entity.code}-${filename}-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}

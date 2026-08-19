import Link from 'next/link'
import { Fragment, type ReactNode } from 'react'
import { prisma } from '@/lib/db'
import { requirePermission, hasPermission } from '@/lib/auth'
import { getCurrentEntity } from '@/lib/entity-context'
import { displayINR } from '@/lib/ledger/money'
import { NATURES, suggestNature } from '@/lib/statements/natures'
import { GST_RATES, GST_TYPES, TDS_SECTIONS } from '@/lib/tax/calc'
import { describeNarration } from '@/lib/statements/rules'
import { aiConfigured } from '@/lib/ai/client'
import { TagRowCells } from './tag-form'
import { SelectAll } from './select-all'
import { TxnDetails } from './txn-details'
import { HeadCombobox } from '@/components/head-combobox'
import { SmartCombobox } from '@/components/smart-combobox'
import { PageHeader, buttonClass, controlClass, tableWrapClass, theadClass } from '@/components/ui'
import {
  tagTransaction,
  untagTransaction,
  postAll,
  retagPosted,
  undoPosted,
  requestAiSuggestions,
  acceptAiSuggestion,
  dismissAiSuggestion,
  bulkTag,
  acceptAllSuggestions,
} from './actions'

// The tagging queue (spec §3 steps 4–6): pending rows get their 3-tier tag,
// tagged rows wait for "Post All Confirmed", posted rows carry a balanced
// journal underneath (with member edit/delete/undo when granted).
// Search, bank/month/status filters, KPIs, bulk tagging and pagination come
// from the v2 prototype's Tagging screen. Every section is a dense
// spreadsheet-style table — one transaction per line, tag inputs inline —
// so a screenful shows dozens of rows, not 4-5 cards.

const PER_PAGE = 60

export default async function TaggingPage(props: {
  searchParams: Promise<{ q?: string; bank?: string; month?: string; view?: string; page?: string }>
}) {
  const user = await requirePermission('transactionTagging')
  const canEditPosted = hasPermission(user, 'transactionEditDelete')
  const entity = await getCurrentEntity(user)
  if (!entity) {
    return <p className="text-sm text-ink-2">No books to work on yet.</p>
  }

  const sp = await props.searchParams
  const q = (sp.q ?? '').trim()
  const bank = sp.bank ?? ''
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? '') ? sp.month! : ''
  const view = ['pending', 'tagged', 'posted'].includes(sp.view ?? '') ? sp.view! : 'all'
  const pageNo = Math.max(1, Number(sp.page) || 1)

  const monthFrom = month ? new Date(`${month}-01T00:00:00Z`) : null
  const monthTo = monthFrom
    ? new Date(Date.UTC(monthFrom.getUTCFullYear(), monthFrom.getUTCMonth() + 1, 1))
    : null

  // Search reaches the whole tag, not just the narration: matching heads and
  // cost centres resolve to ids first (no relation on the txn row), natures
  // match by label or value.
  const [qHeads, qCcs] = q
    ? await Promise.all([
        prisma.ledgerAccount.findMany({
          where: {
            entityId: entity.id,
            isGroup: false,
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { code: { startsWith: q } },
            ],
          },
          select: { id: true },
        }),
        prisma.costCentre.findMany({
          where: { entityId: entity.id, name: { contains: q, mode: 'insensitive' } },
          select: { id: true },
        }),
      ])
    : [[], []]
  const qNatures = q
    ? NATURES.filter(
        (n) =>
          n.label.toLowerCase().includes(q.toLowerCase()) ||
          n.value.toLowerCase().includes(q.toLowerCase()),
      ).map((n) => n.value)
    : []

  // One filter, three status lists — mirrors the prototype's single filtered
  // table split into our Pending / Tagged / Posted sections.
  const filter = {
    entityId: entity.id,
    ...(bank ? { bankAccountId: bank } : {}),
    ...(q
      ? {
          OR: [
            { narration: { contains: q, mode: 'insensitive' as const } },
            { reference: { contains: q, mode: 'insensitive' as const } },
            ...(qHeads.length ? [{ headAccountId: { in: qHeads.map((h) => h.id) } }] : []),
            ...(qCcs.length ? [{ costCentreId: { in: qCcs.map((c) => c.id) } }] : []),
            ...(qNatures.length ? [{ nature: { in: qNatures } }] : []),
          ],
        }
      : {}),
    ...(monthFrom && monthTo ? { date: { gte: monthFrom, lt: monthTo } } : {}),
  }

  const [pending, tagged, posted, heads, costCentres, banks, users, totalEntries, sums, monthRows] =
    await Promise.all([
      prisma.statementTransaction.findMany({
        where: { ...filter, status: 'PENDING' },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
      }),
      prisma.statementTransaction.findMany({
        where: { ...filter, status: 'TAGGED' },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
      }),
      prisma.statementTransaction.findMany({
        where: { ...filter, status: 'POSTED' },
        orderBy: [{ taggedAt: 'desc' }, { date: 'desc' }],
        take: 50,
      }),
      prisma.ledgerAccount.findMany({
        where: { entityId: entity.id, isGroup: false, archivedAt: null },
        orderBy: { code: 'asc' },
        select: { id: true, code: true, name: true, kind: true, defaultCostCentreId: true },
      }),
      // Archived cost centres ride along too: older tags point at them, and
      // a stored value must never DISPLAY as blank. Active ones list first;
      // archived wear their label so nobody picks them by accident.
      prisma.costCentre
        .findMany({
          where: { entityId: entity.id },
          orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }],
          select: { id: true, name: true, archivedAt: true },
        })
        .then((ccs) =>
          ccs
            .sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null) || a.name.localeCompare(b.name))
            .map((c) => ({ id: c.id, name: c.archivedAt ? `${c.name} (archived)` : c.name })),
        ),
      prisma.bankAccount.findMany({ select: { id: true, nickname: true, entityId: true } }),
      prisma.user.findMany({ select: { id: true, name: true } }),
      prisma.statementTransaction.count({
        where: { entityId: entity.id, status: { not: 'DUPLICATE' } },
      }),
      prisma.statementTransaction.aggregate({
        where: { ...filter, status: { not: 'DUPLICATE' } },
        _sum: { debit: true, credit: true },
      }),
      prisma.$queryRaw<{ m: string }[]>`
        SELECT DISTINCT to_char(date, 'YYYY-MM') AS m
        FROM "StatementTransaction" WHERE "entityId" = ${entity.id} ORDER BY 1 DESC
      `,
    ])

  const docs = await prisma.journalDoc.findMany({
    where: { id: { in: posted.map((t) => t.docId).filter((d): d is string => d !== null) } },
    select: {
      id: true,
      deletedAt: true,
      _count: { select: { entries: true } },
      // The current version's lines — the "show me the transaction" popup
      // renders the journal underneath a posted row.
      currentEntry: {
        select: {
          lines: {
            select: {
              debit: true,
              credit: true,
              account: { select: { code: true, name: true } },
              costCentre: { select: { name: true } },
            },
          },
        },
      },
    },
  })
  // The master sheet's Nature rides on every head option, so picking a
  // head prefills nature (and its default cost centre) per the master —
  // both stay editable in the row.
  const headModes = await prisma.headMode.findMany({ select: { category: true, nature: true } })
  const natureByName = new Map(headModes.map((m) => [m.category.toLowerCase(), m.nature]))
  for (const h of heads as (typeof heads[number] & { masterNature?: string | null })[]) {
    h.masterNature = natureByName.get(h.name.toLowerCase()) ?? null
  }

  const docById = new Map(docs.map((d) => [d.id, d]))
  const headName = (id: string | null) => {
    const h = heads.find((a) => a.id === id)
    return h ? `${h.code} · ${h.name}` : '—'
  }
  const bankName = (id: string) => banks.find((b) => b.id === id)?.nickname ?? '?'
  const userName = (id: string | null) => users.find((u) => u.id === id)?.name ?? 'System'
  const natureLabel = (v: string | null) => NATURES.find((n) => n.value === v)?.label ?? v ?? '—'
  const ccName = (id: string | null) => costCentres.find((c) => c.id === id)?.name
  const aiReady = aiConfigured()
  const awaitingSuggestion = pending.filter((t) => t.aiSuggestedAt === null).length

  // Search auto-suggest: the parties the rule engine knows, busiest first.
  const topParties = (
    await prisma.tagRule.findMany({
      where: { entityId: entity.id },
      orderBy: { hits: 'desc' },
      take: 60,
      select: { pattern: true },
    })
  ).map((r) => r.pattern)

  // v2-prototype chrome: KPIs, filter summary, pagination.
  const entityBanks = banks.filter((b) => b.entityId === entity.id)
  const suggestionCount = pending.filter((t) => t.aiHeadAccountId && t.aiNature).length
  const inView = pending.length + tagged.length + posted.length
  const net = Number(sums._sum.debit ?? 0) - Number(sums._sum.credit ?? 0)
  const pages = Math.max(1, Math.ceil(pending.length / PER_PAGE))
  const page = Math.min(pageNo, pages)
  const pendingSlice = pending.slice((page - 1) * PER_PAGE, page * PER_PAGE)
  const hrefFor = (p: number) => {
    const s = new URLSearchParams()
    if (q) s.set('q', q)
    if (bank) s.set('bank', bank)
    if (month) s.set('month', month)
    if (view !== 'all') s.set('view', view)
    if (p > 1) s.set('page', String(p))
    const str = s.toString()
    return str ? `/tagging?${str}` : '/tagging'
  }
  const monthLabel = (m: string) => {
    const L = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return `${L[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`
  }
  const showPending = view === 'all' || view === 'pending'
  const showTagged = view === 'all' || view === 'tagged'
  const showPosted = view === 'all' || view === 'posted'
  const filtered = Boolean(q || bank || month)

  const kpiTiles: [string, string, string, string][] = [
    ['Entries in view', String(inView), bank ? (bankName(bank) ?? '') : 'all accounts', 'border-ink'],
    ['Untagged', String(pending.length), `${suggestionCount} have a suggestion`, 'border-primary'],
    [
      'Net movement',
      displayINR(Math.abs(net).toFixed(2)),
      net > 0 ? 'net outflow' : 'net inflow',
      'border-ink-3',
    ],
    ['Awaiting post', String(tagged.length), 'tagged, not yet posted', 'border-success'],
  ]

  // Leading cells of every row (date / account / narration / amount) — one
  // line per transaction, Excel-style. Clicking the narration opens the
  // full-transaction popup (every field + the journal for posted rows).
  const leadCells = (txn: (typeof pending)[number], tip?: string, chips?: ReactNode) => {
    const outflow = Number(txn.debit) > 0
    const desc = describeNarration(txn.narration)
    const doc = txn.docId ? docById.get(txn.docId) : undefined
    const taxBits = [
      txn.gstRate ? `GST ${Number(txn.gstRate)}%${txn.gstType ? ` ${txn.gstType}` : ''}${txn.hsn ? ` · HSN ${txn.hsn}` : ''}` : '',
      txn.tdsRate ? `TDS ${Number(txn.tdsRate)}% u/s ${txn.tdsSection}` : '',
    ].filter(Boolean)
    const detail = {
      title: desc.title,
      narration: txn.narration,
      fields: [
        ['Date', txn.date.toISOString().slice(0, 10)],
        ['Account', bankName(txn.bankAccountId)],
        ...(txn.reference ? [['Reference', txn.reference] as [string, string]] : []),
        [outflow ? 'Paid out' : 'Received', displayINR(String(outflow ? txn.debit : txn.credit))],
        ...(txn.balance !== null ? [['Balance after', displayINR(String(txn.balance))] as [string, string]] : []),
        ['Status', txn.status.toLowerCase()],
        ...(txn.headAccountId ? [['Head', headName(txn.headAccountId)] as [string, string]] : []),
        ...(ccName(txn.costCentreId) ? [['Cost centre', ccName(txn.costCentreId)!] as [string, string]] : []),
        ...(txn.taggedById || txn.autoTagged
          ? [['Tagged', txn.autoTagged ? 'Verified by System' : `${txn.tagSource ?? 'manual'} — ${userName(txn.taggedById)}`] as [string, string]]
          : []),
      ] as [string, string][],
      tax: taxBits.length ? taxBits.join(' + ') : null,
      journal: doc?.currentEntry?.lines.map((l) => ({
        account: `${l.account.code} · ${l.account.name}`,
        costCentre: l.costCentre?.name ?? null,
        debit: String(l.debit),
        credit: String(l.credit),
      })),
    }
    const title = [txn.narration, txn.reference ? `ref ${txn.reference}` : '', tip ?? '']
      .filter(Boolean)
      .join('\n')
    return (
      <>
        <td className="whitespace-nowrap px-2 py-1.5 text-xs tabular-nums text-ink-2">
          {txn.date.toISOString().slice(0, 10)}
        </td>
        <td className="px-2 py-1.5">
          <span className="whitespace-nowrap rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-2">
            {bankName(txn.bankAccountId)}
          </span>
        </td>
        {/* Capped width keeps narration and amount snug together — the
            table's slack goes to the head column instead. */}
        <td className="px-2 py-1.5">
          <span className="flex max-w-[22rem] items-center gap-1.5">
            <span className="min-w-0" title={title}>
              <TxnDetails data={detail} />
            </span>
            {desc.kind && (
              <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-2">
                {desc.kind}
              </span>
            )}
            {chips}
          </span>
        </td>
        <td
          className={`whitespace-nowrap px-2 py-1.5 text-right font-semibold tabular-nums ${
            outflow ? 'text-danger' : 'text-success'
          }`}
        >
          {outflow ? 'Out' : 'In'} {displayINR(String(outflow ? txn.debit : txn.credit))}
        </td>
      </>
    )
  }

  const tableHead = (withCheckbox: boolean) => (
    <thead className={theadClass}>
      <tr>
        {withCheckbox && <th className="w-8 px-2 py-2" />}
        <th className="px-2 py-2">Date</th>
        <th className="px-2 py-2">A/c</th>
        <th className="px-2 py-2">Narration</th>
        <th className="px-2 py-2 text-right">Amount</th>
        <th className="w-[27%] min-w-44 px-2 py-2">Expense Head</th>
        <th className="w-[27%] min-w-44 px-2 py-2">Cost centre</th>
        <th className="px-2 py-2" />
      </tr>
    </thead>
  )

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="Books"
        title={`Tagging queue — ${entity.name} (${entity.code})`}
        subtitle="Pick head, nature and cost centre — the engine posts the books underneath. Every manual tag teaches the auto-verifier."
        actions={
          <>
            {awaitingSuggestion > 0 && (
              <form action={requestAiSuggestions}>
                <input type="hidden" name="entityId" value={entity.id} />
                <button
                  type="submit"
                  title="Matches pending rows against your own past tags (and asks AI too, when a key is configured)"
                  className="rounded-lg border border-primary/30 bg-primary-soft px-3 py-2 text-sm font-medium text-primary hover:bg-primary/15"
                >
                  {aiReady
                    ? `Suggest tags with AI (${Math.min(awaitingSuggestion, 25)})`
                    : `Suggest tags from my history (${awaitingSuggestion})`}
                </button>
              </form>
            )}
            {tagged.length > 0 && (
              <form action={postAll}>
                <input type="hidden" name="entityId" value={entity.id} />
                <button type="submit" className={buttonClass('primary')}>
                  Post All Confirmed ({tagged.length})
                </button>
              </form>
            )}
          </>
        }
      />

      {/* KPIs (v2 prototype) — one slim strip, not four tall cards: the
          vertical space belongs to the entries below. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-2xl border border-line bg-surface px-3 py-1.5 shadow-card">
        {kpiTiles.map(([label, value, sub, accent]) => (
          <div key={label} className={`flex items-baseline gap-1.5 border-l-2 pl-2 ${accent}`}>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
              {label}
            </span>
            <span className="text-sm font-semibold tabular-nums text-ink">{value}</span>
            <span className="text-[10px] text-ink-3">{sub}</span>
          </div>
        ))}
      </div>

      {/* Search & filters (v2 prototype) */}
      <form className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface p-2 shadow-card">
        <input
          name="q"
          defaultValue={q}
          list="tag-search-suggest"
          autoComplete="off"
          placeholder="Search — narration / head / cost centre"
          className={`${controlClass} w-72`}
        />
        {/* Auto-suggest: first letters filter heads, natures, cost centres
            and the parties the rule engine knows (native datalist). */}
        <datalist id="tag-search-suggest">
          {heads.map((h) => (
            <option key={`h-${h.id}`} value={h.name}>head</option>
          ))}
          {NATURES.map((n) => (
            <option key={`n-${n.value}`} value={n.label}>nature</option>
          ))}
          {costCentres.map((c) => (
            <option key={`c-${c.id}`} value={c.name}>cost centre</option>
          ))}
          {topParties.map((p) => (
            <option key={`p-${p}`} value={p}>party</option>
          ))}
        </datalist>
        <select name="bank" defaultValue={bank} className={controlClass}>
          <option value="">All accounts</option>
          {entityBanks.map((b) => (
            <option key={b.id} value={b.id}>{b.nickname}</option>
          ))}
        </select>
        <select name="month" defaultValue={month} className={controlClass}>
          <option value="">All months</option>
          {monthRows.map((r) => (
            <option key={r.m} value={r.m}>{monthLabel(r.m)}</option>
          ))}
        </select>
        <select name="view" defaultValue={view} className={controlClass}>
          <option value="all">All entries</option>
          <option value="pending">Untagged only</option>
          <option value="tagged">Tagged only</option>
          <option value="posted">Posted only</option>
        </select>
        <button
          type="submit"
          className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2"
        >
          Apply
        </button>
        {filtered && (
          <Link href="/tagging" className="text-xs text-ink-3 hover:text-ink-2">
            reset
          </Link>
        )}
        <span className="ml-auto text-xs text-ink-2">
          {inView} of {totalEntries} entries · {pending.length} untagged
        </span>
      </form>

      {/* Bulk tagging (v2 prototype): tick rows below, apply one tag to all */}
      {showPending && pendingSlice.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-success/30 bg-success-soft/60 p-2">
          <form id="bulk-tag" action={bulkTag} className="flex flex-wrap items-center gap-2">
            <SelectAll />
            <HeadCombobox
              heads={heads}
              required
              placeholder="Expense Head — type or add"
              createName="headText"
              className={`${controlClass} w-56`}
            />
            <SmartCombobox
              options={costCentres.map((c) => ({ id: c.id, label: c.name }))}
              name="costCentreId"
              createName="costCentreText"
              placeholder="Cost centre — type or add"
              className={`${controlClass} w-56`}
            />
            {/* Same GST/TDS for every ticked row (spec §7) */}
            <details>
              <summary className="cursor-pointer text-xs text-ink-2 hover:text-ink">GST/TDS</summary>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <select name="gstType" className="rounded-lg border border-line bg-surface px-2 py-1 text-xs">
                  <option value="">GST type</option>
                  {GST_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <select name="gstRate" className="rounded-lg border border-line bg-surface px-2 py-1 text-xs">
                  <option value="">GST rate %</option>
                  {GST_RATES.map((r) => (
                    <option key={r} value={r}>{r}%</option>
                  ))}
                </select>
                <input name="hsn" placeholder="HSN/SAC" className="w-24 rounded-lg border border-line px-2 py-1 text-xs" />
                <select name="tdsSection" className="rounded-lg border border-line bg-surface px-2 py-1 text-xs">
                  <option value="">TDS section</option>
                  {TDS_SECTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <input name="tdsRate" placeholder="TDS rate %" inputMode="decimal" className="w-20 rounded-lg border border-line px-2 py-1 text-xs" />
                <input name="deducteePan" placeholder="Deductee PAN" className="w-28 rounded-lg border border-line px-2 py-1 text-xs" />
              </div>
            </details>
            <button
              type="submit"
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-strong"
            >
              Apply to selected
            </button>
          </form>
          {suggestionCount > 0 && (
            <form action={acceptAllSuggestions}>
              <input type="hidden" name="entityId" value={entity.id} />
              <button
                type="submit"
                className="rounded-lg border border-primary/30 bg-primary-soft px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/15"
              >
                Accept {suggestionCount} suggestions
              </button>
            </form>
          )}
        </div>
      )}

      {/* Pending queue */}
      {showPending && (
      <div className="space-y-2">
        <h2 className="font-medium text-ink">
          Pending ({pending.length}){pages > 1 && (
            <span className="ml-2 text-xs font-normal text-ink-3">Page {page} of {pages}</span>
          )}
        </h2>
        {pendingSlice.length > 0 && (
          <div className={tableWrapClass}>
            <table className="w-full min-w-[68rem] text-left text-sm">
              {tableHead(true)}
              <tbody className="divide-y divide-line-2">
                {pendingSlice.map((txn) => {
                  const confidence = txn.aiConfidence === null ? null : Number(txn.aiConfidence)
                  const hasSuggestion = Boolean(txn.aiHeadAccountId && txn.aiNature)
                  const aiTip =
                    !hasSuggestion && txn.aiSuggestedAt !== null && txn.aiReason
                      ? `AI: ${txn.aiReason}`
                      : undefined
                  return (
                    <Fragment key={txn.id}>
                      <tr className="align-top hover:bg-surface-2/60">
                        <td className="px-2 py-1.5">
                          <input
                            type="checkbox"
                            name="ids"
                            value={txn.id}
                            form="bulk-tag"
                            className="accent-primary"
                            aria-label="Select for bulk tagging"
                          />
                        </td>
                        {leadCells(txn, aiTip)}
                        {/* The row opens FILLED per the master: the suggested
                            (or rule) head, its master nature and default cost
                            centre — visible at once, editable as ever. */}
                        <TagRowCells
                          txnId={txn.id}
                          isOutflow={Number(txn.debit) > 0}
                          heads={heads}
                          costCentres={costCentres}
                          action={tagTransaction}
                          submitLabel="Tag"
                          defaults={(() => {
                            const sugHead = txn.aiHeadAccountId
                              ? heads.find((h) => h.id === txn.aiHeadAccountId)
                              : undefined
                            if (!sugHead) return undefined
                            return {
                              headAccountId: sugHead.id,
                              nature: txn.aiNature ?? suggestNature(sugHead, Number(txn.debit) > 0),
                              costCentreId: txn.aiCostCentreId ?? sugHead.defaultCostCentreId ?? '',
                            }
                          })()}
                        />
                      </tr>
                      {/* AI suggestion — advisory, one slim line under the row
                          (spec §12.8): accept it or ignore it. */}
                      {hasSuggestion && (
                        <tr className="border-t-0 bg-primary-soft/70">
                          <td className="px-2 py-1" />
                          <td colSpan={7} className="px-2 pb-1.5 pt-0.5">
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-primary">
                                AI
                              </span>
                              <span
                                className="font-medium text-ink"
                                title={txn.aiReason ?? undefined}
                              >
                                {headName(txn.aiHeadAccountId)}
                              </span>
                              {ccName(txn.aiCostCentreId) && (
                                <>
                                  <span className="text-ink-3">·</span>
                                  <span className="text-ink-2">{ccName(txn.aiCostCentreId)}</span>
                                </>
                              )}
                              {confidence !== null && (
                                <span
                                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                    confidence >= 0.8
                                      ? 'bg-success-soft text-success'
                                      : confidence >= 0.5
                                        ? 'bg-warning-soft text-warning'
                                        : 'bg-surface-2 text-ink-2'
                                  }`}
                                >
                                  {Math.round(confidence * 100)}%
                                </span>
                              )}
                              <form action={acceptAiSuggestion}>
                                <input type="hidden" name="txnId" value={txn.id} />
                                <button
                                  type="submit"
                                  title="Accepting tags the row and teaches the rule engine, so this party is matched without AI next time."
                                  className="rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-white hover:bg-primary-strong"
                                >
                                  Accept & teach
                                </button>
                              </form>
                              <form action={dismissAiSuggestion}>
                                <input type="hidden" name="txnId" value={txn.id} />
                                <button
                                  type="submit"
                                  className="rounded border border-line bg-surface px-2 py-0.5 text-[11px] text-ink-2 hover:bg-surface-2"
                                >
                                  Dismiss
                                </button>
                              </form>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {pending.length === 0 && (
          <p className="text-sm text-ink-3">
            {filtered ? 'No pending entries match these filters.' : 'Queue is clear — nothing waiting.'}
          </p>
        )}
        {pages > 1 && (
          <div className="flex items-center gap-3 pt-1 text-sm">
            {page > 1 && (
              <Link href={hrefFor(page - 1)} className="rounded-lg border border-line px-3 py-1.5 text-ink-2 hover:bg-surface-2">
                ← Previous
              </Link>
            )}
            <span className="text-xs text-ink-3">Page {page} of {pages}</span>
            {page < pages && (
              <Link href={hrefFor(page + 1)} className="rounded-lg border border-line px-3 py-1.5 text-ink-2 hover:bg-surface-2">
                Next →
              </Link>
            )}
          </div>
        )}
      </div>
      )}

      {/* Tagged, awaiting post — the tag stays editable right in the row */}
      {showTagged && tagged.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-medium text-ink">Tagged — awaiting post ({tagged.length})</h2>
          <div className={tableWrapClass}>
            <table className="w-full min-w-[68rem] text-left text-sm">
              {tableHead(false)}
              <tbody className="divide-y divide-line-2">
                {tagged.map((txn) => (
                  <tr key={txn.id} className="align-top hover:bg-surface-2/60">
                    {leadCells(
                      txn,
                      txn.tagSource === 'ai'
                        ? `AI suggestion accepted by ${userName(txn.taggedById)}`
                        : `tagged by ${userName(txn.taggedById)}`,
                      txn.autoTagged ? (
                        <span className="shrink-0 rounded bg-primary-soft px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          auto
                        </span>
                      ) : undefined,
                    )}
                    <TagRowCells
                      txnId={txn.id}
                      isOutflow={Number(txn.debit) > 0}
                      heads={heads}
                      costCentres={costCentres}
                      action={tagTransaction}
                      submitLabel="Save"
                      defaults={{
                        headAccountId: txn.headAccountId,
                        nature: txn.nature,
                        costCentreId: txn.costCentreId,
                        gstType: txn.gstType,
                        gstRate: txn.gstRate === null ? null : String(txn.gstRate),
                        hsn: txn.hsn,
                        counterpartyGstin: txn.counterpartyGstin,
                        tdsSection: txn.tdsSection,
                        tdsRate: txn.tdsRate === null ? null : String(txn.tdsRate),
                        deducteePan: txn.deducteePan,
                      }}
                    >
                      <form action={untagTransaction}>
                        <input type="hidden" name="txnId" value={txn.id} />
                        <button
                          type="submit"
                          className="whitespace-nowrap rounded border border-line px-2 py-1 text-xs text-ink-2 hover:bg-surface-2"
                        >
                          Untag
                        </button>
                      </form>
                    </TagRowCells>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Posted — retag lives right in the row; posted rows cannot be
          deleted one by one, the books only move forward via retag
          (reversal + new version). */}
      {showPosted && (
      <div className="space-y-2">
        <h2 className="font-medium text-ink">Recently posted</h2>
        {posted.length > 0 && (
          <div className={tableWrapClass}>
            <table className="w-full min-w-[68rem] text-left text-sm">
              {tableHead(false)}
              <tbody className="divide-y divide-line-2">
                {posted.map((txn) => {
                  const doc = txn.docId ? docById.get(txn.docId) : undefined
                  const deleted = Boolean(doc?.deletedAt)
                  const chips = (
                    <>
                      {txn.autoTagged && (
                        <span className="shrink-0 rounded bg-primary-soft px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          auto
                        </span>
                      )}
                      {!txn.docId && (
                        <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-2">
                          mirror
                        </span>
                      )}
                      {deleted && (
                        <span className="shrink-0 rounded bg-danger-soft px-1.5 py-0.5 text-[10px] font-medium text-danger">
                          deleted
                        </span>
                      )}
                    </>
                  )
                  const editable = canEditPosted && Boolean(txn.docId) && !deleted
                  return (
                    <tr
                      key={txn.id}
                      className={deleted ? 'bg-danger-soft/40 opacity-70' : 'align-top hover:bg-surface-2/60'}
                    >
                      {leadCells(
                        txn,
                        !txn.docId ? 'mirror of own-account transfer' : undefined,
                        chips,
                      )}
                      {editable ? (
                        <TagRowCells
                          txnId={txn.id}
                          isOutflow={Number(txn.debit) > 0}
                          heads={heads}
                          costCentres={costCentres}
                          action={retagPosted}
                          submitLabel="Retag"
                          submitTitle="Posts a reversal + new version with this tag"
                          defaults={{
                            headAccountId: txn.headAccountId,
                            nature: txn.nature,
                            costCentreId: txn.costCentreId,
                            gstType: txn.gstType,
                            gstRate: txn.gstRate === null ? null : String(txn.gstRate),
                            hsn: txn.hsn,
                            counterpartyGstin: txn.counterpartyGstin,
                            tdsSection: txn.tdsSection,
                            tdsRate: txn.tdsRate === null ? null : String(txn.tdsRate),
                            deducteePan: txn.deducteePan,
                          }}
                        >
                          {(doc?._count.entries ?? 0) > 1 && (
                            <form action={undoPosted}>
                              <input type="hidden" name="txnId" value={txn.id} />
                              <button
                                type="submit"
                                className="whitespace-nowrap rounded border border-line px-2 py-1 text-xs text-ink-2 hover:bg-surface-2"
                              >
                                Undo
                              </button>
                            </form>
                          )}
                        </TagRowCells>
                      ) : (
                        <>
                          <td className="px-2 py-1.5 text-xs text-ink-2">
                            {headName(txn.headAccountId)}
                          </td>
                          <td className="px-2 py-1.5 text-xs text-ink-2">
                            {ccName(txn.costCentreId) ?? '—'}
                          </td>
                          <td className="px-2 py-1.5">
                            {canEditPosted && txn.docId && deleted && (
                              <form action={undoPosted}>
                                <input type="hidden" name="txnId" value={txn.id} />
                                <button
                                  type="submit"
                                  className="whitespace-nowrap rounded border border-line px-2 py-1 text-xs text-ink-2 hover:bg-surface-2"
                                >
                                  Undo delete
                                </button>
                              </form>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {posted.length === 0 && (
          <p className="text-sm text-ink-3">
            {filtered ? 'No posted entries match these filters.' : 'Nothing posted yet for these books.'}
          </p>
        )}
      </div>
      )}
    </div>
  )
}

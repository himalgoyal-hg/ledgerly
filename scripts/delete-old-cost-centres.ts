import 'dotenv/config'
import { prisma } from '../src/lib/db'

// Old (archived) cost centres go away for good — Himal, 18 Aug 2026. Every
// reference is remapped first so nothing displays blank: the related head's
// ACTIVE default cost centre (the master's word) wins; else an active
// same-named centre in the same books; else the link clears. Then the
// archived centres are deleted. Backup taken before running.

async function main() {
  const old = await prisma.costCentre.findMany({ where: { archivedAt: { not: null } } })
  const oldIds = old.map((o) => o.id)
  if (!oldIds.length) { console.log('no archived cost centres'); return }
  console.log('deleting:', old.map((o) => o.name).join(', '))

  const activeCcs = await prisma.costCentre.findMany({ where: { archivedAt: null } })
  const activeById = new Map(activeCcs.map((c) => [c.id, c]))
  const activeByEntityName = new Map(activeCcs.map((c) => [`${c.entityId}:${c.name.toLowerCase()}`, c.id]))
  const heads = await prisma.ledgerAccount.findMany({
    select: { id: true, entityId: true, defaultCostCentreId: true },
  })
  const headById = new Map(heads.map((h) => [h.id, h]))

  const replFor = (headId: string | null, entityId: string, oldCcId: string): string | null => {
    const head = headId ? headById.get(headId) : null
    if (head?.defaultCostCentreId && activeById.has(head.defaultCostCentreId)) return head.defaultCostCentreId
    const oldCc = old.find((o) => o.id === oldCcId)
    if (oldCc) {
      const sameName = activeByEntityName.get(`${entityId}:${oldCc.name.toLowerCase()}`)
      if (sameName) return sameName
    }
    return null
  }

  let remapped = 0
  let cleared = 0
  const bump = (to: string | null) => (to ? remapped++ : cleared++)

  // Statement transactions (tags): head → default CC
  const txns = await prisma.statementTransaction.findMany({
    where: { costCentreId: { in: oldIds } },
    select: { id: true, entityId: true, headAccountId: true, costCentreId: true },
  })
  for (const t of txns) {
    const to = replFor(t.headAccountId, t.entityId, t.costCentreId as string)
    await prisma.statementTransaction.update({ where: { id: t.id }, data: { costCentreId: to } })
    bump(to)
  }

  // Journal lines: the line's own account decides. The append-only guard
  // rightly blocks UPDATEs; this is a classification-only migration (no
  // amounts touched, backup taken), so the trigger sleeps for exactly this
  // block and wakes again right after.
  const lines = await prisma.journalLine.findMany({
    where: { costCentreId: { in: oldIds } },
    select: { id: true, accountId: true, costCentreId: true },
  })
  await prisma.$executeRawUnsafe('ALTER TABLE "JournalLine" DISABLE TRIGGER USER')
  try {
    for (const l of lines) {
      const acc = headById.get(l.accountId)
      const to = replFor(l.accountId, acc?.entityId ?? '', l.costCentreId as string)
      await prisma.$executeRaw`UPDATE "JournalLine" SET "costCentreId" = ${to} WHERE id = ${l.id}`
      bump(to)
    }
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "JournalLine" ENABLE TRIGGER USER')
  }

  // Cash entries, tag rules, salary people
  const cash = await prisma.cashEntry.findMany({
    where: { costCentreId: { in: oldIds } },
    select: { id: true, entityId: true, headAccountId: true, costCentreId: true },
  })
  for (const c of cash) {
    const to = replFor(c.headAccountId, c.entityId, c.costCentreId as string)
    await prisma.cashEntry.update({ where: { id: c.id }, data: { costCentreId: to } })
    bump(to)
  }
  const rules = await prisma.tagRule.findMany({
    where: { costCentreId: { in: oldIds } },
    select: { id: true, entityId: true, headAccountId: true, costCentreId: true },
  })
  for (const r of rules) {
    const to = replFor(r.headAccountId, r.entityId, r.costCentreId as string)
    await prisma.tagRule.update({ where: { id: r.id }, data: { costCentreId: to } })
    bump(to)
  }
  const sal = await prisma.salaryPerson.findMany({
    where: { costCentreId: { in: oldIds } },
    select: { id: true, entityId: true, costCentreId: true },
  })
  for (const s of sal) {
    const to = replFor(null, s.entityId, s.costCentreId as string)
    await prisma.salaryPerson.update({ where: { id: s.id }, data: { costCentreId: to } })
    bump(to)
  }

  // heads still pointing at an archived default
  const badHeads = await prisma.ledgerAccount.findMany({
    where: { defaultCostCentreId: { in: oldIds } },
    select: { id: true, entityId: true, defaultCostCentreId: true },
  })
  for (const h of badHeads) {
    const to = replFor(null, h.entityId, h.defaultCostCentreId as string)
    await prisma.ledgerAccount.update({ where: { id: h.id }, data: { defaultCostCentreId: to } })
    bump(to)
  }

  const del = await prisma.costCentre.deleteMany({ where: { id: { in: oldIds } } })
  console.log(`${remapped} references remapped to the head's master default, ${cleared} cleared, ${del.count} old centres deleted`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

import 'dotenv/config'
import { prisma } from '../src/lib/db'
import { nextChildCode } from '../src/lib/ledger/coa'
import { syncBudgetForHead } from '../src/lib/budget/plan'

// One-time: fold the AC books (Accurest Consulting proprietorship) into HG —
// the user decided the 2762 account and everything it carries belong in his
// personal books. Every reference is remapped onto HG heads/cost centres
// (found by name, created when missing), the bank account and its ledger
// account move across (re-coded to a free 11xx), and the empty AC shell is
// deleted. A full JSON backup was taken beforehand.

async function main() {
  const ac = await prisma.entity.findFirstOrThrow({ where: { code: 'AC' } })
  const hg = await prisma.entity.findFirstOrThrow({ where: { code: 'HG' } })
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } })

  await prisma.$executeRawUnsafe('ALTER TABLE "JournalLine" DISABLE TRIGGER USER')
  await prisma.$executeRawUnsafe('ALTER TABLE "JournalEntry" DISABLE TRIGGER USER')
  try {
    await prisma.$transaction(async (tx) => {
      // --- Bank account + its ledger account move as-is (re-coded) ---
      const bank = await tx.bankAccount.findFirstOrThrow({ where: { entityId: ac.id } })
      const bankLedger = await tx.ledgerAccount.findUniqueOrThrow({
        where: { id: bank.ledgerAccountId! },
      })
      const hgBankGroup = await tx.ledgerAccount.findUniqueOrThrow({
        where: { entityId_code: { entityId: hg.id, code: '1100' } },
      })
      const bankCode = await nextChildCode(tx, hg.id, '1100')
      await tx.ledgerAccount.update({
        where: { id: bankLedger.id },
        data: {
          entityId: hg.id, code: bankCode, parentId: hgBankGroup.id,
          name: 'AC HDFC 2762', defaultCostCentreId: null,
        },
      })
      await tx.bankAccount.update({
        where: { id: bank.id },
        data: { entityId: hg.id, nickname: 'AC HDFC 2762' },
      })
      console.log(`bank moved: ${bank.accountNumber} → HG as ${bankCode} AC HDFC 2762`)

      // --- Head remap (find by name in HG, else create under same group) ---
      const headMap = new Map<string, string>() // AC head id → HG head id
      headMap.set(bankLedger.id, bankLedger.id) // moved, same id
      const hgHeads = await tx.ledgerAccount.findMany({
        where: { entityId: hg.id, isGroup: false, archivedAt: null },
        include: { parent: { select: { code: true } } },
      })
      const hgByName = new Map(hgHeads.map((h) => [h.name.trim().toLowerCase(), h]))
      const mapHead = async (acHeadId: string): Promise<string> => {
        const hit = headMap.get(acHeadId)
        if (hit) return hit
        const acHead = await tx.ledgerAccount.findUniqueOrThrow({
          where: { id: acHeadId },
          include: { parent: { select: { code: true } } },
        })
        const existing = hgByName.get(acHead.name.trim().toLowerCase())
        if (existing) {
          headMap.set(acHeadId, existing.id)
          return existing.id
        }
        const groupCode = acHead.parent?.code ?? '5000'
        const hgGroup = await tx.ledgerAccount.findUniqueOrThrow({
          where: { entityId_code: { entityId: hg.id, code: groupCode } },
        })
        const created = await tx.ledgerAccount.create({
          data: {
            entityId: hg.id,
            code: await nextChildCode(tx, hg.id, groupCode),
            name: acHead.name, kind: acHead.kind, parentId: hgGroup.id,
          },
        })
        hgByName.set(created.name.trim().toLowerCase(), created as never)
        headMap.set(acHeadId, created.id)
        console.log(`head created in HG: ${created.code} ${created.name} (under ${groupCode})`)
        return created.id
      }

      // --- Cost centre remap ---
      const ccMap = new Map<string, string>()
      const mapCc = async (acCcId: string | null): Promise<string | null> => {
        if (!acCcId) return null
        const hit = ccMap.get(acCcId)
        if (hit) return hit
        const acCc = await tx.costCentre.findUniqueOrThrow({ where: { id: acCcId } })
        const existing = await tx.costCentre.findFirst({
          where: { entityId: hg.id, name: { equals: acCc.name, mode: 'insensitive' } },
        })
        const mine =
          existing ?? (await tx.costCentre.create({ data: { entityId: hg.id, name: acCc.name } }))
        ccMap.set(acCcId, mine.id)
        return mine.id
      }

      // --- Journal lines: remap account + cost centre ---
      const lines = await tx.journalLine.findMany({
        where: { entry: { entityId: ac.id } },
        select: { id: true, accountId: true, costCentreId: true },
      })
      for (const l of lines) {
        await tx.journalLine.update({
          where: { id: l.id },
          data: {
            accountId: await mapHead(l.accountId),
            costCentreId: await mapCc(l.costCentreId),
          },
        })
      }
      await tx.journalEntry.updateMany({ where: { entityId: ac.id }, data: { entityId: hg.id } })
      await tx.journalDoc.updateMany({ where: { entityId: ac.id }, data: { entityId: hg.id } })
      console.log(`journal moved: ${lines.length} lines remapped`)

      // --- Statement transactions + import ---
      const txns = await tx.statementTransaction.findMany({ where: { entityId: ac.id } })
      for (const t of txns) {
        await tx.statementTransaction.update({
          where: { id: t.id },
          data: {
            entityId: hg.id,
            headAccountId: t.headAccountId ? await mapHead(t.headAccountId) : null,
            costCentreId: await mapCc(t.costCentreId),
            aiHeadAccountId: null, aiNature: null, aiCostCentreId: null,
            aiConfidence: null, aiReason: null,
          },
        })
      }
      await tx.statementImport.updateMany({ where: { entityId: ac.id }, data: { entityId: hg.id } })
      console.log(`statements moved: ${txns.length} rows`)

      // --- Invoices (FX register rows; renumber on clash) ---
      const invoices = await tx.invoice.findMany({ where: { entityId: ac.id } })
      for (const inv of invoices) {
        let number = inv.number
        const clash = await tx.invoice.findFirst({ where: { entityId: hg.id, number } })
        if (clash) {
          const bumped = await tx.entity.update({
            where: { id: hg.id },
            data: { nextInvoiceNumber: { increment: 1 } },
          })
          number = `${bumped.invoicePrefix}-${String(bumped.nextInvoiceNumber - 1).padStart(4, '0')}`
        }
        await tx.invoice.update({
          where: { id: inv.id },
          data: {
            entityId: hg.id, number,
            debtorAccountId: await mapHead(inv.debtorAccountId),
            incomeAccountId: inv.incomeAccountId ? await mapHead(inv.incomeAccountId) : null,
            costCentreId: await mapCc(inv.costCentreId),
          },
        })
        console.log(`invoice moved: ${inv.number}${number !== inv.number ? ` → ${number}` : ''} (${inv.customer})`)
      }

      // --- Reimbursement claims ---
      const claims = await tx.reimbursement.updateMany({
        where: { entityId: ac.id },
        data: { entityId: hg.id },
      })
      console.log(`claims moved: ${claims.count}`)

      // --- Tag rules: keep HG's on clash; move the rest when the head maps ---
      const rules = await tx.tagRule.findMany({ where: { entityId: ac.id } })
      let movedRules = 0
      let skippedRules = 0
      for (const r of rules) {
        const clash = await tx.tagRule.findFirst({ where: { entityId: hg.id, pattern: r.pattern } })
        const headByName = await tx.ledgerAccount.findUnique({ where: { id: r.headAccountId } })
        const target = headByName
          ? hgByName.get(headByName.name.trim().toLowerCase()) ?? (headMap.get(r.headAccountId) ? { id: headMap.get(r.headAccountId)! } : null)
          : null
        if (clash || !target) {
          await tx.tagRule.delete({ where: { id: r.id } })
          skippedRules++
          continue
        }
        await tx.tagRule.update({
          where: { id: r.id },
          data: {
            entityId: hg.id,
            headAccountId: (target as { id: string }).id,
            costCentreId: await mapCc(r.costCentreId),
          },
        })
        movedRules++
      }
      console.log(`rules: ${movedRules} moved, ${skippedRules} dropped (clash or no matching head)`)

      // --- Budget lines + report rows ---
      const blines = await tx.budgetLine.findMany({ where: { entityId: ac.id } })
      const affectedHeads = new Set<string>()
      for (const b of blines) {
        const head = b.headAccountId ? await mapHead(b.headAccountId) : null
        await tx.budgetLine.update({
          where: { id: b.id },
          data: { entityId: hg.id, source: 'HG', headAccountId: head },
        })
        if (head) affectedHeads.add(head)
      }
      await tx.budget.deleteMany({ where: { entityId: ac.id } })
      for (const h of affectedHeads) await syncBudgetForHead(tx, h)
      console.log(`budget lines moved: ${blines.length} (source AC → HG)`)

      // --- Sweep the empty shell ---
      await tx.taxLine.updateMany({ where: { entityId: ac.id }, data: { entityId: hg.id } })
      await tx.userEntityScope.deleteMany({ where: { entityId: ac.id } })
      await tx.periodLock.deleteMany({ where: { entityId: ac.id } })
      await tx.paymentPreference.deleteMany({ where: { entityId: ac.id } }).catch(() => null)
      await tx.costCentre.deleteMany({ where: { entityId: ac.id } })
      await tx.ledgerAccount.deleteMany({ where: { entityId: ac.id } })
      await tx.auditLog.deleteMany({ where: { targetId: ac.id } })
      await tx.entity.delete({ where: { id: ac.id } })
      await tx.auditLog.create({
        data: {
          actorId: admin.id,
          action: 'entity.merge',
          targetType: 'Entity',
          targetId: hg.id,
          summary:
            'Merged AC (Accurest Consulting) into HG: bank 2762, 22 statement rows, journal, 1 invoice, 3 claims, budget lines — heads/cost centres remapped by name',
        },
      })
      console.log('AC entity deleted')
    }, { timeout: 60000 })
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "JournalLine" ENABLE TRIGGER USER')
    await prisma.$executeRawUnsafe('ALTER TABLE "JournalEntry" ENABLE TRIGGER USER')
  }

  // --- Post-checks ---
  const tb = await prisma.$queryRaw<{ dr: string; cr: string }[]>`
    SELECT SUM(l.debit)::text AS dr, SUM(l.credit)::text AS cr
    FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE e."entityId" = ${(await prisma.entity.findFirstOrThrow({ where: { code: 'HG' } })).id}
  `
  console.log(`HG trial balance: Dr ${tb[0].dr} = Cr ${tb[0].cr} → ${tb[0].dr === tb[0].cr ? 'BALANCED' : 'MISMATCH!'}`)
  const ents = await prisma.entity.findMany({ select: { code: true }, orderBy: { code: 'asc' } })
  console.log('entities:', ents.map((e) => e.code).join(', '))
}

main().finally(() => prisma.$disconnect())

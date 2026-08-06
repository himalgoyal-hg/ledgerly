'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { COA, getSystemAccount, nextChildCode } from '@/lib/ledger/coa'
import { createJournalDocument } from '@/lib/ledger/posting'
import { parsePaise, formatPaise } from '@/lib/ledger/money'

// Bank Account Manager + Cash Locations — Admin only (spec §2.2).
// Creating an account auto-creates its ledger account in the Chart of
// Accounts and posts the opening balance entry (Dr Bank / Cr Opening
// Balances). Phase 3 adds: archiving requires reconciliation first.

const bankAccountSchema = z.object({
  entityId: z.string().min(1, 'Entity is required'),
  bankName: z.string().trim().min(1, 'Bank name is required'),
  accountNumber: z.string().trim().min(4, 'Account number is required'),
  ifsc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC must look like ICIC0001234'),
  nickname: z.string().trim().min(1, 'Nickname is required'),
  openingBalance: z.coerce.number().finite(),
  openingDate: z.coerce.date(),
})

export async function createBankAccount(formData: FormData) {
  const admin = await requireAdmin()
  const parsed = bankAccountSchema.safeParse({
    entityId: formData.get('entityId'),
    bankName: formData.get('bankName'),
    accountNumber: formData.get('accountNumber'),
    ifsc: formData.get('ifsc'),
    nickname: formData.get('nickname'),
    openingBalance: formData.get('openingBalance'),
    openingDate: formData.get('openingDate'),
  })
  if (!parsed.success) throw new Error(parsed.error.issues[0].message)
  const data = parsed.data

  await auditedTransaction(async (tx) => {
    const entity = await tx.entity.findUniqueOrThrow({ where: { id: data.entityId } })
    if (entity.archivedAt) throw new Error('Cannot add accounts to an archived entity')
    const account = await tx.bankAccount.create({ data })

    // Auto-create the ledger account under Bank Accounts (1100)…
    const bankGroup = await getSystemAccount(tx, entity.id, COA.BANK_GROUP)
    const code = await nextChildCode(tx, entity.id, COA.BANK_GROUP)
    const ledgerAccount = await tx.ledgerAccount.create({
      data: {
        entityId: entity.id,
        code,
        name: data.nickname,
        kind: 'ASSET',
        parentId: bankGroup.id,
        system: true,
      },
    })
    await tx.bankAccount.update({
      where: { id: account.id },
      data: { ledgerAccountId: ledgerAccount.id },
    })

    // …and post the opening balance (spec §2.2). Positive → Dr Bank /
    // Cr Opening Balances; negative (overdraft) → the other way round.
    const paise = parsePaise(String(data.openingBalance))
    if (paise !== 0n) {
      const opening = await getSystemAccount(tx, entity.id, COA.OPENING_BALANCES)
      const amount = formatPaise(paise < 0n ? -paise : paise)
      await createJournalDocument(tx, {
        entityId: entity.id,
        sourceType: 'opening_balance',
        sourceId: account.id,
        actorId: admin.id,
        content: {
          date: data.openingDate,
          narration: `Opening balance — ${data.nickname}`,
          lines:
            paise > 0n
              ? [
                  { accountId: ledgerAccount.id, debit: amount },
                  { accountId: opening.id, credit: amount },
                ]
              : [
                  { accountId: opening.id, debit: amount },
                  { accountId: ledgerAccount.id, credit: amount },
                ],
        },
      })
    }

    await audit(tx, {
      actorId: admin.id,
      action: 'bank_account.create',
      targetType: 'BankAccount',
      targetId: account.id,
      summary: `Created bank account ${data.nickname} under ${entity.code} (ledger ${code}, opening ₹${data.openingBalance})`,
      after: {
        entity: entity.code,
        bankName: data.bankName,
        accountNumber: data.accountNumber,
        ifsc: data.ifsc,
        nickname: data.nickname,
        openingBalance: data.openingBalance,
        openingDate: data.openingDate.toISOString().slice(0, 10),
        ledgerCode: code,
      },
    })
  })
  revalidatePath('/', 'layout')
}

export async function archiveBankAccount(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  await auditedTransaction(async (tx) => {
    const account = await tx.bankAccount.findUniqueOrThrow({ where: { id } })
    if (account.archivedAt) throw new Error('Account is already archived')
    // Phase 2: block here if the account has unreconciled items (spec §2.2).
    await tx.bankAccount.update({ where: { id }, data: { archivedAt: new Date() } })
    await audit(tx, {
      actorId: admin.id,
      action: 'bank_account.archive',
      targetType: 'BankAccount',
      targetId: id,
      summary: `Archived bank account ${account.nickname}`,
    })
  })
  revalidatePath('/admin/banking')
}

export async function restoreBankAccount(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  await auditedTransaction(async (tx) => {
    const account = await tx.bankAccount.findUniqueOrThrow({ where: { id } })
    if (!account.archivedAt) throw new Error('Account is not archived')
    await tx.bankAccount.update({ where: { id }, data: { archivedAt: null } })
    await audit(tx, {
      actorId: admin.id,
      action: 'bank_account.restore',
      targetType: 'BankAccount',
      targetId: id,
      summary: `Restored bank account ${account.nickname}`,
    })
  })
  revalidatePath('/admin/banking')
}

const cashLocationSchema = z.object({
  entityId: z.string().min(1, 'Entity is required'),
  name: z.string().trim().min(1, 'Location name is required'),
})

export async function createCashLocation(formData: FormData) {
  const admin = await requireAdmin()
  const parsed = cashLocationSchema.safeParse({
    entityId: formData.get('entityId'),
    name: formData.get('name'),
  })
  if (!parsed.success) throw new Error(parsed.error.issues[0].message)
  const data = parsed.data

  await auditedTransaction(async (tx) => {
    const entity = await tx.entity.findUniqueOrThrow({ where: { id: data.entityId } })
    if (entity.archivedAt) throw new Error('Cannot add locations to an archived entity')
    const location = await tx.cashLocation.create({ data })

    // Auto-create the ledger account under Cash (1200).
    const cashGroup = await getSystemAccount(tx, entity.id, COA.CASH_GROUP)
    const code = await nextChildCode(tx, entity.id, COA.CASH_GROUP)
    const ledgerAccount = await tx.ledgerAccount.create({
      data: {
        entityId: entity.id,
        code,
        name: `Cash — ${data.name}`,
        kind: 'ASSET',
        parentId: cashGroup.id,
        system: true,
      },
    })
    await tx.cashLocation.update({
      where: { id: location.id },
      data: { ledgerAccountId: ledgerAccount.id },
    })

    await audit(tx, {
      actorId: admin.id,
      action: 'cash_location.create',
      targetType: 'CashLocation',
      targetId: location.id,
      summary: `Created cash location "${data.name}" under ${entity.code} (ledger ${code})`,
      after: { entity: entity.code, name: data.name, ledgerCode: code },
    })
  })
  revalidatePath('/', 'layout')
}

export async function archiveCashLocation(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  await auditedTransaction(async (tx) => {
    const location = await tx.cashLocation.findUniqueOrThrow({ where: { id } })
    if (location.archivedAt) throw new Error('Location is already archived')
    // Phase 2: block archiving a location holding a non-zero cash balance.
    await tx.cashLocation.update({ where: { id }, data: { archivedAt: new Date() } })
    await audit(tx, {
      actorId: admin.id,
      action: 'cash_location.archive',
      targetType: 'CashLocation',
      targetId: id,
      summary: `Archived cash location "${location.name}"`,
    })
  })
  revalidatePath('/admin/banking')
}

export async function restoreCashLocation(formData: FormData) {
  const admin = await requireAdmin()
  const id = String(formData.get('id') ?? '')

  await auditedTransaction(async (tx) => {
    const location = await tx.cashLocation.findUniqueOrThrow({ where: { id } })
    if (!location.archivedAt) throw new Error('Location is not archived')
    await tx.cashLocation.update({ where: { id }, data: { archivedAt: null } })
    await audit(tx, {
      actorId: admin.id,
      action: 'cash_location.restore',
      targetType: 'CashLocation',
      targetId: id,
      summary: `Restored cash location "${location.name}"`,
    })
  })
  revalidatePath('/admin/banking')
}

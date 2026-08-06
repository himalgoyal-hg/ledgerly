import 'server-only'
import { prisma } from '@/lib/db'
import type { Prisma } from '@/generated/prisma/client'

type Auditable = Prisma.InputJsonValue | undefined

export interface AuditEntry {
  actorId: string | null
  action: string // "user.create" | "permission.update" | "entity.archive" | ...
  targetType: string
  targetId: string
  summary: string
  before?: Auditable
  after?: Auditable
}

/**
 * Append-only audit trail (spec §1.1/§5): who, when, what, before → after.
 * Call inside the same interactive transaction as the mutation so an audit
 * row can never exist without its change (and vice versa).
 */
export async function audit(
  tx: Prisma.TransactionClient,
  entry: AuditEntry,
) {
  await tx.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      summary: entry.summary,
      before: entry.before ?? undefined,
      after: entry.after ?? undefined,
    },
  })
}

/** Convenience wrapper: run a mutation + its audit rows atomically. */
export async function auditedTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(fn)
}

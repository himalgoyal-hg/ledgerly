'use server'

import { revalidatePath } from 'next/cache'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth'
import { audit, auditedTransaction } from '@/lib/audit'
import { isPermissionFlag, PERMISSION_FLAGS, PERMISSION_LABELS, ROLE_PRESETS } from '@/lib/permissions'

// Every action here is Admin-only (spec §1.1: user & permission management
// is never grantable). requireAdmin() is the server-side check — the UI is
// never trusted.

const createMemberSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  email: z.string().trim().toLowerCase().email('Valid email required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

export async function createMember(formData: FormData) {
  const admin = await requireAdmin()
  const parsed = createMemberSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
  })
  if (!parsed.success) throw new Error(parsed.error.issues[0].message)
  const { name, email, password } = parsed.data

  const passwordHash = await bcrypt.hash(password, 12)
  await auditedTransaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name,
        email,
        passwordHash,
        role: 'MEMBER', // Role is never taken from input — single-admin model.
        permissions: { create: {} }, // zero permissions except reimbursementSubmit default
      },
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'user.create',
      targetType: 'User',
      targetId: user.id,
      summary: `Created member ${name} <${email}>`,
      after: { name, email, role: 'MEMBER' },
    })
  })
  revalidatePath('/admin/users')
}

export async function setPermission(formData: FormData) {
  const admin = await requireAdmin()
  const userId = String(formData.get('userId') ?? '')
  const flag = String(formData.get('flag') ?? '')
  const value = formData.get('value') === 'true'
  if (!userId || !isPermissionFlag(flag)) throw new Error('Invalid permission update')

  await auditedTransaction(async (tx) => {
    const target = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      include: { permissions: true },
    })
    if (target.role === 'ADMIN') throw new Error('Admin permissions are not editable')
    const before = target.permissions?.[flag] ?? false
    await tx.memberPermission.upsert({
      where: { userId },
      create: { userId, [flag]: value },
      update: { [flag]: value },
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'permission.update',
      targetType: 'User',
      targetId: userId,
      summary: `${value ? 'Granted' : 'Revoked'} "${PERMISSION_LABELS[flag]}" for ${target.name}`,
      before: { [flag]: before },
      after: { [flag]: value },
    })
  })
  // Takes effect immediately: every request re-reads permissions server-side.
  revalidatePath('/', 'layout')
}

export async function setUserActive(formData: FormData) {
  const admin = await requireAdmin()
  const userId = String(formData.get('userId') ?? '')
  const active = formData.get('active') === 'true'

  await auditedTransaction(async (tx) => {
    const target = await tx.user.findUniqueOrThrow({ where: { id: userId } })
    if (target.role === 'ADMIN') throw new Error('The Main Admin cannot be deactivated')
    await tx.user.update({ where: { id: userId }, data: { isActive: active } })
    await audit(tx, {
      actorId: admin.id,
      action: active ? 'user.activate' : 'user.deactivate',
      targetType: 'User',
      targetId: userId,
      summary: `${active ? 'Activated' : 'Deactivated'} ${target.name}`,
      before: { isActive: target.isActive },
      after: { isActive: active },
    })
  })
  revalidatePath('/admin/users')
}

export async function resetMemberPassword(formData: FormData) {
  const admin = await requireAdmin()
  const userId = String(formData.get('userId') ?? '')
  const password = String(formData.get('password') ?? '')
  if (password.length < 8) throw new Error('Password must be at least 8 characters')

  const passwordHash = await bcrypt.hash(password, 12)
  await auditedTransaction(async (tx) => {
    const target = await tx.user.findUniqueOrThrow({ where: { id: userId } })
    await tx.user.update({ where: { id: userId }, data: { passwordHash } })
    await audit(tx, {
      actorId: admin.id,
      action: 'user.password_reset',
      targetType: 'User',
      targetId: userId,
      summary: `Reset password for ${target.name}`,
    })
  })
  revalidatePath('/admin/users')
}

/** Toggle per-entity scoping on/off for a member (spec §1.2). */
export async function setEntityScoped(formData: FormData) {
  const admin = await requireAdmin()
  const userId = String(formData.get('userId') ?? '')
  const scoped = formData.get('scoped') === 'true'

  await auditedTransaction(async (tx) => {
    const target = await tx.user.findUniqueOrThrow({ where: { id: userId } })
    if (target.role === 'ADMIN') throw new Error('Admin cannot be entity-scoped')
    await tx.user.update({ where: { id: userId }, data: { entityScoped: scoped } })
    await audit(tx, {
      actorId: admin.id,
      action: 'user.entity_scoping',
      targetType: 'User',
      targetId: userId,
      summary: `${scoped ? 'Enabled' : 'Disabled'} entity scoping for ${target.name}`,
      before: { entityScoped: target.entityScoped },
      after: { entityScoped: scoped },
    })
  })
  revalidatePath('/', 'layout')
}

/** Grant/revoke a specific entity for a scoped member. */
export async function setEntityScope(formData: FormData) {
  const admin = await requireAdmin()
  const userId = String(formData.get('userId') ?? '')
  const entityId = String(formData.get('entityId') ?? '')
  const grant = formData.get('grant') === 'true'
  if (!userId || !entityId) throw new Error('Invalid scope update')

  await auditedTransaction(async (tx) => {
    const target = await tx.user.findUniqueOrThrow({ where: { id: userId } })
    const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId } })
    if (grant) {
      await tx.userEntityScope.upsert({
        where: { userId_entityId: { userId, entityId } },
        create: { userId, entityId },
        update: {},
      })
    } else {
      await tx.userEntityScope.deleteMany({ where: { userId, entityId } })
    }
    await audit(tx, {
      actorId: admin.id,
      action: 'user.entity_scope',
      targetType: 'User',
      targetId: userId,
      summary: `${grant ? 'Granted' : 'Revoked'} entity ${entity.code} for ${target.name}`,
      after: { entityId, entityCode: entity.code, granted: grant },
    })
  })
  revalidatePath('/', 'layout')
}

export async function applyRolePreset(formData: FormData) {
  const admin = await requireAdmin()
  const userId = String(formData.get('userId') ?? '')
  const preset = String(formData.get('preset') ?? '') as keyof typeof ROLE_PRESETS
  const def = ROLE_PRESETS[preset]
  if (!userId || !def) throw new Error('Invalid preset')

  await auditedTransaction(async (tx) => {
    const target = await tx.user.findUniqueOrThrow({ where: { id: userId } })
    if (target.role === 'ADMIN') throw new Error('Admin permissions are not editable')
    const row = Object.fromEntries(
      PERMISSION_FLAGS.map((f) => [f, (def.flags as readonly string[]).includes(f)]),
    )
    await tx.memberPermission.upsert({
      where: { userId },
      create: { userId, ...row },
      update: row,
    })
    await audit(tx, {
      actorId: admin.id,
      action: 'permission.preset',
      targetType: 'User',
      targetId: userId,
      summary: `Applied role preset "${def.label}" to ${target.name}`,
      after: row,
    })
  })
  revalidatePath('/', 'layout')
}

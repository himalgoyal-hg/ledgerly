'use server'

import { redirect } from 'next/navigation'
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/session'
import { audit, auditedTransaction } from '@/lib/audit'

export interface LoginState {
  error?: string
}

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const password = String(formData.get('password') ?? '')
  if (!email || !password) return { error: 'Email and password are required.' }

  const user = await prisma.user.findFirst({
    where: { email, isActive: true, deletedAt: null },
  })
  // Constant-shape response: never reveal which of email/password failed.
  const ok = user && (await bcrypt.compare(password, user.passwordHash))
  if (!ok || !user) return { error: 'Invalid email or password.' }

  const session = await getSession()
  session.userId = user.id
  await session.save()

  await auditedTransaction((tx) =>
    audit(tx, {
      actorId: user.id,
      action: 'auth.login',
      targetType: 'User',
      targetId: user.id,
      summary: `${user.name} logged in`,
    }),
  )

  redirect('/')
}

export async function logoutAction() {
  const session = await getSession()
  const userId = session.userId
  session.destroy()
  if (userId) {
    await auditedTransaction((tx) =>
      audit(tx, {
        actorId: userId,
        action: 'auth.logout',
        targetType: 'User',
        targetId: userId,
        summary: 'Logged out',
      }),
    )
  }
  redirect('/login')
}

'use client'

import { useActionState } from 'react'
import { loginAction, type LoginState } from './actions'
import { buttonClass, controlClass } from '@/components/ui'

export default function LoginPage() {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(
    loginAction,
    {},
  )

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-8 shadow-card">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Ledgerly
        </h1>
        <p className="mt-1 text-sm text-ink-2">Sign in to your books</p>
        <form action={formAction} className="mt-6 space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-ink-2">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className={`${controlClass} mt-1 w-full`}
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-ink-2">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className={`${controlClass} mt-1 w-full`}
            />
          </div>
          {state.error && (
            <p className="text-sm text-danger" role="alert">
              {state.error}
            </p>
          )}
          <button
            type="submit"
            disabled={pending}
            className={`${buttonClass('primary')} w-full`}
          >
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  )
}

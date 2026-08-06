import { cookies } from 'next/headers'
import { getIronSession, type SessionOptions } from 'iron-session'

export interface SessionData {
  userId?: string
  // "Books of" switcher selection (entity id); every screen scopes to this.
  booksEntityId?: string
}

const sessionOptions: SessionOptions = {
  cookieName: 'ledgerly_session',
  password: process.env.SESSION_SECRET!,
  cookieOptions: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
}

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions)
}

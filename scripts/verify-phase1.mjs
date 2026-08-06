// Phase 1 runtime verification (spec §11.3 — edit lock test):
// a member with zero grants can see/do nothing; admin sees everything.
// Probes the running server with sealed session cookies, exactly as a
// browser would present them.
import 'dotenv/config'
import { sealData } from 'iron-session'
import pg from 'pg'

const BASE = 'http://localhost:3000'
const results = []
const check = (name, ok, detail = '') =>
  results.push({ name, ok, detail }) && console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
const { rows: users } = await db.query(
  `select id, name, role from "User" where "deletedAt" is null`,
)
const admin = users.find((u) => u.role === 'ADMIN')
const member = users.find((u) => u.name === 'Greeshma')

async function cookieFor(userId) {
  const sealed = await sealData({ userId }, { password: process.env.SESSION_SECRET, ttl: 14 * 24 * 3600 })
  return `ledgerly_session=${sealed}`
}

async function get(path, cookie) {
  const res = await fetch(BASE + path, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  })
  const body = res.status === 200 ? await res.text() : ''
  return { status: res.status, location: res.headers.get('location'), body }
}

const adminCookie = await cookieFor(admin.id)
const memberCookie = await cookieFor(member.id)

// --- Admin sees everything ---
{
  const r = await get('/', adminCookie)
  check('admin: overview renders', r.status === 200)
  check('admin: sees admin nav', r.body.includes('Users &amp; permissions') || r.body.includes('Users & permissions'))
  for (const p of ['/admin/users', '/admin/entities', '/admin/banking', '/admin/audit']) {
    const rr = await get(p, adminCookie)
    check(`admin: ${p} renders`, rr.status === 200)
  }
}

// --- Zero-permission member sees nothing gated ---
{
  const r = await get('/', memberCookie)
  check('member: overview renders', r.status === 200)
  check('member: NO admin nav', !r.body.includes('/admin/users'))
  check('member: NO statements nav', !r.body.includes('/statements'))
  check('member: NO tagging nav', !r.body.includes('/tagging'))
  check('member: NO reports nav', !r.body.includes('/reports'))
  check('member: NO tax nav', !r.body.includes('/tax'))
  check('member: NO cash nav', !r.body.includes('href="/cash"'))
  check('member: HAS reimbursements (default flag)', r.body.includes('/reimbursements'))
  for (const p of ['/admin/users', '/admin/entities', '/admin/banking', '/admin/audit']) {
    const rr = await get(p, memberCookie)
    check(`member: ${p} blocked`, rr.status >= 400 || (rr.status === 200 && !rr.body.includes('Create')))
  }
}

// --- Granting exactly one flag opens exactly that capability ---
{
  await db.query(`update "MemberPermission" set "transactionTagging"=true where "userId"=$1`, [member.id])
  const r = await get('/', memberCookie)
  check('member+tagging: tagging nav appears', r.body.includes('/tagging'))
  check('member+tagging: statements still hidden', !r.body.includes('/statements'))
  check('member+tagging: reports still hidden', !r.body.includes('/reports'))
  await db.query(`update "MemberPermission" set "transactionTagging"=false where "userId"=$1`, [member.id])
  const r2 = await get('/', memberCookie)
  check('member: revoke takes effect immediately', !r2.body.includes('/tagging'))
}

// --- Deactivated member loses access entirely ---
{
  await db.query(`update "User" set "isActive"=false where id=$1`, [member.id])
  const r = await get('/', memberCookie)
  check('deactivated member: redirected to login', r.status === 307 && r.location?.includes('/login'))
  await db.query(`update "User" set "isActive"=true where id=$1`, [member.id])
}

// --- Garbage cookie rejected ---
{
  const r = await get('/', 'ledgerly_session=forged-garbage')
  check('forged cookie: redirected to login', r.status === 307 && r.location?.includes('/login'))
}

await db.end()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)

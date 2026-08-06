import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

// Seeds the single Main Admin (spec §1.1: cannot be deleted or demoted)
// and the member logins, each with zero permissions except the
// reimbursementSubmit default. Idempotent: safe to re-run.

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
})

const ADMIN = { name: 'Himal', email: 'himal.goyal@accurest.co' }
const MEMBERS = [
  { name: 'Greeshma', email: 'greeshma@accurest.co' },
  { name: 'Prakash', email: 'prakash@accurest.co' },
  { name: 'Sanjeevani', email: 'sanjeevani@accurest.co' },
]

async function main() {
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Ledgerly@Admin1'
  const memberPassword = process.env.SEED_MEMBER_PASSWORD ?? 'Ledgerly@Member1'

  const admin = await prisma.user.upsert({
    where: { email: ADMIN.email },
    create: {
      name: ADMIN.name,
      email: ADMIN.email,
      passwordHash: await bcrypt.hash(adminPassword, 12),
      role: 'ADMIN',
    },
    update: {}, // never overwrite a live admin
  })
  console.log(`Admin:  ${admin.name} <${admin.email}>`)

  for (const m of MEMBERS) {
    const member = await prisma.user.upsert({
      where: { email: m.email },
      create: {
        name: m.name,
        email: m.email,
        passwordHash: await bcrypt.hash(memberPassword, 12),
        role: 'MEMBER',
        permissions: { create: {} }, // zero permissions (reimbursementSubmit defaults on)
      },
      update: {},
    })
    console.log(`Member: ${member.name} <${member.email}>`)
  }

  console.log('\nInitial passwords come from SEED_ADMIN_PASSWORD / SEED_MEMBER_PASSWORD')
  console.log('in .env — change them after first login.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())

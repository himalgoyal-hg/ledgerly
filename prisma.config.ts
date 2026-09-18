import 'dotenv/config'
import { defineConfig } from 'prisma/config'

// Migrations and the seed go through the direct (unpooled) connection when
// the host provides one — Neon's PgBouncer pooler on DATABASE_URL does not
// support the advisory locks `prisma migrate` takes. The app itself keeps
// using DATABASE_URL (src/lib/db.ts).
const migrationUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: migrationUrl,
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'npx tsx prisma/seed.ts',
  },
})

import { prisma } from '@/lib/db'
import { runAutomation } from '@/lib/automation/run'

// Cron entry point for the automation job (spec §6.5, §10).
//
// Nothing in the app fires on a timer by itself — a scheduler has to call
// this. Set CRON_SECRET in .env and point your scheduler at it daily:
//
//   0 7 * * *  curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
//                https://<host>/api/automation/run
//
// The job is idempotent, so a missed or repeated run is harmless. Without
// CRON_SECRET set the endpoint refuses to run at all, so an unconfigured
// deployment can never expose it.

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return Response.json(
      { error: 'CRON_SECRET is not configured — automation endpoint disabled' },
      { status: 503 },
    )
  }
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${secret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Attribute generated records to the main admin.
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } })
  if (!admin) return Response.json({ error: 'No admin user' }, { status: 500 })

  const report = await runAutomation({ actorId: admin.id })
  return Response.json(report)
}

/** GET mirrors POST — some schedulers only issue GETs. */
export async function GET(request: Request) {
  return POST(request)
}

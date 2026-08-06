import { prisma } from '@/lib/db'

// Notification outbox (spec §6.5 reminders, §10 weekly summary).
//
// Messages are rendered and stored BEFORE any delivery attempt, keyed by a
// unique dedupeKey. Two things follow: re-running the job never double-sends,
// and a missing or broken SMTP setup loses nothing — the message sits QUEUED
// and goes out on the next run. WhatsApp delivery has no transport yet, so
// those messages stay queued and are visible in the admin outbox.

export interface QueueArgs {
  entityId: string
  kind: 'weekly_summary' | 'due_reminder' | 'low_balance'
  channel: 'email' | 'whatsapp'
  recipient: string
  subject: string
  body: string
  /** Stable per logical message, e.g. "weekly:<entity>:2026-W32". */
  dedupeKey: string
}

/** Store a message. Returns null when this dedupeKey was already queued. */
export async function queueNotification(args: QueueArgs) {
  const existing = await prisma.notificationOutbox.findUnique({
    where: { dedupeKey: args.dedupeKey },
  })
  if (existing) return null
  return prisma.notificationOutbox.create({ data: args })
}

function smtpConfig() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env
  if (!SMTP_HOST || !SMTP_FROM) return null
  return {
    host: SMTP_HOST,
    port: Number(SMTP_PORT ?? 587),
    secure: Number(SMTP_PORT ?? 587) === 465,
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    from: SMTP_FROM,
  }
}

export function transportConfigured(): boolean {
  return smtpConfig() !== null
}

export interface DeliveryResult {
  sent: number
  failed: number
  stillQueued: number
  reason?: string
}

/**
 * Deliver everything queued. Without SMTP env vars nothing is attempted —
 * that is reported, not swallowed, so the admin screen can say why.
 */
export async function deliverQueued(limit = 50): Promise<DeliveryResult> {
  const pending = await prisma.notificationOutbox.findMany({
    where: { status: 'QUEUED' },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
  if (pending.length === 0) return { sent: 0, failed: 0, stillQueued: 0 }

  const config = smtpConfig()
  if (!config) {
    return {
      sent: 0,
      failed: 0,
      stillQueued: pending.length,
      reason: 'No SMTP transport configured (set SMTP_HOST and SMTP_FROM in .env).',
    }
  }

  const nodemailer = await import('nodemailer')
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  })

  let sent = 0
  let failed = 0
  let stillQueued = 0
  for (const message of pending) {
    if (message.channel !== 'email') {
      stillQueued++ // WhatsApp has no transport yet — keep it visible, not lost
      continue
    }
    try {
      await transporter.sendMail({
        from: config.from,
        to: message.recipient,
        subject: message.subject,
        text: message.body,
      })
      await prisma.notificationOutbox.update({
        where: { id: message.id },
        data: { status: 'SENT', sentAt: new Date(), error: null },
      })
      sent++
    } catch (e) {
      await prisma.notificationOutbox.update({
        where: { id: message.id },
        data: { status: 'FAILED', error: e instanceof Error ? e.message : 'Send failed' },
      })
      failed++
    }
  }
  return {
    sent,
    failed,
    stillQueued,
    ...(stillQueued > 0 ? { reason: 'WhatsApp delivery has no transport yet.' } : {}),
  }
}

/** Admin recipients for an entity's notifications. */
export async function notificationRecipients(): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true, deletedAt: null },
    select: { email: true },
  })
  return admins.map((a) => a.email)
}

import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/db'

// The AI layer's single entry point to Claude (spec §12.8).
//
// Two rules hold everywhere below:
//   1. Nothing here posts to the ledger. Extraction produces rows a human
//      confirms; tagging produces suggestions a human accepts. The model is
//      never the last step before a journal entry.
//   2. Without ANTHROPIC_API_KEY the features degrade with a clear message
//      rather than failing obscurely — same pattern as SMTP in Phase 7.

export const AI_MODEL = 'claude-opus-5'

// Claude Opus 5's safety classifiers can decline a request outright. The
// server-side fallback re-runs the same request on Opus 4.8 in one round
// trip, so an occasional false positive on a bank statement doesn't become
// a dead end for the user.
const FALLBACK_BETA = 'server-side-fallback-2026-06-01'
const FALLBACKS = [{ model: 'claude-opus-4-8' }]

export class AiError extends Error {}

export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY)
}

export const AI_UNCONFIGURED_MESSAGE =
  'AI features need ANTHROPIC_API_KEY in .env — without it, upload a CSV/XLSX export instead of a PDF.'

function client(): Anthropic {
  if (!aiConfigured()) throw new AiError(AI_UNCONFIGURED_MESSAGE)
  return new Anthropic()
}

async function logCall(args: {
  entityId?: string | null
  kind: string
  inputTokens?: number
  outputTokens?: number
  ok: boolean
  error?: string
}) {
  // Usage logging must never take down the operation it is measuring.
  try {
    await prisma.aiCall.create({
      data: {
        entityId: args.entityId ?? null,
        kind: args.kind,
        model: AI_MODEL,
        inputTokens: args.inputTokens ?? 0,
        outputTokens: args.outputTokens ?? 0,
        ok: args.ok,
        error: args.error?.slice(0, 500),
      },
    })
  } catch {
    // ignore
  }
}

/** A PDF (or scanned image) attached to the prompt, before the instruction. */
export interface DocumentInput {
  base64: string
  mediaType: 'application/pdf'
}

export interface StructuredRequest<T> {
  kind: string
  entityId?: string | null
  system: string
  prompt: string
  document?: DocumentInput
  /** JSON Schema the reply must satisfy (objects need additionalProperties:false). */
  schema: Record<string, unknown>
  /** Validates and narrows the parsed reply; throws to reject it. */
  validate: (value: unknown) => T
  maxTokens?: number
  /** Stream for long documents so a slow reply can't hit the request timeout. */
  stream?: boolean
}

function friendlyApiError(e: unknown): AiError {
  // Typed SDK errors, most specific first.
  if (e instanceof Anthropic.RateLimitError) {
    return new AiError('Claude is rate-limited right now — try again shortly.')
  }
  if (e instanceof Anthropic.AuthenticationError) {
    return new AiError('ANTHROPIC_API_KEY is missing or invalid.')
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    return new AiError('This API key cannot use the configured model.')
  }
  if (e instanceof Anthropic.NotFoundError) {
    return new AiError(`Model "${AI_MODEL}" is unavailable for this key.`)
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new AiError('Could not reach Claude — check the network and retry.')
  }
  if (e instanceof Anthropic.APIError) {
    return new AiError(`Claude API error: ${e.message}`)
  }
  return new AiError(e instanceof Error ? e.message : 'Unexpected AI failure')
}

/**
 * One structured call: attach an optional document, constrain the reply to a
 * JSON Schema, validate it, and record the token usage.
 */
export async function runStructured<T>(request: StructuredRequest<T>): Promise<T> {
  const anthropic = client()
  const maxTokens = request.maxTokens ?? 16000

  const content: Anthropic.Beta.BetaContentBlockParam[] = []
  if (request.document) {
    // Document first, instruction after — the documented ordering.
    content.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: request.document.mediaType,
        data: request.document.base64,
      },
    })
  }
  content.push({ type: 'text', text: request.prompt })

  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model: AI_MODEL,
    max_tokens: maxTokens,
    betas: [FALLBACK_BETA],
    fallbacks: FALLBACKS,
    system: request.system,
    output_config: { format: { type: 'json_schema', schema: request.schema } },
    messages: [{ role: 'user', content }],
  }

  let message: Anthropic.Beta.BetaMessage
  try {
    message = request.stream
      ? await anthropic.beta.messages.stream(params).finalMessage()
      : await anthropic.beta.messages.create(params)
  } catch (e) {
    const error = friendlyApiError(e)
    await logCall({ entityId: request.entityId, kind: request.kind, ok: false, error: error.message })
    throw error
  }

  const usage = {
    inputTokens: message.usage.input_tokens ?? 0,
    outputTokens: message.usage.output_tokens ?? 0,
  }

  // Check why generation stopped before trusting the content.
  if (message.stop_reason === 'refusal') {
    await logCall({ ...usage, entityId: request.entityId, kind: request.kind, ok: false, error: 'refusal' })
    throw new AiError(
      'Claude declined this request. If the document is an ordinary bank statement, please report it — otherwise import a CSV export instead.',
    )
  }
  if (message.stop_reason === 'max_tokens') {
    await logCall({ ...usage, entityId: request.entityId, kind: request.kind, ok: false, error: 'max_tokens' })
    throw new AiError(
      'The reply was cut off — the document is too long to read in one pass. Split it (e.g. one month per file) and retry.',
    )
  }

  const text = message.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
  if (!text.trim()) {
    await logCall({ ...usage, entityId: request.entityId, kind: request.kind, ok: false, error: 'empty reply' })
    throw new AiError('Claude returned an empty reply.')
  }

  let parsed: T
  try {
    parsed = request.validate(JSON.parse(text))
  } catch (e) {
    await logCall({
      ...usage, entityId: request.entityId, kind: request.kind, ok: false,
      error: `invalid shape: ${e instanceof Error ? e.message : 'unknown'}`,
    })
    throw new AiError("Claude's reply did not match the expected shape.")
  }

  await logCall({ ...usage, entityId: request.entityId, kind: request.kind, ok: true })
  return parsed
}

/** Rolling AI spend for the admin screen. */
export async function aiUsageSummary(days = 30) {
  const since = new Date(Date.now() - days * 86_400_000)
  const [calls, failures] = await Promise.all([
    prisma.aiCall.groupBy({
      by: ['kind'],
      where: { createdAt: { gte: since } },
      _count: true,
      _sum: { inputTokens: true, outputTokens: true },
    }),
    prisma.aiCall.count({ where: { createdAt: { gte: since }, ok: false } }),
  ])
  return {
    days,
    failures,
    byKind: calls.map((c) => ({
      kind: c.kind,
      calls: c._count,
      inputTokens: c._sum.inputTokens ?? 0,
      outputTokens: c._sum.outputTokens ?? 0,
    })),
  }
}

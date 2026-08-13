// Tax arithmetic (spec §7) — pure, paise-exact, client-safe.
// Rates travel as percent strings ("18", "2.5"); math happens in basis
// points on bigint paise, rounded half-up to the nearest paisa.

export const GST_RATES = ['5', '12', '18', '28'] as const
export const GST_TYPES = ['intra', 'inter'] as const
export const TDS_SECTIONS = ['194C', '194J', '194I', '194H', '192'] as const

/** "18" → 1800 basis points. Throws on junk. */
export function rateBp(rate: string | number): bigint {
  const n = Number(rate)
  if (!Number.isFinite(n) || n <= 0 || n > 50) throw new Error(`Invalid tax rate: ${rate}`)
  return BigInt(Math.round(n * 100))
}

function divRound(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator
}

/** Forward GST: taxable known → tax. (Invoices, bills.) */
export function gstOnNet(netPaise: bigint, bp: bigint): bigint {
  return divRound(netPaise * bp, 10000n)
}

/** Inclusive GST: gross known (a bank row) → { taxable, gst }. */
export function splitGrossGst(grossPaise: bigint, bp: bigint): { taxable: bigint; gst: bigint } {
  const taxable = divRound(grossPaise * 10000n, 10000n + bp)
  return { taxable, gst: grossPaise - taxable }
}

/** Forward TDS: gross known → withheld tax. (Bills, salary.) */
export function tdsOnGross(grossPaise: bigint, bp: bigint): bigint {
  return divRound(grossPaise * bp, 10000n)
}

/** Net-of-TDS: the bank outflow is net → { gross, tds }. (Statement rows.) */
export function grossFromNetTds(netPaise: bigint, bp: bigint): { gross: bigint; tds: bigint } {
  const gross = divRound(netPaise * 10000n, 10000n - bp)
  return { gross, tds: gross - netPaise }
}

/**
 * GST + TDS on one row (professional fees etc.): the bank amount is
 * taxable + GST − TDS, with TDS computed on the TAXABLE value, never on
 * the GST (CBDT circular 23/2017 — GST shown separately is not income).
 *   net = taxable × (1 + gst% − tds%)  →  taxable = net / (1 + gst% − tds%)
 */
export function splitNetGstTds(
  netPaise: bigint,
  gstBp: bigint,
  tdsBp: bigint,
): { taxable: bigint; gst: bigint; tds: bigint } {
  const taxable = divRound(netPaise * 10000n, 10000n + gstBp - tdsBp)
  const tds = divRound(taxable * tdsBp, 10000n)
  // GST takes the rounding remainder so the three parts rebuild the bank
  // amount exactly: taxable + gst − tds = net.
  const gst = netPaise + tds - taxable
  return { taxable, gst, tds }
}

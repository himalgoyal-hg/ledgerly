// Money handling: amounts move through the app as strings ("1234.50") and
// are computed in integer paise (bigint) — no floating point anywhere.

export function parsePaise(value: string | number): bigint {
  const s = String(value).trim()
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
    throw new Error(`Invalid amount: "${s}" (use up to 2 decimals)`)
  }
  const negative = s.startsWith('-')
  const [rupees, frac = ''] = (negative ? s.slice(1) : s).split('.')
  const paise = BigInt(rupees) * 100n + BigInt(frac.padEnd(2, '0'))
  return negative ? -paise : paise
}

export function formatPaise(paise: bigint): string {
  const negative = paise < 0n
  const abs = negative ? -paise : paise
  const rupees = abs / 100n
  const frac = (abs % 100n).toString().padStart(2, '0')
  return `${negative ? '-' : ''}${rupees}.${frac}`
}

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
})

export function displayINR(value: string | number | bigint): string {
  if (typeof value === 'bigint') return inr.format(Number(value) / 100)
  if (typeof value === 'number') return inr.format(value) // display-only path
  return inr.format(Number(parsePaise(value)) / 100)
}

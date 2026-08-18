import 'dotenv/config'
import { syncFromMaster } from '../src/lib/budget/master-sync'

// CLI twin of the "⟳ Sync from master sheet" button on Accounts: fetches
// "New Finance setup HG" live and pushes it through the whole app (plan
// lines, heads, modes, default cost centres, budgets — clearing budgets
// the master zeroes out). Same code path as the button.

async function main() {
  const s = await syncFromMaster()
  console.log(
    `recurring plan lines: ${s.recurring} (ONCE kept: ${s.onceKept})\n` +
      `budgets re-synced for ${s.headsSynced} heads; ${s.budgetsCleared} stale budget rows cleared\n` +
      `default cost centres set on ${s.costCentresSet} heads`,
  )
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

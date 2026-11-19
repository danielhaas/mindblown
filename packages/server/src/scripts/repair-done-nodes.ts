/**
 * Done nodes written before "done is 100 %": done leaves below 100 % and done
 * nodes still carrying a fleet worker's own wait note (services/doneRepair.ts).
 * The API applies this once on startup; this script previews it, or re-runs it.
 *
 *   DATABASE_URL=... tsx packages/server/src/scripts/repair-done-nodes.ts          # dry run: counts per map
 *   DATABASE_URL=... tsx packages/server/src/scripts/repair-done-nodes.ts --apply  # write
 */
import { pool } from '../db/connection.js';
import { repairDoneNodes } from '../services/doneRepair.js';

const apply = process.argv.includes('--apply');
try {
  await repairDoneNodes({ dryRun: !apply });
} finally {
  await pool.end();
}

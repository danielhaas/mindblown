/**
 * Done nodes written before "done is 100 %": done leaves below 100 % and done
 * nodes still carrying a fleet worker's own wait note (services/doneRepair.ts).
 * Never runs on startup. Dry run by default; --apply writes only the maps named
 * with --map (repeatable) and refuses archived maps.
 *
 *   DATABASE_URL=... tsx packages/server/src/scripts/repair-done-nodes.ts                      # dry run: every map
 *   DATABASE_URL=... tsx packages/server/src/scripts/repair-done-nodes.ts --map <id>           # dry run: that map
 *   DATABASE_URL=... tsx packages/server/src/scripts/repair-done-nodes.ts --apply --map <id> [--map <id> …]
 */
import { pool } from '../db/connection.js';
import { repairDoneNodes } from '../services/doneRepair.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const mapIds: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--map') {
    const id = args[++i];
    if (!id || id.startsWith('--')) {
      console.error('--map needs a map id');
      process.exit(2);
    }
    mapIds.push(id);
  }
}
try {
  await repairDoneNodes({ dryRun: !apply, mapIds });
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

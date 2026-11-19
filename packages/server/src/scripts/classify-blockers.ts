/**
 * One-time: classify the free-text blockers already on live maps, the way
 * the hourly run classifies new ones (services/flagBlocker.ts) — a
 * dependency when the text names an open ticket/PR of the same map, else
 * a question to the map owner on the Questions card. Fleet workers' own
 * notes are left alone.
 *
 * The hourly run skips blockers from before `blocked_at` existed (no
 * clock); this script takes them. Dry run first — it lists per map what
 * would happen and writes nothing:
 *
 *   DATABASE_URL=... tsx packages/server/src/scripts/classify-blockers.ts --dry-run
 *   DATABASE_URL=... tsx packages/server/src/scripts/classify-blockers.ts            # apply
 *   ... --map-id <uuid>                                                              # one map
 *
 * Idempotent: a classified blocker has a kind (or is a dependency) and is
 * not picked up again.
 */
import { pool } from '../db/connection.js';
import { classifyUnkindedBlockers } from '../services/flagBlocker.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const i = args.indexOf('--map-id');
  const mapIds = i >= 0 && args[i + 1] ? [args[i + 1]] : undefined;

  const maps = await classifyUnkindedBlockers({ mapIds, dryRun, legacy: true });
  let total = 0;
  for (const m of maps) {
    console.log(`\n${m.mapName} (${m.mapId}) — ${m.items.length} blocker(s)`);
    for (const it of m.items) {
      total++;
      const what = it.plan.kind === 'waits-on' ? `→ depends on "${it.plan.targetText}" (${it.plan.targetNodeId.slice(0, 8)}), blocker cleared` : `→ question to ${it.plan.answerer}`;
      const reason = it.reason.length > 100 ? `${it.reason.slice(0, 99)}…` : it.reason;
      console.log(`  ${it.nodeId.slice(0, 8)} "${it.text}"\n      "${reason}"\n      ${what}${it.error ? `  FAILED: ${it.error}` : ''}`);
    }
  }
  console.log(`\n${total} blocker(s) on ${maps.length} map(s) ${dryRun ? 'would be classified (dry run — nothing written)' : 'classified'}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

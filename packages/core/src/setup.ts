/**
 * Project setup checklist (guided onboarding): what a new project still
 * lacks before its plan can run. One reading for the setup wizard, the
 * "Set up this project" card on the map and the `project_setup_status`
 * tool, derived from the map as it is — nothing here is stored except
 * `setupCompletedAt`, which only says the owner finished or dismissed it.
 *
 * Order is the wizard's: describe → repo → plan → fleet → start. The repo
 * comes before the plan so the plan can build on the repo's open issues.
 */
import type { MindMap, Node } from './types.js';

export type SetupStepId = 'describe' | 'repo' | 'plan' | 'fleet' | 'start';

export interface SetupStep {
  id: SetupStepId;
  label: string;
  done: boolean;
  /** A step the project can do without (no repo yet, people only). */
  optional: boolean;
  /** One line: what is there, or what is missing. */
  detail: string;
}

export interface ProjectSetup {
  /** The owner finished or dismissed setup (`setupCompletedAt` set). */
  completed: boolean;
  steps: SetupStep[];
  /** First step not done yet, or null when every step is done. */
  next: SetupStep | null;
}

type SetupMap = Pick<
  MindMap,
  'description' | 'rootNodeId' | 'fleetId' | 'maxActiveClaims' | 'forgeKind' | 'forgeProblem'
  | 'githubRepoOwner' | 'githubRepoName' | 'setupCompletedAt'
> & { fleetName?: string | null };

export function projectSetup(map: SetupMap, nodes: ReadonlyArray<Pick<Node, 'parentId'>>): ProjectSetup {
  const description = (map.description ?? '').replace(/<[^>]*>/g, '').trim();
  const repoName = map.githubRepoOwner && map.githubRepoName ? `${map.githubRepoOwner}/${map.githubRepoName}` : null;
  const hasRepo = !!map.forgeKind && !map.forgeProblem;
  const topLevel = nodes.filter((n) => n.parentId === map.rootNodeId).length;
  const total = nodes.filter((n) => n.parentId !== null).length;
  const running = !!map.fleetId && map.maxActiveClaims > 0;

  const steps: SetupStep[] = [
    {
      id: 'describe',
      label: 'Describe the project',
      done: description !== '',
      optional: false,
      detail: description !== '' ? 'Description set.' : 'No description yet: what it is, who it is for, what done looks like.',
    },
    {
      id: 'repo',
      label: 'Connect the repository',
      done: hasRepo,
      optional: true,
      detail: map.forgeProblem
        ? `The repository can't be reached: ${map.forgeProblem.message}`
        : hasRepo
          ? `Connected${repoName ? ` to ${repoName}` : ''}.`
          : 'No repository yet. Agents need one to write code.',
    },
    {
      id: 'plan',
      label: 'Lay out the plan',
      done: topLevel > 0,
      optional: false,
      detail: topLevel > 0 ? `${total} node${total === 1 ? '' : 's'} in the plan.` : 'The map has nothing under its root yet.',
    },
    {
      id: 'fleet',
      label: 'Pick who does the work',
      done: !!map.fleetId,
      optional: true,
      detail: map.fleetId
        ? map.fleetName ? `Fleet "${map.fleetName}" connected.` : 'A fleet is connected.'
        : 'No fleet: people do the work. Connect a fleet to let agents take tickets.',
    },
    {
      id: 'start',
      label: 'Start',
      done: !map.fleetId || running,
      optional: !map.fleetId,
      detail: !map.fleetId
        ? 'Nothing to start without a fleet.'
        : running
          ? `Running: up to ${map.maxActiveClaims} ticket${map.maxActiveClaims === 1 ? '' : 's'} at a time.`
          : 'On hold: the fleet takes no ticket until you start.',
    },
  ];

  return {
    completed: !!map.setupCompletedAt,
    steps,
    next: steps.find((s) => !s.done) ?? null,
  };
}

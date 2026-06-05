import type { Node as CoreNode, MindMap, CustomFieldValue, ChildrenScheduling } from '@mindblown/core';

/**
 * Convert a database node row to the core Node type.
 */
export function dbNodeToCore(row: Record<string, unknown>): CoreNode {
  // Drizzle returns camelCase keys matching the schema definition.
  // Support both camelCase (Drizzle) and snake_case (raw SQL) for safety.
  const get = (camel: string, snake: string) => row[camel] ?? row[snake];

  return {
    id: get('id', 'id') as string,
    mapId: (get('mapId', 'map_id') as string),
    parentId: (get('parentId', 'parent_id') as string) ?? null,
    childrenIds: (get('childrenOrder', 'children_order') as string[]) ?? [],
    text: get('text', 'text') as string,
    description: (get('description', 'description') as string) ?? null,
    x: (get('x', 'x') as number) ?? null,
    y: (get('y', 'y') as number) ?? null,
    collapsed: (get('collapsed', 'collapsed') as boolean) ?? false,
    effortEstimate: (get('effortEstimate', 'effort_estimate') as number) ?? null,
    actualEffort: (get('actualEffort', 'actual_effort') as number) ?? null,
    percentComplete: (get('percentComplete', 'percent_complete') as number) ?? null,
    status: (get('status', 'status') as string) ?? null,
    blockedReason: (get('blockedReason', 'blocked_reason') as string) ?? null,
    assigneeIds: (get('assigneeIds', 'assignee_ids') as string[]) ?? [],
    priority: (get('priority', 'priority') as CoreNode['priority']) ?? null,
    dueDate: (get('dueDate', 'due_date') as string) ?? null,
    startDate: (get('startDate', 'start_date') as string) ?? null,
    tags: (get('tags', 'tags') as string[]) ?? [],
    customFields: (get('customFields', 'custom_fields') as Record<string, CustomFieldValue>) ?? {},
    dependencies: (get('dependencies', 'dependencies') as CoreNode['dependencies']) ?? [],
    versionId: (get('versionId', 'version_id') as string) ?? null,
    cycleId: (get('cycleId', 'cycle_id') as string) ?? null,
    externalLinks: (get('externalLinks', 'external_links') as CoreNode['externalLinks']) ?? [],
    autoProgress: ((get('autoProgress', 'auto_progress') as CoreNode['autoProgress']) ?? 'off'),
    priorityRank: (get('priorityRank', 'priority_rank') as number) ?? null,
    childrenScheduling: ((get('childrenScheduling', 'children_scheduling') as ChildrenScheduling) ?? 'parallel'),
    // Orchestration substrate (#111)
    claimedBySession: (get('claimedBySession', 'claimed_by_session') as string) ?? null,
    claimedAt: (get('claimedAt', 'claimed_at') instanceof Date
      ? (get('claimedAt', 'claimed_at') as Date).toISOString()
      : (get('claimedAt', 'claimed_at') as string)) ?? null,
    scopes: (get('scopes', 'scopes') as string[]) ?? [],
    createdAt: (get('createdAt', 'created_at') instanceof Date
      ? (get('createdAt', 'created_at') as Date).toISOString()
      : (get('createdAt', 'created_at') as string)),
    updatedAt: (get('updatedAt', 'updated_at') instanceof Date
      ? (get('updatedAt', 'updated_at') as Date).toISOString()
      : (get('updatedAt', 'updated_at') as string)),
    createdBy: get('createdBy', 'created_by') as string,
    revision: (get('revision', 'revision') as number) ?? 1,
    deletedAt: (get('deletedAt', 'deleted_at') instanceof Date
      ? (get('deletedAt', 'deleted_at') as Date).toISOString()
      : (get('deletedAt', 'deleted_at') as string)) ?? null,
  };
}

/**
 * Convert a database map row to the core MindMap type.
 */
export function dbMapToCore(row: Record<string, unknown>): MindMap {
  const get = (camel: string, snake: string) => row[camel] ?? row[snake];

  return {
    id: get('id', 'id') as string,
    workspaceId: get('workspaceId', 'workspace_id') as string,
    name: get('name', 'name') as string,
    description: (get('description', 'description') as string) ?? null,
    rootNodeId: get('rootNodeId', 'root_node_id') as string,
    effortUnit: (get('effortUnit', 'effort_unit') as MindMap['effortUnit']) ?? 'days',
    statusWorkflow: (get('statusWorkflow', 'status_workflow') as MindMap['statusWorkflow']) ?? [],
    customFieldDefs: (get('customFieldDefs', 'custom_field_defs') as MindMap['customFieldDefs']) ?? [],
    defaultLayout: (get('defaultLayout', 'default_layout') as MindMap['defaultLayout']) ?? 'tree_lr',
    healthThreshold: (get('healthThreshold', 'health_threshold') as number) ?? 0.2,
    baselines: (get('baselines', 'baselines') as MindMap['baselines']) ?? [],
    wipLimit: (get('wipLimit', 'wip_limit') as number) ?? null,
    projectStartDate: (get('projectStartDate', 'project_start_date') as string) ?? null,
    hoursPerDay: (get('hoursPerDay', 'hours_per_day') as number) ?? 8,
    createdAt: (get('createdAt', 'created_at') instanceof Date
      ? (get('createdAt', 'created_at') as Date).toISOString()
      : (get('createdAt', 'created_at') as string)),
    updatedAt: (get('updatedAt', 'updated_at') instanceof Date
      ? (get('updatedAt', 'updated_at') as Date).toISOString()
      : (get('updatedAt', 'updated_at') as string)),
    createdBy: get('createdBy', 'created_by') as string,
    archivedAt: (get('archivedAt', 'archived_at') instanceof Date
      ? (get('archivedAt', 'archived_at') as Date).toISOString()
      : (get('archivedAt', 'archived_at') as string)) ?? null,
    githubInstallationId: (get('githubInstallationId', 'github_installation_id') as string) ?? null,
    githubRepoOwner: (get('githubRepoOwner', 'github_repo_owner') as string) ?? null,
    githubRepoName: (get('githubRepoName', 'github_repo_name') as string) ?? null,
    autoImportNewIssues: (get('autoImportNewIssues', 'auto_import_new_issues') as boolean) ?? false,
    githubInboxNodeId: (get('githubInboxNodeId', 'github_inbox_node_id') as string) ?? null,
  };
}

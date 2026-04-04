import type { Node as CoreNode, MindMap } from '@mindblown/core';

/**
 * Convert a database node row to the core Node type.
 */
export function dbNodeToCore(row: Record<string, unknown>): CoreNode {
  return {
    id: row.id as string,
    mapId: row.map_id as string,
    parentId: (row.parent_id as string) ?? null,
    childrenIds: (row.children_order as string[]) ?? [],
    text: row.text as string,
    description: (row.description as string) ?? null,
    x: (row.x as number) ?? null,
    y: (row.y as number) ?? null,
    collapsed: (row.collapsed as boolean) ?? false,
    effortEstimate: (row.effort_estimate as number) ?? null,
    percentComplete: (row.percent_complete as number) ?? null,
    status: (row.status as string) ?? null,
    assigneeIds: (row.assignee_ids as string[]) ?? [],
    priority: (row.priority as CoreNode['priority']) ?? null,
    dueDate: (row.due_date as string) ?? null,
    startDate: (row.start_date as string) ?? null,
    tags: (row.tags as string[]) ?? [],
    customFields: (row.custom_fields as Record<string, unknown>) ?? {},
    dependencies: (row.dependencies as CoreNode['dependencies']) ?? [],
    isMilestone: (row.is_milestone as boolean) ?? false,
    cycleId: (row.cycle_id as string) ?? null,
    externalLinks: (row.external_links as CoreNode['externalLinks']) ?? [],
    createdAt: row.created_at instanceof Date
      ? (row.created_at as Date).toISOString()
      : (row.created_at as string),
    updatedAt: row.updated_at instanceof Date
      ? (row.updated_at as Date).toISOString()
      : (row.updated_at as string),
    createdBy: row.created_by as string,
  };
}

/**
 * Convert a database map row to the core MindMap type.
 */
export function dbMapToCore(row: Record<string, unknown>): MindMap {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    name: row.name as string,
    description: (row.description as string) ?? null,
    rootNodeId: row.root_node_id as string,
    effortUnit: (row.effort_unit as MindMap['effortUnit']) ?? 'days',
    statusWorkflow: (row.status_workflow as MindMap['statusWorkflow']) ?? [],
    customFieldDefs: (row.custom_field_defs as MindMap['customFieldDefs']) ?? [],
    defaultLayout: (row.default_layout as MindMap['defaultLayout']) ?? 'tree_lr',
    healthThreshold: (row.health_threshold as number) ?? 0.2,
    baselines: (row.baselines as MindMap['baselines']) ?? [],
    createdAt: row.created_at instanceof Date
      ? (row.created_at as Date).toISOString()
      : (row.created_at as string),
    updatedAt: row.updated_at instanceof Date
      ? (row.updated_at as Date).toISOString()
      : (row.updated_at as string),
    createdBy: row.created_by as string,
    archivedAt: row.archived_at instanceof Date
      ? (row.archived_at as Date).toISOString()
      : (row.archived_at as string) ?? null,
  };
}

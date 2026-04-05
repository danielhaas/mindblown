# MindBlown API Reference

Base URL: `http://localhost:3001/api`

All requests and responses use JSON. Protected endpoints require a JWT token in the `Authorization` header:

```
Authorization: Bearer <token>
```

---

## Authentication

### Register

```
POST /api/auth/register
```

Create a new user account.

**Request body:**

```json
{
  "email": "alice@example.com",
  "password": "securepassword",
  "name": "Alice"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | Yes | Email address |
| `password` | string | Yes | Password |
| `name` | string | No | Display name (defaults to email prefix) |

**Response (201):**

```json
{
  "user": {
    "id": "01J5K...",
    "email": "alice@example.com",
    "name": "Alice",
    "avatarUrl": null,
    "createdAt": "2025-08-01T12:00:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 400 | `VALIDATION_ERROR` | Missing email or password |
| 409 | `USER_EXISTS` | Email already registered |

### Login

```
POST /api/auth/login
```

**Request body:**

```json
{
  "email": "alice@example.com",
  "password": "securepassword"
}
```

**Response (200):**

```json
{
  "user": {
    "id": "01J5K...",
    "email": "alice@example.com",
    "name": "Alice",
    "avatarUrl": null,
    "createdAt": "2025-08-01T12:00:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 400 | `VALIDATION_ERROR` | Missing email or password |
| 401 | `INVALID_CREDENTIALS` | Wrong email or password |

### Get Current User

```
GET /api/auth/me
```

Returns the currently authenticated user. Requires a valid JWT.

**Response (200):**

```json
{
  "id": "01J5K...",
  "email": "alice@example.com",
  "name": "Alice",
  "avatarUrl": null,
  "createdAt": "2025-08-01T12:00:00.000Z"
}
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 401 | `UNAUTHORIZED` | No valid token |
| 404 | `USER_NOT_FOUND` | Token valid but user deleted |

---

## Maps

### Create a Map

```
POST /api/maps
```

**Request body:**

```json
{
  "name": "Website Redesign",
  "description": "Q3 redesign project",
  "workspaceId": "ws-001",
  "effortUnit": "days"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Map name |
| `description` | string | No | Description |
| `workspaceId` | string | Yes | Workspace ID |
| `effortUnit` | string | No | `hours`, `days`, or `points` (default: `hours`) |

**Response (201):** The created map object.

### List All Maps

```
GET /api/maps
```

Returns all maps with computed aggregate progress and health for each.

**Response (200):**

```json
[
  {
    "id": "map-001",
    "name": "Website Redesign",
    "workspaceId": "ws-001",
    "effortUnit": "days",
    "computedProgress": 0.23,
    "healthSignal": "on_track",
    "createdAt": "2025-08-01T12:00:00.000Z",
    "updatedAt": "2025-08-15T09:30:00.000Z"
  }
]
```

### Get Map with Nodes

```
GET /api/maps/:id
```

Returns the full map with all nodes and their computed fields (effort, progress, health).

**Response (200):**

```json
{
  "map": {
    "id": "map-001",
    "name": "Website Redesign",
    "workspaceId": "ws-001",
    "rootNodeId": "node-001",
    "effortUnit": "days",
    "statusWorkflow": [
      { "id": "s1", "name": "Todo", "category": "todo", "color": "#e2e8f0", "position": 0 },
      { "id": "s2", "name": "In Progress", "category": "in_progress", "color": "#93c5fd", "position": 1 },
      { "id": "s3", "name": "Done", "category": "done", "color": "#86efac", "position": 2 }
    ],
    "healthThreshold": 0.2,
    "baselines": [],
    "createdAt": "2025-08-01T12:00:00.000Z",
    "updatedAt": "2025-08-15T09:30:00.000Z"
  },
  "nodes": [
    {
      "id": "node-001",
      "mapId": "map-001",
      "parentId": null,
      "childrenIds": ["node-002", "node-003"],
      "text": "Website Redesign",
      "description": null,
      "x": 0,
      "y": 0,
      "collapsed": false,
      "effortEstimate": null,
      "percentComplete": null,
      "status": null,
      "assigneeIds": [],
      "priority": null,
      "dueDate": null,
      "startDate": null,
      "tags": [],
      "customFields": {},
      "dependencies": [],
      "isMilestone": false,
      "cycleId": null,
      "externalLinks": [],
      "createdAt": "2025-08-01T12:00:00.000Z",
      "updatedAt": "2025-08-01T12:00:00.000Z",
      "createdBy": "user-001",
      "computedEffort": 47,
      "computedProgress": 0.23,
      "healthSignal": "on_track"
    }
  ]
}
```

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 403 | `FORBIDDEN` | No view permission |
| 404 | `MAP_NOT_FOUND` | Map does not exist |

### Update Map Settings

```
PUT /api/maps/:id
```

Update map name, description, effort unit, status workflow, custom field definitions, or other settings. Requires edit permission.

**Request body (partial update):**

```json
{
  "name": "Website Redesign v2",
  "effortUnit": "points"
}
```

**Response (200):** The updated map object.

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 403 | `FORBIDDEN` | No edit permission |
| 404 | `MAP_NOT_FOUND` | Map does not exist |

### Delete Map

```
DELETE /api/maps/:id
```

Permanently deletes a map and all its nodes. Requires admin permission.

**Response:** `204 No Content`

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 403 | `FORBIDDEN` | Not an admin |
| 404 | `MAP_NOT_FOUND` | Map does not exist |

### Create Baseline

```
POST /api/maps/:id/baseline
```

Snapshot the current state of all nodes for plan-vs-actual comparison. Requires edit permission.

**Request body:**

```json
{
  "name": "Sprint 3 kickoff"
}
```

**Response (201):** The updated map object including the new baseline in `baselines`.

### Get Schedule and Critical Path

```
GET /api/maps/:id/schedule
```

Returns the computed schedule (start/end dates for each node) and the critical path.

**Response (200):**

```json
{
  "schedule": [
    {
      "nodeId": "node-005",
      "computedStart": 0,
      "computedEnd": 3,
      "duration": 3
    },
    {
      "nodeId": "node-006",
      "computedStart": 3,
      "computedEnd": 8,
      "duration": 5
    }
  ],
  "criticalPath": {
    "path": ["node-005", "node-006", "node-010"],
    "totalDuration": 15,
    "float": {
      "node-005": 0,
      "node-006": 0,
      "node-007": 2,
      "node-010": 0
    }
  }
}
```

---

## Nodes

### Create a Node

```
POST /api/maps/:id/nodes
```

**Request body:**

```json
{
  "parentId": "node-001",
  "text": "Design System",
  "effortEstimate": 4,
  "priority": "P1",
  "status": "Todo",
  "dueDate": "2025-09-15",
  "startDate": "2025-09-01",
  "isMilestone": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `parentId` | string | Yes | Parent node ID |
| `text` | string | Yes | Node title |
| `effortEstimate` | number | No | Effort estimate (leaf nodes) |
| `percentComplete` | number | No | Percent complete (0-100) |
| `status` | string | No | Status (must match map's workflow) |
| `priority` | string | No | `P0`, `P1`, `P2`, or `P3` |
| `startDate` | string | No | ISO 8601 date |
| `dueDate` | string | No | ISO 8601 date |
| `isMilestone` | boolean | No | Mark as milestone |
| `position` | number | No | Insert position among siblings |

**Response (201):** The created node.

Broadcasts `node:created` via WebSocket to all connected clients.

### Update a Node

```
PUT /api/maps/:id/nodes/:nodeId
```

Partial update. Send only the fields you want to change.

**Request body:**

```json
{
  "text": "Design System v2",
  "effortEstimate": 6,
  "percentComplete": 50,
  "tags": ["design", "frontend"],
  "assigneeIds": ["user-002"]
}
```

Updatable fields: `text`, `description`, `x`, `y`, `collapsed`, `effortEstimate`, `percentComplete`, `status`, `assigneeIds`, `priority`, `dueDate`, `startDate`, `tags`, `customFields`, `dependencies`, `isMilestone`, `cycleId`, `externalLinks`.

**Response (200):** The updated node.

Broadcasts `node:updated` via WebSocket.

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 404 | `NODE_NOT_FOUND` | Node does not exist |

### Delete a Node

```
DELETE /api/maps/:id/nodes/:nodeId
```

Deletes the node and all its descendants. Removes the node from its parent's `childrenIds`.

**Response:** `204 No Content`

Broadcasts `node:deleted` with the list of all deleted node IDs.

### Move a Node

```
PUT /api/maps/:id/nodes/:nodeId/move
```

Move a node to a different parent.

**Request body:**

```json
{
  "newParentId": "node-003",
  "position": 0
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `newParentId` | string | Yes | New parent node ID |
| `position` | number | No | Position among new siblings (0-based) |

**Response (200):** The moved node.

Broadcasts `node:moved` via WebSocket.

### Reorder Children

```
PUT /api/maps/:id/nodes/reorder
```

Set the exact order of a parent's children.

**Request body:**

```json
{
  "parentId": "node-001",
  "childrenIds": ["node-003", "node-002", "node-004"]
}
```

**Response (200):**

```json
{ "success": true }
```

Broadcasts `node:reordered` via WebSocket.

---

## Cycles / Sprints

### Create a Cycle

```
POST /api/cycles
```

**Request body:**

```json
{
  "workspaceId": "ws-001",
  "name": "Sprint 14",
  "startDate": "2025-09-01",
  "endDate": "2025-09-14"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `workspaceId` | string | Yes | Workspace ID |
| `name` | string | Yes | Sprint name |
| `startDate` | string | Yes | ISO 8601 date |
| `endDate` | string | Yes | ISO 8601 date |

**Response (201):** The created cycle.

### List Cycles

```
GET /api/cycles?workspaceId=ws-001
```

| Query Param | Type | Required | Description |
|-------------|------|----------|-------------|
| `workspaceId` | string | Yes | Workspace to list cycles for |

**Response (200):**

```json
[
  {
    "id": "cycle-001",
    "workspaceId": "ws-001",
    "name": "Sprint 14",
    "startDate": "2025-09-01",
    "endDate": "2025-09-14",
    "status": "active",
    "createdAt": "2025-08-28T10:00:00.000Z"
  }
]
```

### Get Cycle with Progress

```
GET /api/cycles/:id
```

Returns the cycle, all assigned nodes with computed fields, and aggregate progress.

**Response (200):**

```json
{
  "cycle": {
    "id": "cycle-001",
    "name": "Sprint 14",
    "startDate": "2025-09-01",
    "endDate": "2025-09-14",
    "status": "active"
  },
  "nodes": [
    {
      "id": "node-005",
      "text": "Build login page",
      "computedEffort": 3,
      "computedProgress": 0.66,
      "healthSignal": "on_track"
    }
  ],
  "progress": 42.5,
  "totalNodes": 8,
  "completedNodes": 3
}
```

### Update Cycle

```
PUT /api/cycles/:id
```

**Request body (partial):**

```json
{
  "name": "Sprint 14 (extended)",
  "endDate": "2025-09-21",
  "status": "completed"
}
```

**Response (200):** The updated cycle.

### Delete Cycle

```
DELETE /api/cycles/:id
```

**Response:** `204 No Content`

### Assign Node to Cycle

```
POST /api/cycles/:id/assign
```

**Request body:**

```json
{
  "nodeId": "node-005"
}
```

**Response (200):** The updated node with `cycleId` set.

### Unassign Node from Cycle

```
DELETE /api/cycles/:id/assign/:nodeId
```

**Response (200):** The updated node with `cycleId` set to null.

### Auto-Rollover

```
POST /api/cycles/:id/rollover
```

Move all incomplete nodes (percentComplete < 100) from this cycle to the target cycle.

**Request body:**

```json
{
  "targetCycleId": "cycle-002"
}
```

**Response (200):** Rollover result with counts of moved items.

---

## Comments

### Add Comment

```
POST /api/maps/:mapId/nodes/:nodeId/comments
```

**Request body:**

```json
{
  "text": "This needs more detail on the API contract."
}
```

**Response (201):**

```json
{
  "id": "comment-001",
  "nodeId": "node-005",
  "userId": "user-001",
  "text": "This needs more detail on the API contract.",
  "createdAt": "2025-09-01T14:00:00.000Z",
  "updatedAt": "2025-09-01T14:00:00.000Z"
}
```

Broadcasts `comment:created` via WebSocket.

### List Comments

```
GET /api/maps/:mapId/nodes/:nodeId/comments
```

**Response (200):** Array of comment objects, ordered by creation time.

### Edit Comment

```
PUT /api/comments/:id
```

Only the comment author can edit their comment.

**Request body:**

```json
{
  "text": "Updated: this needs the full OpenAPI spec."
}
```

**Response (200):** The updated comment.

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 403 | `FORBIDDEN` | Not the comment author |
| 404 | `COMMENT_NOT_FOUND` | Comment does not exist |

### Delete Comment

```
DELETE /api/comments/:id
```

Only the comment author can delete their comment.

**Response:** `204 No Content`

---

## Permissions / Sharing

### Share a Map

```
POST /api/maps/:mapId/share
```

Grant access to a user by email. Requires admin permission on the map.

**Request body:**

```json
{
  "email": "bob@example.com",
  "permission": "edit"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | Yes | User's email address |
| `permission` | string | Yes | `view`, `edit`, or `admin` |

**Response (201):** The created permission record.

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| 403 | `FORBIDDEN` | Caller is not an admin |
| 404 | `USER_NOT_FOUND` | No user with that email |

### List Permissions

```
GET /api/maps/:mapId/permissions
```

List all users with access to this map. Requires admin permission.

**Response (200):** Array of permission records.

### Revoke Permission

```
DELETE /api/maps/:mapId/permissions/:userId
```

Remove a user's access to a map. Requires admin permission.

**Response:** `204 No Content`

### Generate Public Link

```
POST /api/maps/:mapId/public-link
```

Generate a token for read-only public access. Requires admin permission.

**Response (201):**

```json
{
  "publicToken": "abc123..."
}
```

---

## GitHub Integration

### Connect GitHub

```
POST /api/integrations/github/connect
```

Store GitHub credentials for a workspace.

**Request body:**

```json
{
  "workspaceId": "ws-001",
  "token": "ghp_xxxxxxxxxxxx",
  "owner": "octocat",
  "repo": "my-project",
  "webhookSecret": "optional-secret"
}
```

**Response (201):**

```json
{
  "id": "integ-001",
  "provider": "github",
  "enabled": true
}
```

### Link Node to Existing Issue

```
POST /api/maps/:mapId/nodes/:nodeId/github/link
```

**Request body:**

```json
{
  "owner": "octocat",
  "repo": "my-project",
  "issueNumber": 42
}
```

**Response (200):** The updated node and the fetched GitHub issue.

### Create GitHub Issue from Node

```
POST /api/maps/:mapId/nodes/:nodeId/github/create
```

Creates a new GitHub Issue with the node's title and description, then links them.

**Response (201):** The updated node and the created GitHub issue.

### Import GitHub Issues

```
POST /api/maps/:mapId/github/import
```

Import all open issues from the connected GitHub repo into the map. Issues are grouped by label into branch nodes.

**Request body:**

```json
{
  "createdBy": "user-001",
  "parentNodeId": "node-001"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `createdBy` | string | Yes | User ID for created nodes |
| `parentNodeId` | string | No | Parent to attach imported nodes under (defaults to map root) |

**Response (201):**

```json
{
  "imported": 15,
  "nodes": [
    { "nodeId": "node-020", "issueNumber": 1 },
    { "nodeId": "node-021", "issueNumber": 2 }
  ]
}
```

### GitHub Webhook

```
POST /api/webhooks/github
```

Receives GitHub webhook events. When an issue linked to a node is closed or updated, the corresponding node is automatically updated. Supports signature verification via `X-Hub-Signature-256`.

### Get GitHub Status for Node

```
GET /api/maps/:mapId/nodes/:nodeId/github/status
```

Fetch current GitHub issue status for all linked issues on a node.

**Response (200):**

```json
{
  "linked": true,
  "issues": [
    {
      "externalId": "octocat/my-project#42",
      "url": "https://github.com/octocat/my-project/issues/42",
      "state": "open",
      "title": "Fix login bug",
      "labels": ["bug", "high-priority"],
      "assignees": ["octocat"],
      "updatedAt": "2025-09-01T10:00:00.000Z"
    }
  ]
}
```

---

## WebSocket

### Connection

```
ws://localhost:3001/ws/maps/:id?token=<jwt>
```

Connect to receive real-time updates for a specific map. The `token` query parameter is optional -- unauthenticated connections are allowed but cannot send cursor presence.

### Server-to-Client Messages

| Type | Payload | Description |
|------|---------|-------------|
| `node:created` | `{ type, node }` | A new node was created |
| `node:updated` | `{ type, nodeId, fields, node }` | A node was updated. `fields` lists which properties changed. |
| `node:deleted` | `{ type, nodeId, deletedIds }` | A node and its descendants were deleted |
| `node:moved` | `{ type, nodeId, newParentId, position }` | A node was moved to a new parent |
| `node:reordered` | `{ type, parentId, childrenIds }` | Children of a parent were reordered |
| `comment:created` | `{ type, nodeId, comment }` | A comment was added to a node |
| `cursor` | `{ type, userId, name, x, y }` | Another user's cursor position |
| `user:join` | `{ type, userId, name }` | A user connected to the map |
| `user:leave` | `{ type, userId }` | A user disconnected from the map |
| `github:imported` | `{ type, count }` | GitHub issues were imported |

### Client-to-Server Messages

| Type | Payload | Description |
|------|---------|-------------|
| `cursor` | `{ type: "cursor", x, y }` | Send your cursor position. Requires authentication. Broadcast to other clients. |

Any other JSON message sent by a client is forwarded to all other clients in the same room.

---

## Computed Fields

When you fetch a map via `GET /api/maps/:id`, each node includes three computed fields that are calculated server-side and never stored in the database:

| Field | Type | Description |
|-------|------|-------------|
| `computedEffort` | number | For leaf nodes, equals `effortEstimate`. For parent nodes, the sum of all descendant effort estimates. |
| `computedProgress` | number | For leaf nodes, equals `percentComplete / 100`. For parents, the weighted average of children's progress, weighted by effort. A 5-day task at 50% counts more than a 1-day task at 50%. Value is 0-1. |
| `healthSignal` | string | `on_track`, `at_risk`, or `behind`. Computed by comparing progress against elapsed time relative to the map's `healthThreshold` (default 0.2 = 20%). Health propagates upward: if any child is `behind`, the parent is at least `at_risk`. |

These fields are recalculated on every read using the `@mindblown/core` computation engine. The same engine runs client-side in the frontend store for instant local updates.

---

## Health Check

```
GET /api/health
```

Public endpoint (no auth required). Returns server status.

**Response (200):**

```json
{
  "status": "ok",
  "timestamp": "2025-09-01T12:00:00.000Z"
}
```

---

## Error Format

All errors follow a consistent shape:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description"
  }
}
```

Common error codes: `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `MAP_NOT_FOUND`, `NODE_NOT_FOUND`, `CYCLE_NOT_FOUND`, `COMMENT_NOT_FOUND`, `USER_NOT_FOUND`, `USER_EXISTS`, `NO_INTEGRATION`.

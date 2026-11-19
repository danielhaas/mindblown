import { useEffect } from 'react';
import { useMindmapStore } from './store.js';

/**
 * Whether the signed-in user may edit the open map. Same rule as the
 * server's getPermission: the creator is admin without a permission row.
 * The server decides in the end; this only hides controls that would 403.
 */
export function useCanEditMap(): boolean {
  const mapId = useMindmapStore((s) => s.currentMapId);
  const map = useMindmapStore((s) => s.currentMap);
  const user = useMindmapStore((s) => s.user);
  const members = useMindmapStore((s) => s.members);
  const membersMapId = useMindmapStore((s) => s.membersMapId);
  const loadMembers = useMindmapStore((s) => s.loadMembers);
  useEffect(() => {
    if (mapId && membersMapId !== mapId) void loadMembers();
  }, [mapId, membersMapId, loadMembers]);
  return (
    !!map &&
    ((user !== null && map.createdBy === user.id) ||
      (membersMapId === map.id && members.some((m) => m.userId === user?.id && (m.permission === 'edit' || m.permission === 'admin'))))
  );
}

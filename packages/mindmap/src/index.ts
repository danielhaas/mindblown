/**
 * @mindblown/mindmap — SVG-based mindmap editor component.
 *
 * This package contains the React mindmap editor that renders
 * nodes as SVG elements with zoom, pan, and keyboard-driven editing.
 */
export const PACKAGE_NAME = '@mindblown/mindmap' as const;

export { App } from './App.js';
export { MindmapEditor } from './MindmapEditor.js';
export { MindmapNode } from './MindmapNode.js';
export { Connector } from './Connector.js';
export { PropertyPanel } from './PropertyPanel.js';
export { useMindmapStore } from './store.js';
export { computeLayout, computeBounds } from './layout.js';
export type { LayoutNode } from './layout.js';
export type { MindmapState } from './store.js';

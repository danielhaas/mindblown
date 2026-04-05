import { useCallback, useRef, useState } from 'react';
import { useMindmapStore } from './store.js';
import type { Node } from '@mindblown/core';

// ── Helpers ──────────────────────────────────────────────────────

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Export: JSON ──────────────────────────────────────────────────

function exportJSON(nodes: Record<string, Node>, mapName: string) {
  const data = {
    format: 'mindblown',
    version: 1,
    exportedAt: new Date().toISOString(),
    mapName,
    nodes: Object.values(nodes),
  };
  downloadFile(JSON.stringify(data, null, 2), `${mapName}.json`, 'application/json');
}

// ── Export: CSV ───────────────────────────────────────────────────

function escapeCSV(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function exportCSV(nodes: Record<string, Node>, mapName: string) {
  const headers = ['title', 'parent', 'status', 'priority', 'effort', 'progress', 'startDate', 'dueDate', 'assignees', 'tags'];
  const rows: string[][] = [headers];

  for (const node of Object.values(nodes)) {
    const parentText = node.parentId && nodes[node.parentId] ? nodes[node.parentId].text : '';
    rows.push([
      escapeCSV(node.text),
      escapeCSV(parentText),
      escapeCSV(node.status ?? ''),
      escapeCSV(node.priority ?? ''),
      String(node.effortEstimate ?? ''),
      String(node.percentComplete ?? ''),
      escapeCSV(node.startDate ?? ''),
      escapeCSV(node.dueDate ?? ''),
      escapeCSV(node.assigneeIds.join('; ')),
      escapeCSV(node.tags.join('; ')),
    ]);
  }

  downloadFile(rows.map((r) => r.join(',')).join('\n'), `${mapName}.csv`, 'text/csv');
}

// ── Export: OPML ─────────────────────────────────────────────────

function buildOPMLOutline(nodeId: string, nodes: Record<string, Node>): string {
  const node = nodes[nodeId];
  if (!node) return '';

  const attrs = `text="${xmlEscape(node.text)}"`;
  if (node.childrenIds.length === 0) {
    return `<outline ${attrs} />`;
  }
  const children = node.childrenIds.map((cid) => buildOPMLOutline(cid, nodes)).join('\n');
  return `<outline ${attrs}>\n${children}\n</outline>`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function exportOPML(nodes: Record<string, Node>, rootNodeId: string, mapName: string) {
  const root = nodes[rootNodeId];
  if (!root) return;

  const body = root.childrenIds.map((cid) => buildOPMLOutline(cid, nodes)).join('\n');

  const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${xmlEscape(mapName)}</title>
    <dateCreated>${new Date().toISOString()}</dateCreated>
  </head>
  <body>
    ${body}
  </body>
</opml>`;

  downloadFile(opml, `${mapName}.opml`, 'text/xml');
}

// ── Export: PNG ───────────────────────────────────────────────────

async function exportPNG(mapName: string): Promise<void> {
  // Find the mindmap SVG in the DOM
  const svgEl = document.querySelector('[data-mindmap-svg]') as SVGSVGElement | null;
  if (!svgEl) {
    // Fallback: try to find any large SVG in the editor area
    const allSvgs = document.querySelectorAll('svg');
    let targetSvg: SVGSVGElement | null = null;
    let maxArea = 0;
    allSvgs.forEach((svg) => {
      const rect = svg.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > maxArea) {
        maxArea = area;
        targetSvg = svg;
      }
    });
    if (!targetSvg) {
      alert('Could not find the mindmap SVG element for export. Switch to Mindmap view first.');
      return;
    }
    await svgToCanvas(targetSvg, mapName);
    return;
  }
  await svgToCanvas(svgEl, mapName);
}

async function svgToCanvas(svgEl: SVGSVGElement, filename: string): Promise<void> {
  const serializer = new XMLSerializer();
  const svgString = serializer.serializeToString(svgEl);
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    const scale = 2; // retina
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(scale, scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, img.width, img.height);
    ctx.drawImage(img, 0, 0);

    canvas.toBlob((blob) => {
      if (blob) {
        downloadBlob(blob, `${filename}.png`);
      }
      URL.revokeObjectURL(url);
    }, 'image/png');
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    alert('Failed to render PNG. The SVG may contain external resources.');
  };
  img.src = url;
}

// ── Import: JSON ─────────────────────────────────────────────────

function parseJSONImport(
  text: string,
): { mapName: string; nodes: Node[] } | null {
  try {
    const data = JSON.parse(text);
    if (data.format === 'mindblown' && Array.isArray(data.nodes)) {
      return { mapName: data.mapName ?? 'Imported Map', nodes: data.nodes };
    }
    // Try to parse as plain node array
    if (Array.isArray(data) && data[0]?.id && data[0]?.text) {
      return { mapName: 'Imported Map', nodes: data };
    }
    alert('Unrecognized JSON format. Expected MindBlown export format.');
    return null;
  } catch {
    alert('Invalid JSON file.');
    return null;
  }
}

// ── Import: CSV ──────────────────────────────────────────────────

function parseCSVImport(text: string): { title: string; parent: string }[] | null {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) {
    alert('CSV must have a header row and at least one data row.');
    return null;
  }

  const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase().trim());
  const titleIdx = headers.indexOf('title');
  const parentIdx = headers.indexOf('parent');

  if (titleIdx < 0) {
    alert('CSV must have a "title" column.');
    return null;
  }

  const rows: { title: string; parent: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const title = cols[titleIdx]?.trim();
    if (!title) continue;
    rows.push({
      title,
      parent: parentIdx >= 0 ? (cols[parentIdx]?.trim() ?? '') : '',
    });
  }
  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

// ── Import: OPML ─────────────────────────────────────────────────

interface OPMLNode {
  text: string;
  children: OPMLNode[];
}

function parseOPML(text: string): OPMLNode[] | null {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    const errorNode = doc.querySelector('parsererror');
    if (errorNode) {
      alert('Invalid OPML file.');
      return null;
    }

    const body = doc.querySelector('body');
    if (!body) {
      alert('OPML has no <body> element.');
      return null;
    }

    function parseOutline(el: Element): OPMLNode {
      const textAttr = el.getAttribute('text') ?? el.getAttribute('title') ?? 'Untitled';
      const children: OPMLNode[] = [];
      for (const child of Array.from(el.children)) {
        if (child.tagName.toLowerCase() === 'outline') {
          children.push(parseOutline(child));
        }
      }
      return { text: textAttr, children };
    }

    const roots: OPMLNode[] = [];
    for (const child of Array.from(body.children)) {
      if (child.tagName.toLowerCase() === 'outline') {
        roots.push(parseOutline(child));
      }
    }
    return roots;
  } catch {
    alert('Failed to parse OPML file.');
    return null;
  }
}

// ── Modal Component ──────────────────────────────────────────────

export function ImportExport({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nodes = useMindmapStore((s) => s.nodes);
  const rootNodeId = useMindmapStore((s) => s.rootNodeId);
  const currentMap = useMindmapStore((s) => s.currentMap);
  const addNode = useMindmapStore((s) => s.addNode);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'export' | 'import'>('export');
  const [dragOver, setDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);

  const mapName = currentMap?.name ?? 'MindBlown';

  // ── Export handlers ─────────────────────────────────────────

  const handleExportJSON = useCallback(() => {
    exportJSON(nodes, mapName);
  }, [nodes, mapName]);

  const handleExportCSV = useCallback(() => {
    exportCSV(nodes, mapName);
  }, [nodes, mapName]);

  const handleExportOPML = useCallback(() => {
    if (!rootNodeId) return;
    exportOPML(nodes, rootNodeId, mapName);
  }, [nodes, rootNodeId, mapName]);

  const handleExportPNG = useCallback(() => {
    exportPNG(mapName);
  }, [mapName]);

  // ── Import handlers ─────────────────────────────────────────

  const processFile = useCallback(
    async (file: File) => {
      setImporting(true);
      setImportStatus(null);
      const text = await file.text();
      const ext = file.name.split('.').pop()?.toLowerCase();

      try {
        if (ext === 'json') {
          const result = parseJSONImport(text);
          if (!result) { setImporting(false); return; }

          // Build the nodes as children of root
          if (rootNodeId) {
            let count = 0;
            for (const n of result.nodes) {
              if (!n.parentId) continue; // skip root of imported data
              // Add as children of current root
              addNode(rootNodeId, n.text);
              count++;
            }
            setImportStatus(`Imported ${count} nodes from JSON.`);
          }
        } else if (ext === 'csv') {
          const rows = parseCSVImport(text);
          if (!rows) { setImporting(false); return; }

          if (!rootNodeId) { setImporting(false); return; }

          // Build tree from parent references
          const nodeMap = new Map<string, string>(); // title -> nodeId
          // Root node
          nodeMap.set(nodes[rootNodeId]?.text ?? '', rootNodeId);

          let count = 0;
          for (const row of rows) {
            const parentId = row.parent ? (nodeMap.get(row.parent) ?? rootNodeId) : rootNodeId;
            const newId = addNode(parentId, row.title);
            nodeMap.set(row.title, newId);
            count++;
          }
          setImportStatus(`Imported ${count} nodes from CSV.`);
        } else if (ext === 'opml') {
          const outlines = parseOPML(text);
          if (!outlines) { setImporting(false); return; }

          if (!rootNodeId) { setImporting(false); return; }

          let count = 0;
          function addOutline(outline: OPMLNode, parentId: string) {
            const newId = addNode(parentId, outline.text);
            count++;
            for (const child of outline.children) {
              addOutline(child, newId);
            }
          }

          for (const outline of outlines) {
            addOutline(outline, rootNodeId);
          }
          setImportStatus(`Imported ${count} nodes from OPML.`);
        } else {
          alert(`Unsupported file type: .${ext}. Supported: .json, .csv, .opml`);
        }
      } catch (e: any) {
        setImportStatus(`Import error: ${e.message}`);
      }
      setImporting(false);
    },
    [rootNodeId, nodes, addNode],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
      // Reset the input
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [processFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 520,
          maxWidth: '90vw',
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px 12px',
            borderBottom: '1px solid #f1f5f9',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1e293b' }}>
            Import / Export
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: 18,
              color: '#94a3b8',
              cursor: 'pointer',
              padding: '0 4px',
              fontFamily: 'inherit',
            }}
          >
            x
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #f1f5f9' }}>
          {(['export', 'import'] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setImportStatus(null); }}
              style={{
                flex: 1,
                padding: '10px 0',
                background: 'none',
                border: 'none',
                borderBottom: tab === t ? '2px solid #4f46e5' : '2px solid transparent',
                fontSize: 13,
                fontWeight: tab === t ? 700 : 500,
                color: tab === t ? '#4f46e5' : '#64748b',
                cursor: 'pointer',
                fontFamily: 'inherit',
                textTransform: 'capitalize',
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ padding: 20 }}>
          {tab === 'export' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ margin: '0 0 8px', fontSize: 12, color: '#94a3b8' }}>
                Export your map data in various formats.
              </p>

              <ExportButton
                label="JSON"
                description="Full map data (MindBlown format)"
                ext=".json"
                onClick={handleExportJSON}
              />
              <ExportButton
                label="CSV"
                description="Flat table with all task properties"
                ext=".csv"
                onClick={handleExportCSV}
              />
              <ExportButton
                label="OPML"
                description="Outline format (compatible with many tools)"
                ext=".opml"
                onClick={handleExportOPML}
              />
              <ExportButton
                label="PNG"
                description="Screenshot of the current mindmap view"
                ext=".png"
                onClick={handleExportPNG}
              />
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: 0, fontSize: 12, color: '#94a3b8' }}>
                Import nodes from JSON (MindBlown format), CSV (with title and parent columns), or OPML.
              </p>

              {/* Drag-and-drop area */}
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                style={{
                  border: `2px dashed ${dragOver ? '#4f46e5' : '#e2e8f0'}`,
                  borderRadius: 8,
                  padding: 32,
                  textAlign: 'center',
                  background: dragOver ? '#eef2ff' : '#f8fafc',
                  transition: 'all 0.15s',
                  cursor: 'pointer',
                }}
                onClick={() => fileInputRef.current?.click()}
              >
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  style={{ margin: '0 auto 8px' }}
                >
                  <path
                    d="M12 16V4m0 0l-4 4m4-4l4 4"
                    stroke={dragOver ? '#4f46e5' : '#94a3b8'}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M20 16v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2"
                    stroke={dragOver ? '#4f46e5' : '#94a3b8'}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: dragOver ? '#4f46e5' : '#475569' }}>
                  {dragOver ? 'Drop file here' : 'Drag and drop a file here'}
                </p>
                <p style={{ margin: '4px 0 0', fontSize: 11, color: '#94a3b8' }}>
                  or click to browse. Supported: .json, .csv, .opml
                </p>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.csv,.opml"
                style={{ display: 'none' }}
                onChange={handleFileSelect}
              />

              {importing && (
                <div style={{ fontSize: 12, color: '#4f46e5', fontWeight: 500 }}>
                  Importing...
                </div>
              )}

              {importStatus && (
                <div
                  style={{
                    padding: '8px 12px',
                    borderRadius: 6,
                    background: importStatus.startsWith('Import error') ? '#fef2f2' : '#dcfce7',
                    color: importStatus.startsWith('Import error') ? '#991b1b' : '#166534',
                    fontSize: 12,
                    fontWeight: 500,
                  }}
                >
                  {importStatus}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Export button row ─────────────────────────────────────────────

function ExportButton({
  label,
  description,
  ext,
  onClick,
}: {
  label: string;
  description: string;
  ext: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        background: '#f8fafc',
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'all 0.15s',
      }}
      onMouseOver={(e) => {
        e.currentTarget.style.background = '#eef2ff';
        e.currentTarget.style.borderColor = '#c7d2fe';
      }}
      onMouseOut={(e) => {
        e.currentTarget.style.background = '#f8fafc';
        e.currentTarget.style.borderColor = '#e2e8f0';
      }}
    >
      <div style={{ textAlign: 'left' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{label}</div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{description}</div>
      </div>
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          padding: '3px 8px',
          borderRadius: 4,
          background: '#eef2ff',
          color: '#4f46e5',
        }}
      >
        {ext}
      </span>
    </button>
  );
}

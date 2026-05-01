import { useState, useCallback, useRef, useEffect } from 'react';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { ChatSSEEvent, AiConfigResponse } from './api.js';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; result?: unknown }>;
}

interface Props {
  mapId: string;
  onClose: () => void;
}

export function AIChatPanel({ mapId, onClose }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState<AiConfigResponse | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadMap = useMindmapStore((s) => s.loadMap);
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);
  const nodes = useMindmapStore((s) => s.nodes);
  const focusedNodeText = selectedNodeId ? nodes[selectedNodeId]?.text : null;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(scrollToBottom, [messages]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    api.aiConfig().then(setConfig).catch(() => setConfig(null));
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = { role: 'user', content: text };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput('');
    setLoading(true);

    // Build the message history for the API (only role + content)
    const apiMessages = updatedMessages.map((m) => ({ role: m.role, content: m.content }));

    try {
      let assistantContent = '';
      const toolCalls: ChatMessage['toolCalls'] = [];
      let needsRefresh = false;

      for await (const event of api.aiChat(mapId, apiMessages, { selectedNodeId })) {
        switch (event.type) {
          case 'delta':
            assistantContent += event.content ?? '';
            // Update the assistant message in real-time
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant') {
                return [...prev.slice(0, -1), { ...last, content: assistantContent, toolCalls: [...toolCalls] }];
              }
              return [...prev, { role: 'assistant', content: assistantContent, toolCalls: [...toolCalls] }];
            });
            break;

          case 'tool_call':
            toolCalls.push({ name: event.name!, args: event.args ?? {} });
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant') {
                return [...prev.slice(0, -1), { ...last, content: assistantContent, toolCalls: [...toolCalls] }];
              }
              return [...prev, { role: 'assistant', content: assistantContent, toolCalls: [...toolCalls] }];
            });
            break;

          case 'tool_result': {
            // Update the tool call with its result
            const tc = toolCalls.find((t) => t.name === event.name && !t.result);
            if (tc) tc.result = event.result;
            // Mark that we need a map refresh if a mutating tool was called
            if (event.name !== 'get_map' && event.name !== 'search_nodes') {
              needsRefresh = true;
            }
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant') {
                return [...prev.slice(0, -1), { ...last, content: assistantContent, toolCalls: [...toolCalls] }];
              }
              return [...prev, { role: 'assistant', content: assistantContent, toolCalls: [...toolCalls] }];
            });
            break;
          }

          case 'error':
            assistantContent += `\n\nError: ${event.message}`;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant') {
                return [...prev.slice(0, -1), { ...last, content: assistantContent }];
              }
              return [...prev, { role: 'assistant', content: assistantContent }];
            });
            break;
        }
      }

      // Ensure the final assistant message is saved
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant') {
          return [...prev.slice(0, -1), { ...last, content: assistantContent, toolCalls: [...toolCalls] }];
        }
        if (assistantContent || toolCalls.length > 0) {
          return [...prev, { role: 'assistant', content: assistantContent, toolCalls: [...toolCalls] }];
        }
        return prev;
      });

      // Refresh the map if any mutating tools were called
      if (needsRefresh) {
        await loadMap(mapId);
      }
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${err.message}` },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, messages, loading, mapId, loadMap]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>AI Chat</span>
        {config?.active && (
          <span
            title={`Provider: ${config.active.name}${
              config.preferenceHonored ? '' : ' (fallback — preferred backend not configured)'
            }`}
            style={modelBadgeStyle}
          >
            {config.active.model}
          </span>
        )}
        <button onClick={onClose} style={closeBtnStyle}>&times;</button>
      </div>

      {/* Focus row — surfaces what "this" refers to in the conversation */}
      {focusedNodeText && (
        <div style={focusRowStyle} title="Tools and 'this'/'here' resolve to the selected node">
          <span style={{ color: '#94a3b8' }}>Focus:</span>{' '}
          <span style={{ color: '#1e293b', fontWeight: 500 }}>{focusedNodeText}</span>
        </div>
      )}

      {/* Messages */}
      <div style={messagesStyle}>
        {messages.length === 0 && (
          <div style={emptyStyle}>
            Ask me to modify your mindmap. For example:
            <ul style={{ marginTop: 8, paddingLeft: 18, fontSize: 12, lineHeight: 1.8 }}>
              <li>"Add a Testing node under Backend"</li>
              <li>"Move Launch under Frontend"</li>
              <li>"Set the priority of API Endpoints to P0"</li>
              <li>"What's the total estimated effort?"</li>
            </ul>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={{ marginBottom: 12 }}>
            <div style={msg.role === 'user' ? userBubbleStyle : assistantBubbleStyle}>
              {msg.content || (msg.toolCalls?.length ? '' : '...')}
            </div>
            {msg.toolCalls?.map((tc, j) => (
              <div key={j} style={toolCallStyle}>
                <span style={{ fontWeight: 500 }}>{formatToolName(tc.name)}</span>
                {tc.args && Object.keys(tc.args).length > 0 && (
                  <span style={{ color: '#64748b' }}>
                    {' '}({formatToolArgs(tc)})
                  </span>
                )}
                {tc.result != null && (
                  <div style={{ fontSize: 11, color: '#16a34a', marginTop: 2 }}>
                    {formatToolResult(tc.name, tc.result)}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        {loading && messages[messages.length - 1]?.role === 'user' && (
          <div style={{ ...assistantBubbleStyle, opacity: 0.5 }}>Thinking...</div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={inputBarStyle}>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask the AI..."
          disabled={loading}
          style={inputFieldStyle}
        />
        <button
          onClick={sendMessage}
          disabled={loading || !input.trim()}
          style={{
            ...sendBtnStyle,
            opacity: loading || !input.trim() ? 0.4 : 1,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

// ── Formatters ─────────────────────────────────────────────────

function formatToolName(name: string): string {
  return name.replace(/_/g, ' ');
}

function formatToolArgs(tc: { name: string; args: Record<string, unknown> }): string {
  const skip = new Set(['mapId']);
  const parts = Object.entries(tc.args)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return parts.join(', ');
}

function formatToolResult(name: string, result: unknown): string {
  // Shared tool layer returns plain-text strings. Truncate long payloads
  // (e.g. get_map) so the chat card stays compact; full text still flows
  // back to the model in the tool_call message history.
  if (typeof result === 'string') {
    if (name === 'get_map') return 'Loaded map structure';
    const firstLine = result.split('\n')[0] ?? result;
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  }
  if (!result || typeof result !== 'object') return String(result);
  const r = result as Record<string, unknown>;
  if (r.error) return `Error: ${r.error}`;
  return JSON.stringify(result).slice(0, 100);
}

// ── Styles ──────────────────────────────────────────────────────

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  right: 0,
  top: 0,
  bottom: 0,
  width: 380,
  background: '#fff',
  borderLeft: '1px solid #e2e8f0',
  display: 'flex',
  flexDirection: 'column',
  zIndex: 1500,
  boxShadow: '-4px 0 16px rgba(0,0,0,0.08)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '12px 16px',
  borderBottom: '1px solid #e2e8f0',
  background: '#f8fafc',
};

const focusRowStyle: React.CSSProperties = {
  padding: '6px 16px',
  borderBottom: '1px solid #e2e8f0',
  background: '#fef9c3',
  fontSize: 12,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const modelBadgeStyle: React.CSSProperties = {
  flex: 1,
  textAlign: 'right',
  marginRight: 8,
  fontSize: 11,
  color: '#64748b',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const closeBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  fontSize: 20,
  color: '#94a3b8',
  cursor: 'pointer',
  padding: '0 4px',
  lineHeight: 1,
};

const messagesStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '12px 16px',
};

const emptyStyle: React.CSSProperties = {
  color: '#94a3b8',
  fontSize: 13,
  lineHeight: 1.6,
  padding: '20px 0',
};

const userBubbleStyle: React.CSSProperties = {
  background: '#3b82f6',
  color: '#fff',
  padding: '8px 12px',
  borderRadius: '12px 12px 4px 12px',
  fontSize: 13,
  lineHeight: 1.5,
  maxWidth: '85%',
  marginLeft: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const assistantBubbleStyle: React.CSSProperties = {
  background: '#f1f5f9',
  color: '#1e293b',
  padding: '8px 12px',
  borderRadius: '12px 12px 12px 4px',
  fontSize: 13,
  lineHeight: 1.5,
  maxWidth: '85%',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const toolCallStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#475569',
  background: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  padding: '4px 8px',
  margin: '4px 0',
  maxWidth: '85%',
};

const inputBarStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: '12px 16px',
  borderTop: '1px solid #e2e8f0',
  background: '#f8fafc',
};

const inputFieldStyle: React.CSSProperties = {
  flex: 1,
  padding: '8px 12px',
  border: '1px solid #cbd5e1',
  borderRadius: 8,
  fontSize: 13,
  outline: 'none',
};

const sendBtnStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: '#3b82f6',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};

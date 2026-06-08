import { useState, useCallback, useRef, useEffect } from 'react';
import { useMindmapStore } from './store.js';
import * as api from './api.js';
import type { ChatSSEEvent, AiConfigResponse } from './api.js';

// Web Speech API isn't part of lib.dom.d.ts (still experimental). Minimal
// types for the bits we use — covers the shape Chrome/Safari expose.
interface SpeechRecognitionAlternative {
  transcript: string;
}
interface SpeechRecognitionResult {
  isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
}
interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

type ToolCallState = 'running' | 'done' | 'error';

interface ChatToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  state?: ToolCallState;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ChatToolCall[];
  /** Non-bubble status notice (rendered as a banner under the message). */
  statusBanner?: {
    kind: 'error' | 'info';
    text: string;
    /** Optional inline action — when present, renders a button next to the
     * banner text. Click sends `payload` as the next user message. Used
     * today for "Continue" on step-limit banners; generic so other banners
     * can adopt the pattern (e.g. "Retry" on errors) without a type bump. */
    action?: { label: string; payload: string };
  };
}

interface Props {
  mapId: string;
  onClose: () => void;
  onMinimise?: () => void;
}

// Persisted-message key per map. Survives Map Chat toggling AI Chat off,
// closing+reopening the panel, and full-page reloads. Restricted to messages
// (not loading/input/listening — those are session-local UI state).
const STORAGE_KEY_PREFIX = 'mindblown:aichat:';

function loadStoredMessages(mapId: string): ChatMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(`${STORAGE_KEY_PREFIX}${mapId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Drop any tool calls still marked "running" — they can't actually be
    // resumed across mount, and a stale spinner would be misleading.
    return parsed.map((m: ChatMessage) => {
      if (m.role !== 'assistant' || !m.toolCalls?.length) return m;
      const toolCalls = m.toolCalls.map((tc) =>
        tc.state === 'running' ? { ...tc, state: 'error' as const } : tc,
      );
      return { ...m, toolCalls };
    });
  } catch {
    return [];
  }
}

function storeMessages(mapId: string, messages: ChatMessage[]): void {
  if (typeof window === 'undefined') return;
  try {
    if (messages.length === 0) {
      window.localStorage.removeItem(`${STORAGE_KEY_PREFIX}${mapId}`);
    } else {
      window.localStorage.setItem(
        `${STORAGE_KEY_PREFIX}${mapId}`,
        JSON.stringify(messages),
      );
    }
  } catch {
    // Quota exceeded or storage disabled — silently drop. The in-memory state
    // is still authoritative for this session.
  }
}

export function AIChatPanel({ mapId, onClose, onMinimise }: Props) {
  // Initialize from storage so toggling Map Chat / × / reload doesn't wipe
  // the conversation. Lazy initializer runs once per mount.
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    loadStoredMessages(mapId),
  );
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState<AiConfigResponse | null>(null);
  const [listening, setListening] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  // Lets the user cancel an in-flight request via the Stop button. We hold a
  // ref rather than state so the Stop click reads the current controller
  // without dragging it through React's render loop.
  const abortRef = useRef<AbortController | null>(null);

  // Persist on every change. localStorage writes are cheap for small payloads
  // and the chat history is bounded by what a human will type/read in a session.
  useEffect(() => {
    storeMessages(mapId, messages);
  }, [mapId, messages]);

  // If the user switches to a different map while the panel stays mounted,
  // hydrate that map's stored conversation. Without this, the panel would
  // keep showing the prior map's messages until manually cleared.
  const lastMapIdRef = useRef(mapId);
  useEffect(() => {
    if (lastMapIdRef.current === mapId) return;
    lastMapIdRef.current = mapId;
    setMessages(loadStoredMessages(mapId));
  }, [mapId]);

  // Abort any in-flight chat when the panel unmounts — otherwise the fetch
  // keeps running in the background and we leak it.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const clearMessages = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
  }, []);
  // Snapshot of the input when listening starts. Each onresult event rebuilds
  // input = base + final + interim, so the user can still see what they had
  // typed before they hit the mic.
  const baseInputRef = useRef<string>('');
  // Final (non-interim) transcript collected during this listen. onend reads
  // this to decide whether to auto-submit.
  const finalTranscriptRef = useRef<string>('');
  const loadMap = useMindmapStore((s) => s.loadMap);
  const selectedNodeId = useMindmapStore((s) => s.selectedNodeId);
  const nodes = useMindmapStore((s) => s.nodes);
  const focusedNodeText = selectedNodeId ? nodes[selectedNodeId]?.text : null;

  const speechSupported =
    typeof window !== 'undefined' &&
    Boolean(
      (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition ??
        (window as unknown as { webkitSpeechRecognition?: unknown })
          .webkitSpeechRecognition,
    );

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(scrollToBottom, [messages]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    api.aiConfig().then(setConfig).catch(() => setConfig(null));
  }, []);

  // Stop recognition if the panel unmounts mid-listen.
  useEffect(() => {
    return () => {
      try { recognitionRef.current?.stop(); } catch { /* already stopped */ }
    };
  }, []);

  const toggleMic = useCallback(() => {
    if (listening) {
      try { recognitionRef.current?.stop(); } catch { /* noop */ }
      return;
    }
    const Ctor =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognition })
        .SpeechRecognition ??
      (window as unknown as {
        webkitSpeechRecognition?: new () => SpeechRecognition;
      }).webkitSpeechRecognition;
    if (!Ctor) return;

    const rec = new Ctor();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';

    baseInputRef.current = input;
    finalTranscriptRef.current = '';

    rec.onresult = (event: SpeechRecognitionEvent) => {
      let finalText = '';
      let interimText = '';
      for (let i = 0; i < event.results.length; i++) {
        const transcript = event.results[i][0]?.transcript ?? '';
        if (event.results[i].isFinal) finalText += transcript;
        else interimText += transcript;
      }
      finalTranscriptRef.current = finalText;
      const sep = baseInputRef.current && (finalText || interimText) ? ' ' : '';
      setInput(baseInputRef.current + sep + finalText + interimText);
    };

    rec.onend = () => {
      setListening(false);
      recognitionRef.current = null;
      const finalText = finalTranscriptRef.current.trim();
      if (finalText) {
        // Auto-submit the dictated text. Compose with whatever the user had
        // typed before hitting the mic so we never lose pre-existing input.
        const sep = baseInputRef.current ? ' ' : '';
        const composed = (baseInputRef.current + sep + finalText).trim();
        sendMessageRef.current(composed);
      } else {
        // Nothing transcribed — just refocus so the user can type/retry.
        inputRef.current?.focus();
      }
    };

    rec.onerror = () => {
      setListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  }, [listening, input]);

  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = { role: 'user', content: text };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput('');
    setLoading(true);

    // Include toolCalls + results so the model sees what it actually did
    // on prior turns — otherwise it second-guesses its own narration prose.
    const apiMessages = updatedMessages.map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls,
    }));

    const controller = new AbortController();
    abortRef.current = controller;

    // Commits the in-flight assistant message into state. Called after every
    // event so the UI reflects partial progress (deltas, tool start/finish).
    let assistantContent = '';
    const toolCalls: ChatToolCall[] = [];
    let banner: ChatMessage['statusBanner'] = undefined;
    const flush = () => {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        const draft: ChatMessage = {
          role: 'assistant',
          content: assistantContent,
          toolCalls: toolCalls.map((tc) => ({ ...tc })),
          statusBanner: banner,
        };
        if (last?.role === 'assistant') return [...prev.slice(0, -1), draft];
        if (assistantContent || toolCalls.length > 0 || banner) return [...prev, draft];
        return prev;
      });
    };

    try {
      let needsRefresh = false;

      for await (const event of api.aiChat(mapId, apiMessages, {
        selectedNodeId,
        signal: controller.signal,
      })) {
        switch (event.type) {
          case 'delta':
            assistantContent += event.content ?? '';
            flush();
            break;

          case 'tool_call':
            toolCalls.push({
              id: event.id ?? '',
              name: event.name!,
              args: event.args ?? {},
              state: 'running',
            });
            flush();
            break;

          case 'tool_result': {
            const tc = toolCalls.find((t) =>
              event.id ? t.id === event.id : t.name === event.name && t.state === 'running',
            );
            if (tc) {
              tc.result = event.result;
              tc.state =
                typeof event.result === 'string' && event.result.startsWith('Error:')
                  ? 'error'
                  : 'done';
            }
            if (event.name !== 'get_map' && event.name !== 'search_nodes') {
              needsRefresh = true;
            }
            flush();
            break;
          }

          case 'step_limit':
            banner = {
              kind: 'info',
              text: `Stopped after ${event.maxSteps ?? 6} tool steps.`,
              action: { label: 'Continue', payload: 'continue' },
            };
            flush();
            break;

          case 'error':
            banner = {
              kind: 'error',
              text: event.message ?? 'The AI hit an error.',
            };
            // Any tool still marked "running" never reported back — mark it
            // failed so the user doesn't think it's still doing something.
            for (const tc of toolCalls) {
              if (tc.state === 'running') tc.state = 'error';
            }
            flush();
            break;
        }
      }

      flush();

      if (needsRefresh) {
        await loadMap(mapId);
      }
    } catch (err: any) {
      if (controller.signal.aborted) {
        banner = { kind: 'info', text: 'Stopped.' };
      } else {
        const code = (err as { code?: string }).code;
        banner = {
          kind: 'error',
          text:
            code === 'AI_DISCONNECTED'
              ? 'Connection to the AI was lost. Try again.'
              : err?.message
                ? `Error: ${err.message}`
                : 'Something went wrong.',
        };
      }
      for (const tc of toolCalls) {
        if (tc.state === 'running') tc.state = 'error';
      }
      flush();
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setLoading(false);
    }
  }, [input, messages, loading, mapId, loadMap, selectedNodeId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Latest-sendMessage ref — rec.onend captures toggleMic's closure, which
  // would otherwise see a stale sendMessage and submit with stale state.
  const sendMessageRef = useRef(sendMessage);
  useEffect(() => {
    sendMessageRef.current = sendMessage;
  }, [sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div style={panelStyle}>
      <style>{`@keyframes mindblown-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
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
        {messages.length > 0 && (
          <button
            onClick={clearMessages}
            title="Clear this conversation"
            aria-label="Clear conversation"
            style={clearBtnStyle}
            disabled={loading}
          >
            Clear
          </button>
        )}
        {onMinimise && (
          <button
            onClick={onMinimise}
            style={minimiseBtnStyle}
            title="Minimise"
            aria-label="Minimise"
          >
            −
          </button>
        )}
        <button onClick={onClose} style={closeBtnStyle} title="Close (your chat is saved)">&times;</button>
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
                <span style={{ ...toolBadgeStyle, ...toolBadgeVariant(tc.state) }}>
                  {toolBadgeLabel(tc.state)}
                </span>
                <span style={{ fontWeight: 500 }}>{formatToolName(tc.name)}</span>
                {tc.args && Object.keys(tc.args).length > 0 && (
                  <span style={{ color: '#64748b' }}>
                    {' '}({formatToolArgs(tc)})
                  </span>
                )}
                {tc.result != null && (
                  <div
                    style={{
                      fontSize: 11,
                      color: tc.state === 'error' ? '#dc2626' : '#16a34a',
                      marginTop: 2,
                    }}
                  >
                    {formatToolResult(tc.name, tc.result)}
                  </div>
                )}
              </div>
            ))}
            {msg.statusBanner && (
              <div
                style={
                  msg.statusBanner.kind === 'error' ? errorBannerStyle : infoBannerStyle
                }
              >
                <span>{msg.statusBanner.text}</span>
                {msg.statusBanner.action && (
                  <button
                    onClick={() => sendMessage(msg.statusBanner!.action!.payload)}
                    disabled={loading}
                    style={bannerActionBtnStyle}
                  >
                    {msg.statusBanner.action.label}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div style={workingIndicatorStyle} aria-live="polite">
            <span style={dotPulseStyle} /> AI is working…
          </div>
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
          placeholder={listening ? 'Listening...' : 'Ask the AI...'}
          disabled={loading}
          style={inputFieldStyle}
        />
        {speechSupported && (
          <button
            type="button"
            onClick={toggleMic}
            disabled={loading}
            title={listening ? 'Stop dictation' : 'Dictate with your voice'}
            aria-label={listening ? 'Stop dictation' : 'Start dictation'}
            style={{
              ...micBtnStyle,
              background: listening ? '#dc2626' : '#fff',
              color: listening ? '#fff' : '#475569',
              borderColor: listening ? '#dc2626' : '#cbd5e1',
            }}
          >
            <MicIcon />
          </button>
        )}
        {loading ? (
          <button
            onClick={stop}
            title="Stop the AI"
            aria-label="Stop"
            style={stopBtnStyle}
          >
            Stop
          </button>
        ) : (
          <button
            onClick={() => sendMessage()}
            disabled={!input.trim()}
            style={{
              ...sendBtnStyle,
              opacity: !input.trim() ? 0.4 : 1,
            }}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}

function toolBadgeLabel(state: ToolCallState | undefined): string {
  if (state === 'done') return '✓';
  if (state === 'error') return '✗';
  return '…';
}

function toolBadgeVariant(state: ToolCallState | undefined): React.CSSProperties {
  if (state === 'done') return { background: '#dcfce7', color: '#166534' };
  if (state === 'error') return { background: '#fee2e2', color: '#991b1b' };
  return { background: '#e0e7ff', color: '#3730a3' };
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

const clearBtnStyle: React.CSSProperties = {
  background: 'none',
  border: '1px solid #e2e8f0',
  borderRadius: 4,
  fontSize: 11,
  color: '#64748b',
  cursor: 'pointer',
  padding: '2px 8px',
  marginRight: 4,
  lineHeight: 1.4,
  fontFamily: 'inherit',
};

const minimiseBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  fontSize: 20,
  color: '#94a3b8',
  cursor: 'pointer',
  padding: '0 6px',
  lineHeight: 1,
  fontFamily: 'inherit',
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

const micBtnStyle: React.CSSProperties = {
  width: 36,
  height: 36,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 8,
  border: '1px solid #cbd5e1',
  cursor: 'pointer',
  padding: 0,
  flexShrink: 0,
};

function MicIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

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

const stopBtnStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: '#fff',
  color: '#dc2626',
  border: '1px solid #fecaca',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};

const toolBadgeStyle: React.CSSProperties = {
  display: 'inline-block',
  minWidth: 16,
  textAlign: 'center',
  marginRight: 6,
  padding: '0 5px',
  borderRadius: 4,
  fontSize: 10,
  fontWeight: 700,
  lineHeight: '14px',
  verticalAlign: 'middle',
};

const errorBannerStyle: React.CSSProperties = {
  marginTop: 4,
  padding: '6px 10px',
  background: '#fef2f2',
  color: '#991b1b',
  border: '1px solid #fecaca',
  borderRadius: 6,
  fontSize: 12,
  maxWidth: '85%',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const infoBannerStyle: React.CSSProperties = {
  marginTop: 4,
  padding: '6px 10px',
  background: '#fef9c3',
  color: '#854d0e',
  border: '1px solid #fde68a',
  borderRadius: 6,
  fontSize: 12,
  maxWidth: '85%',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const bannerActionBtnStyle: React.CSSProperties = {
  padding: '3px 10px',
  background: '#854d0e',
  color: '#fef9c3',
  border: 'none',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  flexShrink: 0,
};

const workingIndicatorStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 4px',
  fontSize: 12,
  color: '#64748b',
  fontStyle: 'italic',
};

const dotPulseStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: '#3b82f6',
  animation: 'mindblown-pulse 1s ease-in-out infinite',
};

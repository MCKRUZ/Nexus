import { useEffect, useState, useMemo, useCallback, Fragment, type CSSProperties, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  type LangfuseDailyMetric,
  type LangfuseTrace,
  type LangfuseTraceDetail,
  type LangfuseObservation,
  type LangfuseScore,
  type LangfuseSession,
  type NativeSession,
  type NativeSessionDetail,
  type NativeEvent,
  type NativeStats,
} from '../api.js';

type Tab = 'overview' | 'native' | 'traces' | 'sessions' | 'observations' | 'users';
type Range = '7d' | '30d' | '90d';
type SortDir = 'asc' | 'desc' | null;
type SessionSortKey = 'lastActivity' | 'traces' | 'cost' | 'avgLatency' | 'duration';
type TracesSortKey = 'timestamp' | 'latency' | 'cost';

// ─── Formatters ────────────────────────────────────────────────────────────────

function relativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const d = Math.floor(diff / 86400000);
  const h = Math.floor(diff / 3600000);
  const m = Math.floor(diff / 60000);
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (d > 30) return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ts));
  if (d > 0) return fmt.format(-d, 'day');
  if (h > 0) return fmt.format(-h, 'hour');
  if (m > 0) return fmt.format(-m, 'minute');
  return 'just now';
}

function formatCost(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.001) return `$${n.toFixed(6)}`;
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 3 }).format(n);
}

function formatTokens(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function formatLatency(secs: number): string {
  const ms = secs * 1000;
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatDuration(ms: number): string {
  if (ms >= 3600000) return `${(ms / 3600000).toFixed(1)}h`;
  if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
  if (ms >= 1000) return `${Math.round(ms / 1000)}s`;
  return `${ms}ms`;
}

function fmtAxisDate(dateStr: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(dateStr + 'T12:00:00'),
  );
}

// Preview text for collapsed rows
function extractText(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'string') return val.slice(0, 200);
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) {
    const last = val[val.length - 1] as Record<string, unknown> | undefined;
    if (last) {
      if (typeof last['content'] === 'string') return last['content'].slice(0, 200);
      if (typeof last['text'] === 'string') return last['text'].slice(0, 200);
    }
    return `[${val.length} items]`;
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    for (const k of ['content', 'text', 'response', 'output', 'answer', 'result', 'message']) {
      if (typeof obj[k] === 'string') return (obj[k] as string).slice(0, 200);
    }
    if (Array.isArray(obj['messages'])) {
      const msgs = obj['messages'] as unknown[];
      const last = msgs[msgs.length - 1] as Record<string, unknown> | undefined;
      if (last && typeof last['content'] === 'string') return last['content'].slice(0, 200);
    }
    try { return JSON.stringify(val).slice(0, 200); } catch { return ''; }
  }
  return '';
}

// ─── I/O display ───────────────────────────────────────────────────────────────

type ChatMessage = { role: string; content: unknown };

function isChatMsg(v: unknown): v is ChatMessage {
  if (typeof v !== 'object' || v == null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['role'] === 'string' && 'content' in o;
}

function msgToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as unknown[])
      .filter((p): p is Record<string, unknown> => typeof p === 'object' && p != null)
      .flatMap(p => (p['type'] === 'text' && typeof p['text'] === 'string' ? [p['text'] as string] : []))
      .join('\n');
  }
  try { return JSON.stringify(content, null, 2); } catch { return String(content); }
}

function extractMsgs(val: unknown): ChatMessage[] | null {
  if (Array.isArray(val) && val.length > 0 && isChatMsg(val[0])) return val as ChatMessage[];
  if (typeof val === 'object' && val != null) {
    const o = val as Record<string, unknown>;
    if (Array.isArray(o['messages']) && o['messages'].length > 0 && isChatMsg((o['messages'] as unknown[])[0])) {
      const msgs = o['messages'] as ChatMessage[];
      // Anthropic API stores system prompt as a separate top-level "system" field —
      // prepend it as a synthetic system message so it shows up as CTX
      if (o['system'] != null) {
        return [{ role: 'system', content: o['system'] as unknown }, ...msgs];
      }
      return msgs;
    }
    if (isChatMsg(val)) return [val as ChatMessage];
  }
  return null;
}

const ROLE_STYLE: Record<string, { bg: string; color: string; roleColor: string }> = {
  system:    { bg: 'rgba(139,148,158,0.07)', color: 'var(--text2)', roleColor: 'var(--text2)' },
  user:      { bg: 'rgba(88,166,255,0.07)',  color: 'var(--text)',  roleColor: 'var(--accent)' },
  assistant: { bg: 'rgba(121,192,255,0.08)', color: 'var(--text)',  roleColor: '#79c0ff' },
  tool:      { bg: 'rgba(188,140,255,0.07)', color: 'var(--text2)', roleColor: 'var(--purple)' },
};

const ROLE_STYLE_HISTORY: Record<string, { bg: string; color: string; roleColor: string }> = {
  system:    { bg: 'rgba(139,148,158,0.04)', color: 'var(--text2)', roleColor: 'rgba(139,148,158,0.55)' },
  user:      { bg: 'rgba(88,166,255,0.025)', color: 'var(--text2)', roleColor: 'rgba(88,166,255,0.45)' },
  assistant: { bg: 'rgba(121,192,255,0.025)',color: 'var(--text2)', roleColor: 'rgba(121,192,255,0.45)' },
  tool:      { bg: 'rgba(188,140,255,0.025)',color: 'var(--text2)', roleColor: 'rgba(188,140,255,0.45)' },
};

function ChatBubble({ msg, isNew = false, isHistory = false }: { msg: ChatMessage; isNew?: boolean; isHistory?: boolean }) {
  const text = msgToText(msg.content);
  const base = isHistory
    ? (ROLE_STYLE_HISTORY[msg.role] ?? { bg: 'var(--bg3)', color: 'var(--text2)', roleColor: 'var(--text2)' })
    : (ROLE_STYLE[msg.role] ?? { bg: 'var(--bg3)', color: 'var(--text)', roleColor: 'var(--text2)' });
  return (
    <div style={{
      padding: '8px 12px', borderRadius: 4, marginBottom: 5,
      background: isNew ? 'rgba(63,185,80,0.07)' : base.bg,
      border: `1px solid ${isNew ? 'rgba(63,185,80,0.3)' : isHistory ? 'rgba(255,255,255,0.04)' : 'var(--border)'}`,
      opacity: isHistory ? 0.65 : 1,
    }}>
      <div style={{ fontSize: 10, color: isNew ? 'var(--green)' : base.roleColor, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
        {msg.role}
        {isNew && <span style={{ fontSize: 9, padding: '0 4px', borderRadius: 2, background: 'rgba(63,185,80,0.18)', color: 'var(--green)', fontWeight: 600, letterSpacing: '0.3px' }}>NEW</span>}
        {msg.role === 'system' && !isNew && <span style={{ fontSize: 9, padding: '0 4px', borderRadius: 2, background: 'rgba(139,148,158,0.15)', color: 'var(--text2)', fontWeight: 500, letterSpacing: '0.3px' }}>CTX</span>}
        {isHistory && msg.role !== 'system' && <span style={{ fontSize: 9, padding: '0 4px', borderRadius: 2, background: 'rgba(139,148,158,0.12)', color: 'var(--text2)', fontWeight: 500, letterSpacing: '0.3px' }}>HIST</span>}
      </div>
      <div style={{ fontSize: 12, color: isNew ? 'var(--text)' : base.color, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.65 }}>
        {text || <em style={{ opacity: 0.4 }}>(empty)</em>}
      </div>
    </div>
  );
}

// Context-aware message list: last user message = NEW INPUT, system = CTX, prior turns = HIST
function ContextAwareMsgs({ msgs }: { msgs: ChatMessage[] }) {
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role === 'user') { lastUserIdx = i; break; }
  }
  return (
    <div>
      {msgs.map((msg, i) => {
        const isNewInput = i === lastUserIdx && lastUserIdx >= 0;
        const isHistory = !isNewInput && msg.role !== 'system' && i < lastUserIdx;
        return (
          <Fragment key={i}>
            {isNewInput && i > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0 6px' }}>
                <div style={{ flex: 1, height: 1, background: 'rgba(63,185,80,0.2)' }} />
                <span style={{ fontSize: 9, color: 'var(--green)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px', opacity: 0.85 }}>new input</span>
                <div style={{ flex: 1, height: 1, background: 'rgba(63,185,80,0.2)' }} />
              </div>
            )}
            <ChatBubble msg={msg} isNew={isNewInput} isHistory={isHistory} />
          </Fragment>
        );
      })}
    </div>
  );
}

function IOBlock({ val, isOutput = false }: { val: unknown; isOutput?: boolean }) {
  if (val == null)
    return <span style={{ color: 'var(--text2)', fontSize: 12, fontStyle: 'italic' }}>not recorded</span>;
  if (typeof val === 'string')
    return <div style={{ fontSize: 12, color: isOutput ? '#79c0ff' : 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.65 }}>{val}</div>;
  const msgs = extractMsgs(val);
  if (msgs)
    return <div>{msgs.map((m, i) => <ChatBubble key={i} msg={m} />)}</div>;
  if (typeof val === 'object' && !Array.isArray(val)) {
    const o = val as Record<string, unknown>;
    for (const k of ['content', 'text', 'response', 'output', 'answer', 'result', 'message']) {
      if (typeof o[k] === 'string')
        return <div style={{ fontSize: 12, color: isOutput ? '#79c0ff' : 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.65 }}>{o[k] as string}</div>;
    }
  }
  return (
    <pre style={{ margin: 0, fontSize: 11, fontFamily: 'var(--mono)', lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: isOutput ? '#79c0ff' : 'var(--text)' }}>
      {JSON.stringify(val, null, 2)}
    </pre>
  );
}

// ─── PathValueTree ─────────────────────────────────────────────────────────────

function pvLeafColor(v: unknown): string {
  if (v == null) return 'var(--text2)';
  if (typeof v === 'string') return '#79c0ff';
  if (typeof v === 'number') return 'var(--yellow)';
  if (typeof v === 'boolean') return v ? 'var(--green)' : 'var(--red)';
  return 'var(--text)';
}

function PVRow({ path, value, depth, autoExpand = false }: { path: string; value: unknown; depth: number; autoExpand?: boolean }) {
  const isObj = value != null && typeof value === 'object';
  const entries: [string, unknown][] = isObj
    ? Array.isArray(value)
      ? (value as unknown[]).map((v, i) => [String(i), v])
      : Object.entries(value as Record<string, unknown>)
    : [];
  const [expanded, setExpanded] = useState(autoExpand && entries.length <= 5);
  const indent = 12 + depth * 18;

  if (isObj) {
    return (
      <div>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setExpanded(e => !e)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(v => !v); } }}
          style={{ display: 'flex', gap: 16, paddingTop: 5, paddingBottom: 5, paddingLeft: indent, paddingRight: 12, borderBottom: '1px solid var(--border)', cursor: 'pointer', alignItems: 'baseline' }}
          onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.03)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = ''; }}
        >
          <div style={{ width: 220 - indent + 12, minWidth: 0, display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
            <span style={{ fontSize: 9, opacity: 0.5, userSelect: 'none', width: 8 }} aria-hidden="true">{expanded ? '▼' : '▶'}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text2)', fontStyle: 'italic' }}>
            {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length} ${entries.length === 1 ? 'item' : 'items'}}`}
          </div>
        </div>
        {expanded && entries.map(([k, v]) => <PVRow key={k} path={k} value={v} depth={depth + 1} autoExpand={depth < 1} />)}
      </div>
    );
  }

  const display = value == null ? 'null' : typeof value === 'string' ? value : JSON.stringify(value);
  return (
    <div style={{ display: 'flex', gap: 16, paddingTop: 4, paddingBottom: 4, paddingLeft: indent, paddingRight: 12, borderBottom: '1px solid var(--border)', alignItems: 'baseline' }}>
      <div style={{ width: 220 - indent + 12, minWidth: 0, flexShrink: 0, paddingLeft: 13 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text2)' }}>{path}</span>
      </div>
      <div style={{ fontSize: 12, color: pvLeafColor(value), wordBreak: 'break-word', lineHeight: 1.5 }}>{display}</div>
    </div>
  );
}

function PathValueTree({ value }: { value: unknown }) {
  if (value == null)
    return <div style={{ fontSize: 12, color: 'var(--text2)', fontStyle: 'italic', padding: '10px 12px' }}>not recorded</div>;

  // Normalise: wrap primitives in an object so the table always shows Path/Value rows
  const entries: [string, unknown][] = typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>)
    : Array.isArray(value)
      ? (value as unknown[]).map((v, i) => [String(i), v])
      : [['value', value]];

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, padding: '5px 12px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
        <div style={{ width: 220, flexShrink: 0, fontSize: 10, color: 'var(--text2)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Path</div>
        <div style={{ fontSize: 10, color: 'var(--text2)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Value</div>
      </div>
      {entries.map(([k, v]) => <PVRow key={k} path={k} value={v} depth={0} autoExpand />)}
    </div>
  );
}

// ─── IOPanel (tree + chat + json toggle) ──────────────────────────────────────

type IOViewMode = 'tree' | 'chat' | 'json';

function IOPanel({ val, isOutput = false, label }: { val: unknown; isOutput?: boolean; label: string }) {
  // Determine which modes are available
  const hasMsgs = extractMsgs(val) != null;
  const defaultMode: IOViewMode = hasMsgs && !isOutput ? 'chat' : 'tree';
  const [mode, setMode] = useState<IOViewMode>(defaultMode);

  const labelColor = isOutput ? '#79c0ff' : 'var(--text2)';

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 10, color: labelColor, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', opacity: isOutput ? 0.8 : 1 }}>{label}</div>
        <div style={{ display: 'flex', gap: 2 }}>
          {(['tree', ...(hasMsgs ? ['chat'] : []), 'json'] as IOViewMode[]).map(m => (
            <button key={m} onClick={() => setMode(m)} style={{ padding: '2px 7px', fontSize: 10, borderRadius: 3, border: '1px solid var(--border)', background: mode === m ? 'var(--bg3)' : 'transparent', color: mode === m ? 'var(--text)' : 'var(--text2)', cursor: 'pointer', fontFamily: 'var(--font)', textTransform: 'capitalize' }}>
              {m}
            </button>
          ))}
        </div>
      </div>
      <div style={{ maxHeight: 300, overflowY: 'auto', background: 'var(--bg2)' }}>
        {mode === 'tree' && <PathValueTree value={val} />}
        {mode === 'chat' && (
          <div style={{ padding: '8px 10px' }}>
            {!isOutput && hasMsgs
              ? <ContextAwareMsgs msgs={extractMsgs(val)!} />
              : <IOBlock val={val} isOutput={isOutput} />}
          </div>
        )}
        {mode === 'json' && (
          <pre style={{ margin: 0, padding: '10px 12px', fontSize: 11, fontFamily: 'var(--mono)', lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: isOutput ? '#79c0ff' : 'var(--text)' }}>
            {JSON.stringify(val, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

// ─── Badges ────────────────────────────────────────────────────────────────────

function LatencyBadge({ secs }: { secs: number | undefined }) {
  if (secs == null) return <span style={{ color: 'var(--text2)', fontSize: 11 }}>—</span>;
  const color = secs > 10 ? '#f85149' : secs > 3 ? '#d29922' : '#3fb950';
  const bg = secs > 10 ? 'rgba(248,81,73,0.12)' : secs > 3 ? 'rgba(210,153,34,0.12)' : 'rgba(63,185,80,0.12)';
  return (
    <span style={{ display: 'inline-block', padding: '2px 7px', borderRadius: 10, fontSize: 11, fontWeight: 600, fontVariantNumeric: 'tabular-nums', background: bg, color, whiteSpace: 'nowrap' }}>
      {formatLatency(secs)}
    </span>
  );
}

function CostBadge({ cost }: { cost: number | undefined }) {
  if (cost == null) return <span style={{ color: 'var(--text2)', fontSize: 11 }}>—</span>;
  if (cost === 0) return <span style={{ color: 'var(--text2)', fontSize: 11 }}>$0</span>;
  return (
    <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--yellow)', whiteSpace: 'nowrap' }}>
      {formatCost(cost)}
    </span>
  );
}

function EnvBadge({ env }: { env: string | undefined }) {
  if (!env) return null;
  return (
    <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 4, fontSize: 10, background: 'rgba(88,166,255,0.1)', color: 'var(--accent)', border: '1px solid rgba(88,166,255,0.2)', fontWeight: 500 }}>
      {env}
    </span>
  );
}

// ─── Chart helpers ─────────────────────────────────────────────────────────────

const BAR_H = 72;
const LABEL_H = 18;
const CHART_H = BAR_H + LABEL_H;
const CHART_W = 800;

function axisLabels(data: { date: string }[], slotW: number) {
  if (data.length === 0) return [];
  if (data.length === 1) return [{ idx: 0, x: slotW / 2, anchor: 'middle' as const }];
  const mid = Math.floor((data.length - 1) / 2);
  return [
    { idx: 0, x: slotW * 0.5, anchor: 'start' as const },
    { idx: mid, x: (mid + 0.5) * slotW, anchor: 'middle' as const },
    { idx: data.length - 1, x: (data.length - 0.5) * slotW, anchor: 'end' as const },
  ];
}

// ─── Charts ────────────────────────────────────────────────────────────────────

function TokenBarChart({ metrics }: { metrics: LangfuseDailyMetric[] }) {
  const data = useMemo(
    () => [...metrics].reverse().map(d => ({
      date: d.date,
      input: d.usage.reduce((s, u) => s + u.inputUsage, 0),
      output: d.usage.reduce((s, u) => s + u.outputUsage, 0),
    })),
    [metrics],
  );
  if (data.length === 0) return <div className="empty">No token data</div>;
  const maxVal = Math.max(...data.map(d => d.input + d.output), 1);
  const slotW = CHART_W / data.length;
  const barW = Math.max(slotW - 2, 2);
  const labels = axisLabels(data, slotW);
  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: 11, color: 'var(--text2)' }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 1, background: '#58a6ff', marginRight: 4 }} />Input</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 1, background: '#3fb950', marginRight: 4 }} />Output</span>
      </div>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} style={{ width: '100%', height: CHART_H }} role="img" aria-label="Token usage bar chart">
        {data.map((d, i) => {
          const totalH = ((d.input + d.output) / maxVal) * BAR_H;
          const inputH = (d.input / maxVal) * BAR_H;
          const outputH = (d.output / maxVal) * BAR_H;
          const x = i * slotW + 1;
          return (
            <g key={d.date}>
              <title>{fmtAxisDate(d.date)}: {d.input.toLocaleString()} input · {d.output.toLocaleString()} output</title>
              <rect x={x} y={0} width={barW} height={BAR_H} fill="var(--bg3)" rx={1} opacity={0.5} />
              {outputH > 0 && <rect x={x} y={BAR_H - outputH} width={barW} height={outputH} fill="#3fb950" opacity={0.8} rx={1} />}
              {inputH > 0 && <rect x={x} y={BAR_H - totalH} width={barW} height={inputH} fill="#58a6ff" opacity={0.85} rx={1} />}
            </g>
          );
        })}
        {labels.map(({ idx, x, anchor }) => (
          <text key={idx} x={x} y={BAR_H + 14} textAnchor={anchor} fill="var(--text2)" fontSize={9} fontFamily="var(--font)">{fmtAxisDate(data[idx]!.date)}</text>
        ))}
      </svg>
    </div>
  );
}

function CostBarChart({ metrics }: { metrics: LangfuseDailyMetric[] }) {
  const data = useMemo(() => [...metrics].reverse().map(d => ({ date: d.date, cost: d.totalCost })), [metrics]);
  if (data.length === 0) return <div className="empty">No cost data</div>;
  const maxCost = Math.max(...data.map(d => d.cost), 0.0001);
  const slotW = CHART_W / data.length;
  const barW = Math.max(slotW - 2, 2);
  const labels = axisLabels(data, slotW);
  return (
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} style={{ width: '100%', height: CHART_H }} role="img" aria-label="Cost per day bar chart">
      {data.map((d, i) => {
        const h = (d.cost / maxCost) * BAR_H;
        const x = i * slotW + 1;
        return (
          <g key={d.date}>
            <title>{fmtAxisDate(d.date)}: {formatCost(d.cost)}</title>
            <rect x={x} y={0} width={barW} height={BAR_H} fill="var(--bg3)" rx={1} opacity={0.5} />
            {h > 0 && <rect x={x} y={BAR_H - h} width={barW} height={h} fill="#d29922" opacity={0.85} rx={1} />}
          </g>
        );
      })}
      {labels.map(({ idx, x, anchor }) => (
        <text key={idx} x={x} y={BAR_H + 14} textAnchor={anchor} fill="var(--text2)" fontSize={9} fontFamily="var(--font)">{fmtAxisDate(data[idx]!.date)}</text>
      ))}
    </svg>
  );
}

function TraceVolumeChart({ metrics }: { metrics: LangfuseDailyMetric[] }) {
  const data = useMemo(() => [...metrics].reverse().map(d => ({ date: d.date, count: d.countTraces })), [metrics]);
  if (data.length === 0) return <div className="empty">No trace data</div>;
  const maxVal = Math.max(...data.map(d => d.count), 1);
  const slotW = CHART_W / data.length;
  const barW = Math.max(slotW - 2, 2);
  const labels = axisLabels(data, slotW);
  return (
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} style={{ width: '100%', height: CHART_H }} role="img" aria-label="Trace volume bar chart">
      {data.map((d, i) => {
        const h = (d.count / maxVal) * BAR_H;
        const x = i * slotW + 1;
        return (
          <g key={d.date}>
            <title>{fmtAxisDate(d.date)}: {d.count} traces</title>
            <rect x={x} y={0} width={barW} height={BAR_H} fill="var(--bg3)" rx={1} opacity={0.5} />
            {h > 0 && <rect x={x} y={BAR_H - h} width={barW} height={h} fill="var(--accent)" opacity={0.7} rx={1} />}
          </g>
        );
      })}
      {labels.map(({ idx, x, anchor }) => (
        <text key={idx} x={x} y={BAR_H + 14} textAnchor={anchor} fill="var(--text2)" fontSize={9} fontFamily="var(--font)">{fmtAxisDate(data[idx]!.date)}</text>
      ))}
    </svg>
  );
}

function ModelBreakdown({ metrics }: { metrics: LangfuseDailyMetric[] }) {
  const models = useMemo(() => {
    const m: Record<string, { cost: number; tokens: number }> = {};
    for (const d of metrics) {
      for (const u of d.usage) {
        if (!m[u.model]) m[u.model] = { cost: 0, tokens: 0 };
        m[u.model]!.cost += u.totalCost;
        m[u.model]!.tokens += u.totalUsage;
      }
    }
    return Object.entries(m).sort((a, b) => b[1].cost - a[1].cost).slice(0, 8);
  }, [metrics]);
  if (models.length === 0) return <div className="empty">No model data</div>;
  const maxCost = Math.max(...models.map(([, v]) => v.cost), 0.0001);
  return (
    <div>
      {models.map(([model, stats]) => (
        <div key={model} style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
            <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>{model}</span>
            <span style={{ color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>{formatCost(stats.cost)} · {formatTokens(stats.tokens)} tok</span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: 'var(--bg3)' }}>
            <div style={{ height: '100%', borderRadius: 2, background: 'var(--accent)', width: `${(stats.cost / maxCost) * 100}%`, transition: 'width 0.3s' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ScoreOverview({ scores }: { scores: LangfuseScore[] }) {
  const byName = useMemo(() => {
    const m: Record<string, number[]> = {};
    for (const s of scores) {
      if (!m[s.name]) m[s.name] = [];
      m[s.name]!.push(s.value);
    }
    return Object.entries(m).map(([name, vals]) => ({
      name,
      avg: vals.reduce((a, b) => a + b, 0) / vals.length,
      count: vals.length,
    }));
  }, [scores]);
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      {byName.map(s => (
        <div key={s.name} className="card" style={{ minWidth: 120 }}>
          <div className="card-title">{s.name}</div>
          <div className="card-value" style={{ fontSize: 22, color: s.avg >= 0.8 ? 'var(--green)' : s.avg >= 0.5 ? 'var(--yellow)' : 'var(--red)' }}>
            {s.avg.toFixed(2)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>{s.count} scores</div>
        </div>
      ))}
    </div>
  );
}

// ─── StatCard ──────────────────────────────────────────────────────────────────

function StatCard({ label, display, color, sub }: { label: string; display: string; color: string; sub?: string }) {
  return (
    <div className="card">
      <div className="card-title">{label}</div>
      <div className="card-value" style={{ color: `var(--${color})`, fontSize: 24 }}>{display}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ─── SortButton ────────────────────────────────────────────────────────────────

function SortButton({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        color: active ? 'var(--accent)' : 'var(--text2)',
        fontSize: 11,
        padding: '2px 4px',
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontWeight: active ? 700 : 500,
        fontFamily: 'var(--font)',
        textTransform: 'uppercase',
        letterSpacing: '0.4px',
      }}
    >
      {label} {active ? (dir === 'asc' ? '↑' : '↓') : '↕'}
    </button>
  );
}

// ─── MetadataView ──────────────────────────────────────────────────────────────

function MetadataView({ meta }: { meta: unknown }) {
  if (meta == null) return null;
  if (typeof meta !== 'object' || Array.isArray(meta))
    return <pre style={{ fontSize: 11, fontFamily: 'var(--mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{JSON.stringify(meta, null, 2)}</pre>;
  const entries = Object.entries(meta as Record<string, unknown>);
  if (entries.length === 0) return null;
  return (
    <div>
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', gap: 12, padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
          <div style={{ fontFamily: 'var(--mono)', color: 'var(--accent)', minWidth: 150, flexShrink: 0, wordBreak: 'break-all' }}>{k}</div>
          <div style={{ color: 'var(--text)', wordBreak: 'break-all' }}>{typeof v === 'string' ? v : JSON.stringify(v)}</div>
        </div>
      ))}
    </div>
  );
}

// ─── ObsRow ────────────────────────────────────────────────────────────────────

const OBS_COLORS: Record<string, [string, string]> = {
  GENERATION: ['rgba(88,166,255,0.12)', 'var(--accent)'],
  SPAN:       ['rgba(188,140,255,0.12)', 'var(--purple)'],
  EVENT:      ['rgba(210,153,34,0.12)',  'var(--yellow)'],
};

function ObsRow({ obs, depth }: { obs: LangfuseObservation; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const durationMs =
    obs.startTime && obs.endTime
      ? new Date(obs.endTime).getTime() - new Date(obs.startTime).getTime()
      : null;
  const hasIO = obs.input != null || obs.output != null;
  const [typeBg, typeColor] = OBS_COLORS[obs.type] ?? ['var(--bg3)', 'var(--text2)'];
  const totalTokens = obs.usageDetails
    ? Object.values(obs.usageDetails).reduce((s, v) => s + v, 0)
    : null;

  return (
    <div>
      <div
        role={hasIO ? 'button' : undefined}
        tabIndex={hasIO ? 0 : undefined}
        aria-expanded={hasIO ? expanded : undefined}
        onClick={() => hasIO && setExpanded(e => !e)}
        onKeyDown={e => { if (hasIO && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setExpanded(v => !v); } }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 7,
          paddingBottom: 7,
          paddingRight: 12,
          paddingLeft: 12 + depth * 20,
          borderBottom: '1px solid var(--border)',
          cursor: hasIO ? 'pointer' : 'default',
          fontSize: 12,
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg3)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = ''; }}
      >
        {depth > 0 && <span style={{ color: 'var(--border)', fontSize: 10, userSelect: 'none', flexShrink: 0 }}>└</span>}
        <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600, background: typeBg, color: typeColor, whiteSpace: 'nowrap', flexShrink: 0 }}>
          {obs.type}
        </span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>
          {obs.name ?? <em style={{ color: 'var(--text2)' }}>unnamed</em>}
        </span>
        {obs.model && <span style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap', flexShrink: 0 }}>{obs.model}</span>}
        {totalTokens != null && totalTokens > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap', flexShrink: 0 }}>{formatTokens(totalTokens)} tok</span>
        )}
        {durationMs != null && (
          <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', flexShrink: 0, color: durationMs > 10000 ? 'var(--red)' : durationMs > 3000 ? 'var(--yellow)' : 'var(--text2)' }}>
            {formatDuration(durationMs)}
          </span>
        )}
        {hasIO && <span style={{ fontSize: 9, opacity: 0.4, userSelect: 'none', flexShrink: 0 }} aria-hidden="true">{expanded ? '▼' : '▶'}</span>}
      </div>
      {expanded && (obs.input != null || obs.output != null) && (
        <div style={{ paddingTop: 10, paddingBottom: 10, paddingRight: 12, paddingLeft: 12 + depth * 20 + 16, background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {obs.input != null && <IOPanel val={obs.input} label="Input" />}
            {obs.output != null && <IOPanel val={obs.output} isOutput label="Output" />}
          </div>
        </div>
      )}
    </div>
  );
}

function buildObsTree(observations: LangfuseObservation[]) {
  const sorted = [...observations].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const childMap = new Map<string, LangfuseObservation[]>();
  for (const obs of sorted) {
    if (obs.parentObservationId) {
      if (!childMap.has(obs.parentObservationId)) childMap.set(obs.parentObservationId, []);
      childMap.get(obs.parentObservationId)!.push(obs);
    }
  }
  const roots = sorted.filter(obs => !obs.parentObservationId);
  return { roots, childMap };
}

function ObsTree({ observations }: { observations: LangfuseObservation[] }) {
  const { roots, childMap } = useMemo(() => buildObsTree(observations), [observations]);
  function renderNode(obs: LangfuseObservation, depth: number): ReactNode {
    const children = childMap.get(obs.id) ?? [];
    return (
      <Fragment key={obs.id}>
        <ObsRow obs={obs} depth={depth} />
        {children.map(child => renderNode(child, depth + 1))}
      </Fragment>
    );
  }
  return <div>{roots.map(r => renderNode(r, 0))}</div>;
}

// ─── InlineTraceDetail ─────────────────────────────────────────────────────────

function InlineTraceDetail({ trace }: { trace: LangfuseTrace }) {
  const [detail, setDetail] = useState<LangfuseTraceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detailTab, setDetailTab] = useState<'preview' | 'scores' | 'metadata'>('preview');

  useEffect(() => {
    setLoading(true);
    setError('');
    setDetail(null);
    api.langfuse.traceDetail(trace.id)
      .then(d => setDetail(d))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [trace.id]);

  const observations: LangfuseObservation[] = detail?.observations ?? [];
  const modelName = observations.find(o => o.type === 'GENERATION' && o.model)?.model;

  return (
    <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
      {/* Chip row */}
      <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 11, background: 'rgba(255,255,255,0.015)' }}>
        <span style={{ color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>{new Date(trace.timestamp).toLocaleString()}</span>
        {trace.latency != null && (
          <span style={{ padding: '1px 7px', borderRadius: 10, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', color: 'var(--text2)', whiteSpace: 'nowrap' }}>
            Latency: <span style={{ color: trace.latency > 10 ? 'var(--red)' : trace.latency > 3 ? 'var(--yellow)' : 'var(--green)', fontWeight: 600 }}>{formatLatency(trace.latency)}</span>
          </span>
        )}
        {trace.environment && (
          <span style={{ padding: '1px 7px', borderRadius: 10, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', color: 'var(--text2)' }}>
            Env: <span style={{ color: 'var(--accent)' }}>{trace.environment}</span>
          </span>
        )}
        {modelName && (
          <span style={{ padding: '1px 7px', borderRadius: 10, background: 'rgba(88,166,255,0.08)', border: '1px solid rgba(88,166,255,0.2)', color: 'var(--accent)', fontFamily: 'var(--mono)', fontSize: 10 }}>
            {modelName}
          </span>
        )}
        {trace.totalCost != null && trace.totalCost > 0 && (
          <span style={{ padding: '1px 7px', borderRadius: 10, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', color: 'var(--yellow)' }}>
            {formatCost(trace.totalCost)}
          </span>
        )}
        {trace.userId && <span style={{ color: 'var(--text2)' }}>User: <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>{trace.userId}</span></span>}
        {trace.sessionId && <span style={{ color: 'var(--text2)' }} title={trace.sessionId}>Session: <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>{trace.sessionId.slice(0, 14)}…</span></span>}
        {trace.tags.map(tag => (
          <span key={tag} style={{ padding: '1px 5px', borderRadius: 3, background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text2)' }}>{tag}</span>
        ))}
      </div>

      {/* Tab nav */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
        {(['preview', 'scores', 'metadata'] as const).map(t => (
          <button key={t} onClick={() => setDetailTab(t)} style={{
            padding: '7px 16px', border: 'none', borderBottom: `2px solid ${detailTab === t ? 'var(--accent)' : 'transparent'}`,
            background: 'transparent', color: detailTab === t ? 'var(--accent)' : 'var(--text2)',
            cursor: 'pointer', fontSize: 12, fontFamily: 'var(--font)', marginBottom: -1, transition: 'color 0.15s',
          }}>
            {t === 'preview' ? 'Preview' : t === 'scores' ? `Scores${trace.scores.length > 0 ? ` (${trace.scores.length})` : ''}` : 'Metadata'}
          </button>
        ))}
      </div>

      {/* Preview tab */}
      {detailTab === 'preview' && (
        <div style={{ padding: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <IOPanel val={trace.input} label="Input" />
            <IOPanel val={trace.output} isOutput label="Output" />
          </div>
          {loading && <div className="loading" role="status" style={{ padding: '16px 0' }}>Loading observations…</div>}
          {error && <div className="error-banner">{error}</div>}
          {!loading && observations.length > 0 && (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '7px 12px', fontSize: 10, color: 'var(--text2)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
                Observations ({observations.length})
              </div>
              <ObsTree observations={observations} />
            </div>
          )}
          {!loading && observations.length === 0 && !error && (
            <div style={{ fontSize: 12, color: 'var(--text2)', padding: '8px 0' }}>No observations recorded</div>
          )}
        </div>
      )}

      {/* Scores tab */}
      {detailTab === 'scores' && (
        <div style={{ padding: 16 }}>
          {trace.scores.length === 0
            ? <div className="empty">No scores</div>
            : (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 100px', gap: '0 12px', padding: '7px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                  {['Name', 'Value', 'Type'].map(h => (
                    <div key={h} style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{h}</div>
                  ))}
                </div>
                {trace.scores.map(s => (
                  <div key={s.name} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 100px', gap: '0 12px', padding: '9px 16px', borderBottom: '1px solid var(--border)', alignItems: 'center', fontSize: 12 }}>
                    <div style={{ fontWeight: 500 }}>{s.name}</div>
                    <div style={{ fontWeight: 700, color: s.value >= 0.8 ? 'var(--green)' : s.value >= 0.5 ? 'var(--yellow)' : 'var(--red)', fontVariantNumeric: 'tabular-nums' }}>{s.value.toFixed(3)}</div>
                    <div style={{ color: 'var(--text2)' }}>NUMERIC</div>
                  </div>
                ))}
              </div>
            )}
        </div>
      )}

      {/* Metadata tab */}
      {detailTab === 'metadata' && (
        <div>
          {loading
            ? <div className="loading">Loading…</div>
            : detail != null && detail.metadata != null
              ? <PathValueTree value={detail.metadata} />
              : <div className="empty">No metadata</div>}
        </div>
      )}
    </div>
  );
}

// ─── TraceRow ─────────────────────────────────────────────────────────────────

function TraceRow({
  t,
  detailed = false,
}: {
  t: LangfuseTrace;
  detailed?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const inp = extractText(t.input);
  const out = extractText(t.output);
  const hasIO = t.input != null || t.output != null;
  const cols = detailed ? '110px 1fr 120px 120px 80px 80px' : '110px 1fr 100px 80px 80px';

  return (
    <div>
      <div
        role={hasIO ? 'button' : undefined}
        tabIndex={hasIO ? 0 : undefined}
        aria-expanded={hasIO ? expanded : undefined}
        onClick={() => hasIO && setExpanded(e => !e)}
        onKeyDown={e => { if (hasIO && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setExpanded(v => !v); } }}
        style={{
          padding: '11px 16px',
          borderBottom: expanded ? 'none' : '1px solid var(--border)',
          display: 'grid',
          gridTemplateColumns: cols,
          gap: '0 16px',
          alignItems: 'start',
          cursor: hasIO ? 'pointer' : 'default',
          transition: 'background 0.1s',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg3)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = expanded ? 'var(--bg3)' : ''; }}
      >
        <div style={{ fontSize: 11, color: 'var(--text2)', paddingTop: 2, display: 'flex', alignItems: 'center', gap: 5 }}>
          {hasIO && <span style={{ opacity: 0.4, fontSize: 9, flexShrink: 0, userSelect: 'none' }} aria-hidden="true">{expanded ? '▼' : '▶'}</span>}
          {relativeTime(t.timestamp)}
        </div>

        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: inp || out ? 5 : 0 }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.name ?? <span style={{ color: 'var(--text2)', fontFamily: 'var(--mono)', fontWeight: 400 }}>{t.id.slice(0, 20)}…</span>}
            </span>
            {t.environment && <EnvBadge env={t.environment} />}
            {t.tags.map(tag => (
              <span key={tag} style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: 'var(--bg3)', color: 'var(--text2)', border: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{tag}</span>
            ))}
          </div>
          {inp && (
            <div style={{ fontSize: 11, color: 'var(--text2)', fontFamily: 'var(--mono)', lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span style={{ opacity: 0.5 }}>in  </span>{inp}
            </div>
          )}
          {out && (
            <div style={{ fontSize: 11, color: '#79c0ff', fontFamily: 'var(--mono)', lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span style={{ opacity: 0.5 }}>out </span>{out}
            </div>
          )}
          {t.scores.length > 0 && (
            <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
              {t.scores.map(s => (
                <span key={s.name} style={{ fontSize: 10, color: 'var(--text2)' }}>
                  {s.name} <span style={{ color: s.value >= 0.8 ? 'var(--green)' : s.value >= 0.5 ? 'var(--yellow)' : 'var(--red)', fontWeight: 700 }}>{s.value.toFixed(2)}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {detailed && (
          <div style={{ minWidth: 0 }}>
            {t.userId
              ? <span title={t.userId} style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text2)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.userId}</span>
              : <span style={{ color: 'var(--border)', fontSize: 12 }}>—</span>}
            {t.sessionId && (
              <span title={t.sessionId} style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--border)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                {t.sessionId.slice(0, 8)}…
              </span>
            )}
          </div>
        )}

        {!detailed && (
          <div style={{ minWidth: 0 }}>
            {t.userId
              ? <span title={t.userId} style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text2)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.userId}</span>
              : <span style={{ color: 'var(--border)', fontSize: 12 }}>—</span>}
          </div>
        )}

        <div><LatencyBadge secs={t.latency} /></div>
        <div><CostBadge cost={t.totalCost} /></div>
      </div>

      {expanded && <InlineTraceDetail trace={t} />}
    </div>
  );
}

// ─── TraceListHeader ──────────────────────────────────────────────────────────

interface TraceSort {
  key: TracesSortKey;
  dir: SortDir;
  onSort: (k: TracesSortKey) => void;
}

function TraceListHeader({ detailed = false, indent = false, sort }: { detailed?: boolean; indent?: boolean; sort?: TraceSort }) {
  const base: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: detailed ? '110px 1fr 120px 120px 80px 80px' : '110px 1fr 100px 80px 80px',
    gap: '0 16px',
    padding: indent ? '6px 16px 6px 32px' : '8px 16px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--bg)',
    position: 'sticky',
    top: 0,
    zIndex: 1,
  };
  const th: CSSProperties = { fontSize: 11, color: 'var(--text2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' };
  return (
    <div style={base}>
      <div style={th}>
        {sort
          ? <SortButton label="When" active={sort.key === 'timestamp'} dir={sort.key === 'timestamp' ? sort.dir : null} onClick={() => sort.onSort('timestamp')} />
          : 'When'}
      </div>
      <div style={th}>Trace</div>
      {detailed && <div style={th}>User / Session</div>}
      {!detailed && <div style={th}>User</div>}
      <div style={th}>
        {sort
          ? <SortButton label="Latency" active={sort.key === 'latency'} dir={sort.key === 'latency' ? sort.dir : null} onClick={() => sort.onSort('latency')} />
          : 'Latency'}
      </div>
      <div style={th}>
        {sort
          ? <SortButton label="Cost" active={sort.key === 'cost'} dir={sort.key === 'cost' ? sort.dir : null} onClick={() => sort.onSort('cost')} />
          : 'Cost'}
      </div>
    </div>
  );
}

// ─── Pagination ────────────────────────────────────────────────────────────────

function Pagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label="Pagination" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', paddingTop: 4 }}>
      <button className="btn" onClick={() => onChange(1)} disabled={page === 1} aria-label="First page">«</button>
      <button className="btn" onClick={() => onChange(page - 1)} disabled={page === 1} aria-label="Previous page">‹ Prev</button>
      <span style={{ fontSize: 12, color: 'var(--text2)', minWidth: 100, textAlign: 'center' }} aria-live="polite">Page {page} of {totalPages}</span>
      <button className="btn" onClick={() => onChange(page + 1)} disabled={page === totalPages} aria-label="Next page">Next ›</button>
      <button className="btn" onClick={() => onChange(totalPages)} disabled={page === totalPages} aria-label="Last page">»</button>
    </nav>
  );
}

// ─── FilterChip ────────────────────────────────────────────────────────────────

function FilterChip({ label, value, onRemove }: { label: string; value: string; onRemove: () => void }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', background: 'rgba(88,166,255,0.1)', border: '1px solid rgba(88,166,255,0.25)', borderRadius: 20, fontSize: 11 }}>
      <span style={{ color: 'var(--text2)' }}>{label}:</span>
      <span style={{ color: 'var(--accent)', fontFamily: 'var(--mono)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
      <button onClick={onRemove} aria-label={`Remove ${label} filter`} style={{ background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer', padding: 0, fontSize: 12, lineHeight: 1 }}>✕</button>
    </span>
  );
}

// ─── Overview tab ─────────────────────────────────────────────────────────────

function OverviewTab({ langfuseConfigured }: { langfuseConfigured: boolean }) {
  const [range, setRange] = useState<Range>('30d');
  const [metrics, setMetrics] = useState<LangfuseDailyMetric[]>([]);
  const [traces, setTraces] = useState<LangfuseTrace[]>([]);
  const [scores, setScores] = useState<LangfuseScore[]>([]);
  const [lfError, setLfError] = useState('');
  const [lfLoading, setLfLoading] = useState(langfuseConfigured);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [nativeStats, setNativeStats] = useState<NativeStats | null>(null);

  useEffect(() => {
    api.native.stats().then(s => setNativeStats(s)).catch(() => null);
  }, []);

  const load = useCallback(async () => {
    if (!langfuseConfigured) return;
    setRefreshing(true);
    setLfError('');
    try {
      const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
      const [mResult, tResult, scResult] = await Promise.allSettled([
        api.langfuse.metrics(days),
        api.langfuse.traces(50),
        api.langfuse.scores(100),
      ]);
      if (mResult.status === 'fulfilled') setMetrics(mResult.value.data ?? []);
      if (tResult.status === 'fulfilled') setTraces(tResult.value.data ?? []);
      if (scResult.status === 'fulfilled') setScores(scResult.value.data ?? []);
      const failures = [mResult, tResult, scResult].filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason as string);
      if (failures.length > 0) setLfError(failures.join(' · '));
      setLastUpdated(new Date());
    } catch (e) {
      setLfError(String(e));
    } finally {
      setLfLoading(false);
      setRefreshing(false);
    }
  }, [range, langfuseConfigured]);

  useEffect(() => { void load(); }, [load]);

  const totalTraces = metrics.reduce((s, d) => s + d.countTraces, 0);
  const totalInput = metrics.reduce((s, d) => s + d.usage.reduce((u, m) => u + m.inputUsage, 0), 0);
  const totalOutput = metrics.reduce((s, d) => s + d.usage.reduce((u, m) => u + m.outputUsage, 0), 0);
  const totalCost = metrics.reduce((s, d) => s + d.totalCost, 0);
  const tracesWithLatency = traces.filter(t => t.latency != null);
  const avgLatency = tracesWithLatency.length > 0
    ? tracesWithLatency.reduce((s, t) => s + (t.latency ?? 0), 0) / tracesWithLatency.length : 0;

  return (
    <div className="stacked">
      {/* Native stats — always visible */}
      {nativeStats && (
        <section aria-label="Claude Code native stats">
          <div className="section-header">
            <span className="section-title">Claude Code Activity</span>
            <span style={{ fontSize: 12, color: 'var(--text2)' }}>from ~/.claude/projects/</span>
          </div>
          <div className="stats-grid">
            <StatCard label="Claude Sessions" display={String(nativeStats.totalSessions)} color="accent" sub="from ~/.claude/projects/" />
            <StatCard label="User Turns" display={String(nativeStats.totalUserTurns)} color="green" sub="across all sessions" />
            <StatCard label="Tool Calls" display={formatTokens(nativeStats.totalToolCalls)} color="accent" sub="across all sessions" />
            <StatCard label="Active Projects" display={String(nativeStats.projects.length)} color="yellow" sub="unique project dirs" />
          </div>
        </section>
      )}

      {/* Langfuse section */}
      {langfuseConfigured && (
        <>
          <div className="filter-bar">
            <div className="range-btns" role="group" aria-label="Time range">
              {(['7d', '30d', '90d'] as Range[]).map(r => (
                <button key={r} className={`range-btn${range === r ? ' active' : ''}`} onClick={() => setRange(r)} aria-pressed={range === r}>{r}</button>
              ))}
            </div>
            <button className="btn" onClick={load} disabled={refreshing} aria-label="Refresh data" style={{ marginLeft: 'auto' }}>
              {refreshing ? '↻ Refreshing…' : '↻ Refresh'}
            </button>
            {lastUpdated && <span style={{ fontSize: 11, color: 'var(--text2)' }} aria-live="polite">Updated {relativeTime(lastUpdated.toISOString())}</span>}
          </div>

          {lfError && <div className="error-banner" role="alert">{lfError}</div>}

          {lfLoading
            ? <div className="loading" role="status">Loading Langfuse data…</div>
            : (
              <>
                <div className="stats-grid">
                  <StatCard label="Traces" display={String(totalTraces)} color="accent" sub={`last ${range}`} />
                  <StatCard label="Total Tokens" display={formatTokens(totalInput + totalOutput)} color="green" sub={`${formatTokens(totalInput)} in · ${formatTokens(totalOutput)} out`} />
                  <StatCard label="Total Cost" display={formatCost(totalCost)} color="yellow" sub={`last ${range}`} />
                  <StatCard label="Avg Latency" display={avgLatency > 0 ? formatLatency(avgLatency) : '—'} color={avgLatency > 10 ? 'red' : avgLatency > 3 ? 'yellow' : 'green'} sub="recent traces" />
                </div>

                <div className="grid-2">
                  <div className="chart-card"><div className="chart-title">Trace Volume</div><TraceVolumeChart metrics={metrics} /></div>
                  <div className="chart-card"><div className="chart-title">Token Usage — input / output</div><TokenBarChart metrics={metrics} /></div>
                </div>

                <div className="grid-2">
                  <div className="chart-card"><div className="chart-title">Cost per Day</div><CostBarChart metrics={metrics} /></div>
                  <div className="chart-card"><div className="chart-title">Model Breakdown</div><ModelBreakdown metrics={metrics} /></div>
                </div>

                {scores.length > 0 && (
                  <div className="chart-card"><div className="chart-title">Eval Scores</div><ScoreOverview scores={scores} /></div>
                )}

                <section aria-label="Recent traces">
                  <div className="section-header">
                    <span className="section-title">Recent Traces</span>
                    <span style={{ fontSize: 12, color: 'var(--text2)' }}>{traces.length} loaded · click to expand</span>
                  </div>
                  <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                    <TraceListHeader />
                    {traces.length === 0
                      ? <div className="empty">No traces yet</div>
                      : traces.map(t => <TraceRow key={t.id} t={t} />)}
                  </div>
                </section>
              </>
            )}
        </>
      )}
    </div>
  );
}

// ─── Traces tab ───────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

function TracesTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initSession = searchParams.get('session') ?? '';

  const [page, setPage] = useState(1);
  const [nameFilter, setNameFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [sessionFilter, setSessionFilter] = useState(initSession);
  const [applied, setApplied] = useState({ name: '', userId: '', sessionId: initSession });
  const [traces, setTraces] = useState<LangfuseTrace[]>([]);
  const [meta, setMeta] = useState<{ totalItems: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sortKey, setSortKey] = useState<TracesSortKey>('timestamp');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const filters = {
        ...(applied.name ? { name: applied.name } : {}),
        ...(applied.userId ? { userId: applied.userId } : {}),
        ...(applied.sessionId ? { sessionId: applied.sessionId } : {}),
      };
      const result = await api.langfuse.traces(PAGE_SIZE, page, filters);
      setTraces(result.data ?? []);
      setMeta(result.meta);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [page, applied]);

  useEffect(() => { void load(); }, [load]);

  const totalPages = meta ? Math.ceil(meta.totalItems / PAGE_SIZE) : 1;
  const hasFilters = applied.name || applied.userId || applied.sessionId;

  const applyFilters = () => {
    setApplied({ name: nameFilter, userId: userFilter, sessionId: sessionFilter });
    setPage(1);
  };

  const clearFilters = () => {
    setNameFilter(''); setUserFilter(''); setSessionFilter('');
    setApplied({ name: '', userId: '', sessionId: '' });
    setPage(1);
    if (searchParams.get('session')) setSearchParams({ tab: 'traces' }, { replace: true });
  };

  const handleSort = (k: TracesSortKey) => {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  };

  const sortedTraces = useMemo(() => {
    const arr = [...traces];
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortKey === 'timestamp') arr.sort((a, b) => dir * a.timestamp.localeCompare(b.timestamp));
    else if (sortKey === 'latency') arr.sort((a, b) => dir * ((a.latency ?? 0) - (b.latency ?? 0)));
    else if (sortKey === 'cost') arr.sort((a, b) => dir * ((a.totalCost ?? 0) - (b.totalCost ?? 0)));
    return arr;
  }, [traces, sortKey, sortDir]);

  return (
    <>
      <div className="stacked">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '12px 16px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
            <input className="filter-input" placeholder="Filter by name…" aria-label="Filter by trace name" autoComplete="off"
              value={nameFilter} onChange={e => setNameFilter(e.target.value)} onKeyDown={e => e.key === 'Enter' && applyFilters()} style={{ width: 180 }} />
            <input className="filter-input" placeholder="User ID…" aria-label="Filter by user ID" autoComplete="off"
              value={userFilter} onChange={e => setUserFilter(e.target.value)} onKeyDown={e => e.key === 'Enter' && applyFilters()} style={{ width: 180 }} />
            <input className="filter-input" placeholder="Session ID…" aria-label="Filter by session ID" autoComplete="off"
              value={sessionFilter} onChange={e => setSessionFilter(e.target.value)} onKeyDown={e => e.key === 'Enter' && applyFilters()} style={{ width: 280 }} />
          </div>
          <button className="btn btn-primary" onClick={applyFilters} disabled={loading} style={{ flexShrink: 0 }}>
            {loading ? '…' : 'Search'}
          </button>
          {hasFilters && <button className="btn" onClick={clearFilters}>✕ Clear</button>}
          <span style={{ fontSize: 12, color: 'var(--text2)', marginLeft: 'auto' }} aria-live="polite">
            {meta ? `${meta.totalItems.toLocaleString()} traces` : ''}
          </span>
          <button className="btn" onClick={load} disabled={loading} style={{ fontSize: 13 }}>↻</button>
        </div>

        {hasFilters && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {applied.name && <FilterChip label="name" value={applied.name} onRemove={() => { setNameFilter(''); setApplied(a => ({ ...a, name: '' })); setPage(1); }} />}
            {applied.userId && <FilterChip label="user" value={applied.userId} onRemove={() => { setUserFilter(''); setApplied(a => ({ ...a, userId: '' })); setPage(1); }} />}
            {applied.sessionId && <FilterChip label="session" value={applied.sessionId} onRemove={() => { setSessionFilter(''); setApplied(a => ({ ...a, sessionId: '' })); setPage(1); if (searchParams.get('session')) setSearchParams({ tab: 'traces' }, { replace: true }); }} />}
          </div>
        )}

        {error && <div className="error-banner" role="alert">{error}</div>}

        {loading
          ? <div className="loading" role="status">Loading…</div>
          : (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <TraceListHeader detailed sort={{ key: sortKey, dir: sortDir, onSort: handleSort }} />
              {sortedTraces.length === 0
                ? <div className="empty">No traces match your filters</div>
                : sortedTraces.map(t => <TraceRow key={t.id} t={t} detailed />)}
            </div>
          )}

        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>
    </>
  );
}

// ─── Sessions tab ─────────────────────────────────────────────────────────────

interface SessionGroup {
  id: string;
  createdAt?: string;
  environment?: string;
  traces: LangfuseTrace[];
  totalCost: number;
  avgLatency: number | null;
  users: string[];
  firstActivity: string;
  lastActivity: string;
}

const SESSION_GRID = '16px 1fr 150px 70px 90px 90px 80px 120px';

function SessionsListHeader({ sortKey, sortDir, onSort }: { sortKey: SessionSortKey; sortDir: SortDir; onSort: (k: SessionSortKey) => void }) {
  const th: CSSProperties = { fontSize: 11, color: 'var(--text2)', fontWeight: 600 };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: SESSION_GRID, gap: '0 12px', padding: '7px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg)', position: 'sticky', top: 0, zIndex: 1, alignItems: 'center' }}>
      <div />
      <div style={th}>Session</div>
      <div style={th}>Users</div>
      <div style={{ ...th, textAlign: 'right' }}>
        <SortButton label="Traces" active={sortKey === 'traces'} dir={sortKey === 'traces' ? sortDir : null} onClick={() => onSort('traces')} />
      </div>
      <div style={{ ...th, textAlign: 'right' }}>
        <SortButton label="Cost" active={sortKey === 'cost'} dir={sortKey === 'cost' ? sortDir : null} onClick={() => onSort('cost')} />
      </div>
      <div style={{ ...th, textAlign: 'right' }}>
        <SortButton label="Avg Lat" active={sortKey === 'avgLatency'} dir={sortKey === 'avgLatency' ? sortDir : null} onClick={() => onSort('avgLatency')} />
      </div>
      <div style={{ ...th, textAlign: 'right' }}>
        <SortButton label="Duration" active={sortKey === 'duration'} dir={sortKey === 'duration' ? sortDir : null} onClick={() => onSort('duration')} />
      </div>
      <div style={{ ...th, textAlign: 'right' }}>
        <SortButton label="Last Active" active={sortKey === 'lastActivity'} dir={sortKey === 'lastActivity' ? sortDir : null} onClick={() => onSort('lastActivity')} />
      </div>
    </div>
  );
}

function SessionAccordion({
  group,
  isExpanded,
  onToggle,
  isUnsessioned = false,
}: {
  group: SessionGroup;
  isExpanded: boolean;
  onToggle: () => void;
  isUnsessioned?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copyId = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(group.id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  const durationMs = group.firstActivity && group.lastActivity
    ? new Date(group.lastActivity).getTime() - new Date(group.firstActivity).getTime()
    : 0;

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onClick={onToggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        style={{
          display: 'grid',
          gridTemplateColumns: SESSION_GRID,
          gap: '0 12px',
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          alignItems: 'center',
          cursor: 'pointer',
          background: isExpanded ? 'rgba(88,166,255,0.04)' : undefined,
          transition: 'background 0.1s',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg3)'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = isExpanded ? 'rgba(88,166,255,0.04)' : ''; }}
      >
        {/* Chevron */}
        <span style={{ fontSize: 9, opacity: 0.45, userSelect: 'none', justifySelf: 'center' }} aria-hidden="true">
          {isExpanded ? '▼' : '▶'}
        </span>

        {/* Session ID */}
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 7 }}>
          {isUnsessioned
            ? <span style={{ fontSize: 12, color: 'var(--text2)', fontStyle: 'italic' }}>No session ID</span>
            : <>
              <span title={group.id} style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {group.id}
              </span>
              <button onClick={copyId} title="Copy session ID" aria-label="Copy session ID"
                style={{ background: 'none', border: 'none', color: copied ? 'var(--green)' : 'var(--text2)', cursor: 'pointer', padding: '2px 4px', fontSize: 11, flexShrink: 0, borderRadius: 3, lineHeight: 1 }}>
                {copied ? '✓' : '⎘'}
              </button>
              {group.environment && <EnvBadge env={group.environment} />}
            </>}
        </div>

        {/* Users */}
        <div style={{ fontSize: 11, color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {group.users.length === 0
            ? <span style={{ color: 'var(--border)' }}>—</span>
            : group.users.length === 1
              ? <span style={{ fontFamily: 'var(--mono)' }}>{group.users[0]}</span>
              : `${group.users.length} users`}
        </div>

        {/* Traces */}
        <div style={{ fontSize: 13, fontWeight: 600, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {group.traces.length}
        </div>

        {/* Cost */}
        <div style={{ textAlign: 'right' }}>
          <CostBadge cost={group.totalCost > 0 ? group.totalCost : undefined} />
        </div>

        {/* Avg latency */}
        <div style={{ textAlign: 'right' }}>
          <LatencyBadge secs={group.avgLatency ?? undefined} />
        </div>

        {/* Duration */}
        <div style={{ fontSize: 11, color: 'var(--text2)', textAlign: 'right', whiteSpace: 'nowrap' }}>
          {durationMs > 0 ? formatDuration(durationMs) : '—'}
        </div>

        {/* Last activity */}
        <div style={{ fontSize: 11, color: 'var(--text2)', textAlign: 'right', whiteSpace: 'nowrap' }}>
          {group.lastActivity ? relativeTime(group.lastActivity) : '—'}
        </div>
      </div>

      {isExpanded && (
        <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
          <TraceListHeader indent />
          {group.traces.map(t => (
            <div key={t.id} style={{ paddingLeft: 16 }}>
              <TraceRow t={t} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SessionsTab() {
  const [sessions, setSessions] = useState<LangfuseSession[]>([]);
  const [traces, setTraces] = useState<LangfuseTrace[]>([]);
  const [traceMeta, setTraceMeta] = useState<{ totalItems: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SessionSortKey>('lastActivity');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [sessResult, traceResult] = await Promise.allSettled([
        api.langfuse.sessions(100, 1),
        api.langfuse.traces(100, 1),
      ]);
      if (sessResult.status === 'fulfilled') setSessions(sessResult.value.data ?? []);
      if (traceResult.status === 'fulfilled') {
        setTraces(traceResult.value.data ?? []);
        setTraceMeta(traceResult.value.meta);
      }
      const errs = [sessResult, traceResult]
        .filter(r => r.status === 'rejected')
        .map(r => (r as PromiseRejectedResult).reason as string);
      if (errs.length > 0) setError(errs.join(' · '));
    } catch (e) {
      setError(String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const { rawGroups, unsessioned } = useMemo(() => {
    const sessionMeta: Record<string, LangfuseSession> = {};
    for (const s of sessions) sessionMeta[s.id] = s;

    const bySession: Record<string, LangfuseTrace[]> = {};
    const unsessioned: LangfuseTrace[] = [];
    for (const t of traces) {
      if (t.sessionId) {
        if (!bySession[t.sessionId]) bySession[t.sessionId] = [];
        (bySession[t.sessionId] as LangfuseTrace[]).push(t);
      } else {
        unsessioned.push(t);
      }
    }

    const rawGroups: SessionGroup[] = Object.entries(bySession).map(([id, traceList]) => {
      const meta = sessionMeta[id];
      const sorted = [...traceList].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const users = [...new Set(traceList.flatMap(t => t.userId ? [t.userId] : []))];
      const latencies = traceList.flatMap(t => t.latency != null ? [t.latency] : []);
      return {
        id,
        createdAt: meta?.createdAt,
        environment: meta?.environment ?? traceList[0]?.environment,
        traces: sorted,
        totalCost: traceList.reduce((s, t) => s + (t.totalCost ?? 0), 0),
        avgLatency: latencies.length > 0 ? latencies.reduce((s, v) => s + v, 0) / latencies.length : null,
        users,
        firstActivity: sorted[0]?.timestamp ?? '',
        lastActivity: sorted[sorted.length - 1]?.timestamp ?? '',
      };
    });

    return { rawGroups, unsessioned };
  }, [sessions, traces]);

  const groups = useMemo(() => {
    const arr = [...rawGroups];
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortKey === 'lastActivity') arr.sort((a, b) => dir * a.lastActivity.localeCompare(b.lastActivity));
    else if (sortKey === 'traces') arr.sort((a, b) => dir * (a.traces.length - b.traces.length));
    else if (sortKey === 'cost') arr.sort((a, b) => dir * (a.totalCost - b.totalCost));
    else if (sortKey === 'avgLatency') arr.sort((a, b) => dir * ((a.avgLatency ?? 0) - (b.avgLatency ?? 0)));
    else if (sortKey === 'duration') {
      arr.sort((a, b) => {
        const da = a.firstActivity && a.lastActivity ? new Date(a.lastActivity).getTime() - new Date(a.firstActivity).getTime() : 0;
        const db = b.firstActivity && b.lastActivity ? new Date(b.lastActivity).getTime() - new Date(b.firstActivity).getTime() : 0;
        return dir * (da - db);
      });
    }
    return arr;
  }, [rawGroups, sortKey, sortDir]);

  const handleSort = (k: SessionSortKey) => {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  };

  const toggleExpand = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const isSample = traceMeta != null && traceMeta.totalItems > traces.length;
  const totalTraces = groups.reduce((s, g) => s + g.traces.length, 0) + unsessioned.length;

  return (
    <>
      <div className="stacked">
        <div className="filter-bar">
          <span style={{ fontSize: 13, fontWeight: 600 }}>Sessions</span>
          <span style={{ fontSize: 12, color: 'var(--text2)', marginLeft: 8 }}>
            {groups.length} sessions · {totalTraces} traces
          </span>
          <button className="btn" onClick={load} disabled={loading} style={{ marginLeft: 'auto', fontSize: 13 }} aria-label="Refresh">↻</button>
        </div>

        {isSample && (
          <div style={{ padding: '10px 14px', background: 'rgba(210,153,34,0.07)', border: '1px solid rgba(210,153,34,0.2)', borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--yellow)' }}>
            Derived from the {traces.length} most recent traces of {traceMeta.totalItems.toLocaleString()} total. Older sessions not shown.
          </div>
        )}

        {error && <div className="error-banner" role="alert">{error}</div>}

        {loading
          ? <div className="loading" role="status">Loading…</div>
          : groups.length === 0 && unsessioned.length === 0
            ? <div className="empty">No sessions or traces found</div>
            : (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <SessionsListHeader sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                {groups.map(g => (
                  <SessionAccordion
                    key={g.id}
                    group={g}
                    isExpanded={expanded.has(g.id)}
                    onToggle={() => toggleExpand(g.id)}
                  />
                ))}
                {unsessioned.length > 0 && (
                  <SessionAccordion
                    key="__unsessioned__"
                    group={{
                      id: '__unsessioned__',
                      traces: unsessioned,
                      totalCost: unsessioned.reduce((s, t) => s + (t.totalCost ?? 0), 0),
                      avgLatency: (() => {
                        const lats = unsessioned.flatMap(t => t.latency != null ? [t.latency] : []);
                        return lats.length > 0 ? lats.reduce((s, v) => s + v, 0) / lats.length : null;
                      })(),
                      users: [...new Set(unsessioned.flatMap(t => t.userId ? [t.userId] : []))],
                      firstActivity: unsessioned[unsessioned.length - 1]?.timestamp ?? '',
                      lastActivity: unsessioned[0]?.timestamp ?? '',
                    }}
                    isExpanded={expanded.has('__unsessioned__')}
                    onToggle={() => toggleExpand('__unsessioned__')}
                    isUnsessioned
                  />
                )}
              </div>
            )}
      </div>
    </>
  );
}

// ─── Users tab ────────────────────────────────────────────────────────────────

function UsersTab() {
  const [traces, setTraces] = useState<LangfuseTrace[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.langfuse.traces(100, 1);
      setTraces(result.data ?? []);
      setTotal(result.meta.totalItems);
    } catch (e) {
      setError(String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const users = useMemo(() => {
    const m: Record<string, { count: number; cost: number; latency: number[]; lastSeen: string }> = {};
    for (const t of traces) {
      const uid = t.userId ?? '(anonymous)';
      if (!m[uid]) m[uid] = { count: 0, cost: 0, latency: [], lastSeen: t.timestamp };
      const entry = m[uid]!;
      entry.count++;
      entry.cost += t.totalCost ?? 0;
      if (t.latency != null) entry.latency.push(t.latency);
      if (t.timestamp > entry.lastSeen) entry.lastSeen = t.timestamp;
    }
    return Object.entries(m).map(([userId, data]) => ({
      userId, count: data.count, cost: data.cost,
      avgLatency: data.latency.length > 0 ? data.latency.reduce((s, v) => s + v, 0) / data.latency.length : null,
      lastSeen: data.lastSeen,
    })).sort((a, b) => b.count - a.count);
  }, [traces]);

  const isSample = total > traces.length;

  return (
    <div className="stacked">
      <div className="filter-bar">
        <span style={{ fontSize: 13, fontWeight: 600 }}>Users</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text2)' }}>{users.length > 0 ? `${users.length} users` : ''}</span>
        <button className="btn" onClick={load} disabled={loading} aria-label="Refresh users" style={{ fontSize: 13 }}>↻</button>
      </div>

      {isSample && (
        <div style={{ padding: '10px 14px', background: 'rgba(210,153,34,0.07)', border: '1px solid rgba(210,153,34,0.2)', borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--yellow)' }}>
          Sample data — showing users from the {traces.length} most recent traces of {total.toLocaleString()} total.
        </div>
      )}

      {error && <div className="error-banner" role="alert">{error}</div>}

      {loading
        ? <div className="loading" role="status">Loading…</div>
        : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 100px 100px 120px', gap: '0 16px', padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg)', position: 'sticky', top: 0, zIndex: 1 }}>
              {['User ID', 'Traces', 'Total Cost', 'Avg Latency', 'Last Seen'].map(h => (
                <div key={h} style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{h}</div>
              ))}
            </div>
            {users.length === 0
              ? <div className="empty">No user data</div>
              : users.map(u => (
                <div key={u.userId} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 100px 100px 120px', gap: '0 16px', padding: '10px 16px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg3)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = ''; }}>
                  <div style={{ minWidth: 0 }}>
                    {u.userId === '(anonymous)'
                      ? <span style={{ color: 'var(--text2)', fontStyle: 'italic', fontSize: 13 }}>(anonymous)</span>
                      : <span title={u.userId} style={{ fontFamily: 'var(--mono)', fontSize: 12, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.userId}</span>}
                  </div>
                  <div style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{u.count}</div>
                  <div><CostBadge cost={u.cost} /></div>
                  <div><LatencyBadge secs={u.avgLatency ?? undefined} /></div>
                  <div style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{relativeTime(u.lastSeen)}</div>
                </div>
              ))}
          </div>
        )}
    </div>
  );
}

// ─── Observations tab ─────────────────────────────────────────────────────────

function ObservationsTab() {
  const [obs, setObs] = useState<LangfuseObservation[]>([]);
  const [meta, setMeta] = useState<{ totalItems: number } | null>(null);
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState('');
  const [nameFilter, setNameFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sortKey, setSortKey] = useState<'startTime' | 'duration' | 'type'>('startTime');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const filters = {
        ...(typeFilter ? { type: typeFilter } : {}),
        ...(nameFilter ? { name: nameFilter } : {}),
      };
      const result = await api.langfuse.observations(50, page, filters);
      setObs(result.data ?? []);
      setMeta(result.meta);
    } catch (e) {
      setError(String(e));
    } finally { setLoading(false); }
  }, [page, typeFilter, nameFilter]);

  useEffect(() => { void load(); }, [load]);

  const totalPages = meta ? Math.ceil(meta.totalItems / 50) : 1;

  const sortedObs = useMemo(() => {
    const arr = [...obs];
    const dir = sortDir === 'asc' ? 1 : -1;
    if (sortKey === 'startTime') arr.sort((a, b) => dir * a.startTime.localeCompare(b.startTime));
    else if (sortKey === 'type') arr.sort((a, b) => dir * a.type.localeCompare(b.type));
    else if (sortKey === 'duration') {
      arr.sort((a, b) => {
        const da = a.startTime && a.endTime ? new Date(a.endTime).getTime() - new Date(a.startTime).getTime() : 0;
        const db = b.startTime && b.endTime ? new Date(b.endTime).getTime() - new Date(b.startTime).getTime() : 0;
        return dir * (da - db);
      });
    }
    return arr;
  }, [obs, sortKey, sortDir]);

  const handleSort = (k: typeof sortKey) => {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  };

  const colGrid = '120px 100px 1fr 200px 100px 80px 80px';

  return (
    <>
      <div className="stacked">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '12px 16px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          <select
            value={typeFilter}
            onChange={e => { setTypeFilter(e.target.value); setPage(1); }}
            aria-label="Filter by observation type"
            style={{ padding: '5px 8px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--font)' }}
          >
            <option value="">All types</option>
            <option value="GENERATION">GENERATION</option>
            <option value="SPAN">SPAN</option>
            <option value="EVENT">EVENT</option>
          </select>
          <input className="filter-input" placeholder="Filter by name…" value={nameFilter}
            onChange={e => setNameFilter(e.target.value)} onKeyDown={e => e.key === 'Enter' && load()}
            aria-label="Filter by observation name" style={{ width: 200 }} />
          <button className="btn btn-primary" onClick={load} disabled={loading}>{loading ? '…' : 'Search'}</button>
          <span style={{ fontSize: 12, color: 'var(--text2)', marginLeft: 'auto' }} aria-live="polite">
            {meta ? `${meta.totalItems.toLocaleString()} observations` : ''}
          </span>
          <button className="btn" onClick={load} disabled={loading} style={{ fontSize: 13 }}>↻</button>
        </div>

        {error && <div className="error-banner" role="alert">{error}</div>}

        {loading
          ? <div className="loading" role="status">Loading…</div>
          : (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {/* Header */}
              <div style={{ display: 'grid', gridTemplateColumns: colGrid, gap: '0 12px', padding: '7px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg)', position: 'sticky', top: 0, zIndex: 1, alignItems: 'center' }}>
                <div><SortButton label="When" active={sortKey === 'startTime'} dir={sortKey === 'startTime' ? sortDir : null} onClick={() => handleSort('startTime')} /></div>
                <div><SortButton label="Type" active={sortKey === 'type'} dir={sortKey === 'type' ? sortDir : null} onClick={() => handleSort('type')} /></div>
                <div style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Name</div>
                <div style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Trace</div>
                <div style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Model</div>
                <div style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Tokens</div>
                <div><SortButton label="Duration" active={sortKey === 'duration'} dir={sortKey === 'duration' ? sortDir : null} onClick={() => handleSort('duration')} /></div>
              </div>

              {sortedObs.length === 0
                ? <div className="empty">No observations found</div>
                : sortedObs.map(o => {
                  const durationMs = o.startTime && o.endTime ? new Date(o.endTime).getTime() - new Date(o.startTime).getTime() : null;
                  const [typeBg, typeColor] = OBS_COLORS[o.type] ?? ['var(--bg3)', 'var(--text2)'];
                  const totalTok = o.usageDetails ? Object.values(o.usageDetails).reduce((s, v) => s + v, 0) : null;
                  return (
                    <div key={o.id}
                      style={{ display: 'grid', gridTemplateColumns: colGrid, gap: '0 12px', padding: '9px 16px', borderBottom: '1px solid var(--border)', alignItems: 'center', fontSize: 12 }}
                      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg3)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = ''; }}
                    >
                      <div style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{relativeTime(o.startTime)}</div>
                      <div>
                        <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600, background: typeBg, color: typeColor }}>{o.type}</span>
                      </div>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>{o.name ?? <em style={{ color: 'var(--text2)' }}>unnamed</em>}</div>
                      <div style={{ minWidth: 0 }}>
                        <span title={o.traceId} style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                          {o.traceId.slice(0, 20)}…
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.model ?? '—'}</div>
                      <div style={{ fontSize: 11, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>{totalTok != null && totalTok > 0 ? formatTokens(totalTok) : '—'}</div>
                      <div style={{ fontSize: 11, color: durationMs != null && durationMs > 10000 ? 'var(--red)' : durationMs != null && durationMs > 3000 ? 'var(--yellow)' : 'var(--text2)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        {durationMs != null ? formatDuration(durationMs) : '—'}
                      </div>
                    </div>
                  );
                })}
            </div>
          )}

        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      </div>
    </>
  );
}

// ─── NativeEventRow ────────────────────────────────────────────────────────────

function NativeEventRow({ ev }: { ev: NativeEvent }) {
  const isAssistant = ev.type === 'assistant';

  if (ev.toolUse) {
    return (
      <details style={{ marginBottom: 5 }}>
        <summary style={{
          cursor: 'pointer', padding: '5px 10px', borderRadius: 4,
          background: 'rgba(88,166,255,0.07)', border: '1px solid rgba(88,166,255,0.15)',
          fontSize: 11, display: 'flex', alignItems: 'center', gap: 8,
          listStyle: 'none', userSelect: 'none',
        }}>
          <span style={{ fontSize: 9, opacity: 0.5 }}>▶</span>
          <span style={{ padding: '1px 5px', borderRadius: 3, background: 'rgba(88,166,255,0.15)', color: 'var(--accent)', fontSize: 10, fontWeight: 600 }}>TOOL</span>
          <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)', fontWeight: 600 }}>{ev.toolUse.name}</span>
          {ev.text && <span style={{ fontSize: 11, color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{ev.text.slice(0, 80)}</span>}
          <span style={{ fontSize: 10, color: 'var(--text2)', marginLeft: 'auto', flexShrink: 0 }}>{relativeTime(ev.timestamp)}</span>
        </summary>
        <div style={{ padding: '8px 10px', background: 'rgba(88,166,255,0.03)', borderRadius: '0 0 4px 4px', border: '1px solid rgba(88,166,255,0.1)', borderTop: 'none' }}>
          <pre style={{ margin: 0, fontSize: 11, fontFamily: 'var(--mono)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text)' }}>
            {JSON.stringify(ev.toolUse.input, null, 2)}
          </pre>
        </div>
      </details>
    );
  }

  if (ev.toolResult) {
    const content = ev.toolResult.content;
    const preview = typeof content === 'string'
      ? content.slice(0, 500)
      : JSON.stringify(content, null, 2).slice(0, 500);
    return (
      <details style={{ marginBottom: 5 }}>
        <summary style={{
          cursor: 'pointer', padding: '5px 10px', borderRadius: 4,
          background: 'rgba(188,140,255,0.06)', border: '1px solid rgba(188,140,255,0.12)',
          fontSize: 11, display: 'flex', alignItems: 'center', gap: 8,
          listStyle: 'none', userSelect: 'none',
        }}>
          <span style={{ fontSize: 9, opacity: 0.5 }}>▶</span>
          <span style={{ padding: '1px 5px', borderRadius: 3, background: 'rgba(188,140,255,0.15)', color: 'var(--purple)', fontSize: 10, fontWeight: 600 }}>RESULT</span>
          <span style={{ fontSize: 10, color: 'var(--text2)', marginLeft: 'auto', flexShrink: 0 }}>{relativeTime(ev.timestamp)}</span>
        </summary>
        <div style={{ padding: '8px 10px', background: 'rgba(188,140,255,0.03)', borderRadius: '0 0 4px 4px', border: '1px solid rgba(188,140,255,0.1)', borderTop: 'none' }}>
          <pre style={{ margin: 0, fontSize: 11, fontFamily: 'var(--mono)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text2)' }}>
            {preview}
          </pre>
        </div>
      </details>
    );
  }

  if (ev.text) {
    const style = isAssistant
      ? { bg: 'rgba(121,192,255,0.07)', border: 'rgba(121,192,255,0.15)', roleColor: '#79c0ff', role: 'ASSISTANT' }
      : { bg: 'rgba(88,166,255,0.07)', border: 'rgba(88,166,255,0.15)', roleColor: 'var(--accent)', role: 'USER' };
    return (
      <div style={{ marginBottom: 5, padding: '7px 10px', borderRadius: 4, background: style.bg, border: `1px solid ${style.border}` }}>
        <div style={{ fontSize: 9, color: style.roleColor, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
          <span>{style.role}</span>
          <span style={{ fontWeight: 400, opacity: 0.6 }}>{relativeTime(ev.timestamp)}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.65 }}>
          {ev.text.length > 800 ? ev.text.slice(0, 800) + '…' : ev.text}
        </div>
      </div>
    );
  }

  return null;
}

// ─── NativeSessionsTab ─────────────────────────────────────────────────────────

function NativeSessionsTab() {
  const [sessions, setSessions] = useState<NativeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [detail, setDetail] = useState<NativeSessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  useEffect(() => {
    api.native.sessions()
      .then(data => setSessions(data))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const toggleExpand = (jsonlPath: string) => {
    if (expandedPath === jsonlPath) {
      setExpandedPath(null);
      setDetail(null);
      return;
    }
    setExpandedPath(jsonlPath);
    setDetail(null);
    setDetailLoading(true);
    setDetailError('');
    api.native.session(btoa(jsonlPath))
      .then(d => setDetail(d))
      .catch(e => setDetailError(String(e)))
      .finally(() => setDetailLoading(false));
  };

  if (loading) return <div className="loading" role="status">Loading sessions…</div>;
  if (error) return <div className="error-banner" role="alert">{error}</div>;

  const SESSION_COLS = '150px 1fr 120px 80px 80px 80px';

  return (
    <div className="stacked">
      <div className="section-header">
        <span className="section-title">Claude Code Sessions</span>
        <span style={{ fontSize: 12, color: 'var(--text2)' }}>{sessions.length} sessions · from ~/.claude/projects/</span>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'grid', gridTemplateColumns: SESSION_COLS, gap: '0 12px', padding: '7px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg)', position: 'sticky', top: 0, zIndex: 1 }}>
          {(['Started', 'Project', 'Branch', 'Duration', 'Turns', 'Tools'] as const).map(h => (
            <div key={h} style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{h}</div>
          ))}
        </div>

        {sessions.length === 0
          ? <div className="empty">No sessions found in ~/.claude/projects/</div>
          : sessions.map(s => {
            const isExpanded = expandedPath === s.jsonlPath;
            const projName = s.cwd
              ? s.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? s.cwd
              : '—';
            const durationMs = s.startedAt && s.lastActivityAt
              ? new Date(s.lastActivityAt).getTime() - new Date(s.startedAt).getTime()
              : 0;

            return (
              <Fragment key={s.jsonlPath}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  onClick={() => toggleExpand(s.jsonlPath)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(s.jsonlPath); } }}
                  style={{
                    display: 'grid', gridTemplateColumns: SESSION_COLS, gap: '0 12px',
                    padding: '10px 16px', borderBottom: '1px solid var(--border)',
                    cursor: 'pointer', alignItems: 'center', fontSize: 12,
                    background: isExpanded ? 'rgba(88,166,255,0.04)' : undefined,
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg3)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = isExpanded ? 'rgba(88,166,255,0.04)' : ''; }}
                >
                  <div style={{ fontSize: 11, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ opacity: 0.4, fontSize: 9, userSelect: 'none' }} aria-hidden="true">{isExpanded ? '▼' : '▶'}</span>
                    {s.startedAt ? relativeTime(s.startedAt) : '—'}
                  </div>
                  <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500, color: 'var(--text)' }} title={s.cwd}>
                    {projName}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.gitBranch ?? '—'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>
                    {durationMs > 0 ? formatDuration(durationMs) : '—'}
                  </div>
                  <div style={{ fontVariantNumeric: 'tabular-nums' }}>{s.userTurns}</div>
                  <div style={{ fontVariantNumeric: 'tabular-nums', color: s.toolCalls > 0 ? 'var(--accent)' : 'var(--text2)' }}>{s.toolCalls}</div>
                </div>

                {isExpanded && (
                  <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                    {/* Chip row */}
                    <div style={{ padding: '8px 16px', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: 11, borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.015)' }}>
                      {durationMs > 0 && (
                        <span style={{ padding: '1px 7px', borderRadius: 10, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', color: 'var(--text2)' }}>
                          Duration: <span style={{ color: 'var(--text)', fontWeight: 600 }}>{formatDuration(durationMs)}</span>
                        </span>
                      )}
                      {s.gitBranch && (
                        <span style={{ padding: '1px 7px', borderRadius: 10, background: 'rgba(88,166,255,0.08)', border: '1px solid rgba(88,166,255,0.2)', color: 'var(--accent)', fontFamily: 'var(--mono)', fontSize: 10 }}>
                          {s.gitBranch}
                        </span>
                      )}
                      <span style={{ padding: '1px 7px', borderRadius: 10, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', color: 'var(--text2)' }}>
                        {s.toolCalls} tool calls
                      </span>
                      <span style={{ padding: '1px 7px', borderRadius: 10, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)', color: 'var(--text2)' }}>
                        {s.userTurns} user turns
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text2)', fontFamily: 'var(--mono)', marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 400 }} title={s.cwd}>
                        {s.cwd}
                      </span>
                    </div>

                    {/* Event timeline */}
                    {detailLoading && expandedPath === s.jsonlPath && (
                      <div className="loading" style={{ padding: '12px 16px' }}>Loading events…</div>
                    )}
                    {detailError && expandedPath === s.jsonlPath && (
                      <div className="error-banner" style={{ margin: '8px 16px' }}>{detailError}</div>
                    )}
                    {detail && detail.jsonlPath === s.jsonlPath && (
                      <div style={{ maxHeight: 420, overflowY: 'auto', padding: '10px 12px' }}>
                        {detail.events.length === 0
                          ? <div className="empty">No events recorded</div>
                          : detail.events.map(ev => <NativeEventRow key={ev.uuid} ev={ev} />)}
                      </div>
                    )}
                  </div>
                )}
              </Fragment>
            );
          })}
      </div>
    </div>
  );
}

// ─── LangfuseGateNotice ────────────────────────────────────────────────────────

function LangfuseGateNotice() {
  return (
    <div style={{ padding: '48px 24px', textAlign: 'center' }}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, color: 'var(--text2)' }}>
        Langfuse not configured
      </div>
      <div style={{ color: 'var(--text2)', fontSize: 13, marginBottom: 20 }}>
        Add credentials to{' '}
        <code style={{ fontFamily: 'var(--mono)', color: 'var(--accent)', background: 'var(--bg3)', padding: '2px 6px', borderRadius: 3 }}>
          ~/.nexus/config.json
        </code>{' '}
        to see LLM cost and token data.
      </div>
      <pre style={{ display: 'inline-block', textAlign: 'left', fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text2)', background: 'var(--bg3)', border: '1px solid var(--border)', padding: '12px 18px', borderRadius: 6, lineHeight: 1.7 }}>
{`{
  "langfuse": {
    "baseUrl": "https://cloud.langfuse.com",
    "publicKey": "pk-lf-...",
    "secretKey": "sk-lf-..."
  }
}`}
      </pre>
    </div>
  );
}

// ─── Observability (root) ─────────────────────────────────────────────────────

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'native', label: 'Sessions' },
  { id: 'traces', label: 'Traces' },
  { id: 'sessions', label: 'LF Sessions' },
  { id: 'observations', label: 'Observations' },
  { id: 'users', label: 'Users' },
];
const VALID_TABS = new Set<string>(TABS.map(t => t.id));

export function Observability() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab') ?? '';
  const tab: Tab = VALID_TABS.has(rawTab) ? (rawTab as Tab) : 'overview';
  const setTab = (t: Tab) => setSearchParams({ tab: t }, { replace: true });

  const [langfuseConfigured, setLangfuseConfigured] = useState<boolean>(false);

  useEffect(() => {
    api.langfuse.status().then(s => setLangfuseConfigured(s.configured)).catch(() => setLangfuseConfigured(false));
  }, []);

  return (
    <div className="stacked">
      <nav className="tab-nav" aria-label="Observability sections">
        {TABS.map(t => (
          <button key={t.id} className={`tab-btn${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
            {t.label}
          </button>
        ))}
      </nav>
      {tab === 'overview' && <OverviewTab langfuseConfigured={langfuseConfigured} />}
      {tab === 'native' && <NativeSessionsTab />}
      {tab === 'traces' && (langfuseConfigured ? <TracesTab /> : <LangfuseGateNotice />)}
      {tab === 'sessions' && (langfuseConfigured ? <SessionsTab /> : <LangfuseGateNotice />)}
      {tab === 'observations' && (langfuseConfigured ? <ObservationsTab /> : <LangfuseGateNotice />)}
      {tab === 'users' && (langfuseConfigured ? <UsersTab /> : <LangfuseGateNotice />)}
    </div>
  );
}

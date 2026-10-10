import React, { useEffect, useRef, useState } from 'react';
import type { DesktopState, TextMessage } from '../shared';

function dayKey(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'unknown' : [date.getFullYear(), date.getMonth() + 1, date.getDate()].join('-'); }
function dayLabel(value: string) {
  const date = new Date(value); if (Number.isNaN(date.getTime())) return '日期未知';
  const today = new Date(); const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (dayKey(value) === dayKey(today.toISOString())) return '今天';
  if (dayKey(value) === dayKey(yesterday.toISOString())) return '昨天';
  return date.toLocaleDateString('zh-CN', { ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' as const } : {}), month: 'long', day: 'numeric' });
}
function MetaIcon({ kind, label }: { kind: string; label: string }) {
  const paths: Record<string, string> = { phone: 'M6 2h8v16H6z M9 15h2', desktop: 'M2 3h16v11H2z M10 14v4 M6 18h8', delivered: 'M4 10l4 4 8-8', pending: 'M10 5v5l4 2', failed: 'M10 5v6 M10 14h.01' };
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={label}><title>{label}</title>{!['phone', 'desktop', 'delivered'].includes(kind) && <circle cx="10" cy="10" r="8"/>}<path d={paths[kind] || paths.pending}/></svg>;
}
function MessageBubble({ message: m, copied, onError }: { message: TextMessage; copied: () => void; onError: (text: string) => void }) {
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined); const origin = useRef({ x: 0, y: 0 });
  function cancelHold() { clearTimeout(hold.current); hold.current = undefined; }
  useEffect(() => () => cancelHold(), []);
  async function copy() { try { await window.desktop.copyText(m.id); copied(); } catch (error) { onError(String(error)); } }
  const date = new Date(m.createdAt); const time = Number.isNaN(date.getTime()) ? '--:--' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const stateLabel = m.state === 'delivered' ? m.source === 'desktop' ? '已送达' : '已接收' : m.state === 'failed' ? '发送失败' : '等待手机接收';
  return <article className={'message ' + m.source} tabIndex={0} aria-label={'消息：' + m.text} title="长按或右键复制全文"
    onPointerDown={event => { if (event.button !== 0 || (event.target as Element).closest('a,button')) return; cancelHold(); origin.current = { x: event.clientX, y: event.clientY }; hold.current = setTimeout(() => { hold.current = undefined; window.getSelection()?.removeAllRanges(); void copy(); }, 650); }}
    onPointerMove={event => { if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 8) cancelHold(); }} onPointerUp={cancelHold} onPointerCancel={cancelHold} onPointerLeave={cancelHold}
    onContextMenu={event => { if ((event.target as Element).closest('a')) return; event.preventDefault(); cancelHold(); void copy(); }}
    onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) { event.preventDefault(); void copy(); } }}>
    <pre>{m.text.split(new RegExp('(https?://[^\\s<>]+)', 'g')).map((part, i) => part.startsWith('http://') || part.startsWith('https://') ? <a href={part} key={i} onClick={event => { event.preventDefault(); void window.desktop.openTextLink(part).catch(error => onError(String(error))); }}>{part}</a> : part)}</pre>
    <div className="message-meta"><MetaIcon kind={m.source === 'phone' ? 'phone' : 'desktop'} label={m.source === 'phone' ? '来自手机' : '来自电脑'}/><time dateTime={m.createdAt}>{time}</time><span className={m.state === 'failed' ? 'message-failed' : ''}><MetaIcon kind={m.state} label={stateLabel}/></span></div>
  </article>;
}
export function TextPanel({ data, onError }: { data: DesktopState; onError: (text: string) => void }) {
  const [draft, setDraft] = useState(() => localStorage.getItem('text-draft') || ''); const [sending, setSending] = useState(false); const [notice, setNotice] = useState(false); const [copyNotice, setCopyNotice] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  function copied() { setCopyNotice(true); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopyNotice(false), 1800); }
  useEffect(() => { localStorage.setItem('text-draft', draft); }, [draft]);
  const list = useRef<HTMLDivElement>(null); const follow = useRef(true);
  const rows = [...data.messages].reverse();
  useEffect(() => { if (follow.current) list.current?.scrollTo({ top: list.current.scrollHeight }); else setNotice(true); }, [data.messages[0]?.id]);
  const valid = draft.trim().length > 0 && new TextEncoder().encode(draft).length <= 65536 && !!data.device && !sending;
  async function send() { if (!valid) return; setSending(true); try { await window.desktop.sendText(draft); setDraft(''); follow.current = true; } catch (error) { onError(String(error)); } finally { setSending(false); } }
  return <section className="card text-card"><div className="history-title"><div className="section-label">文本消息</div><button disabled={!rows.some(m => m.state === 'delivered')} onClick={() => void window.desktop.cleanMessages().catch(error => onError(String(error)))}>清理已送达</button></div>
    <div className="message-list" ref={list} onScroll={() => { const element = list.current!; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 30; if (follow.current) setNotice(false); }}>
      {!rows.length && <p className="muted">可发送文字、链接或代码片段。离线时保留，手机打开 App 后接收。</p>}
      {rows.map((m, index) => <React.Fragment key={m.id}>{(index === 0 || dayKey(m.createdAt) !== dayKey(rows[index - 1].createdAt)) && <div className="message-date">{dayLabel(m.createdAt)}</div>}<MessageBubble message={m} copied={copied} onError={onError}/></React.Fragment>)}
    </div>
    {notice && <button onClick={() => { follow.current = true; setNotice(false); list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }); }}>有新消息 · 查看</button>}
    <textarea aria-label="文本消息内容" value={draft} onChange={event => setDraft(event.target.value)} placeholder="输入文字、链接或代码；Ctrl+Enter 发送" rows={2} onKeyDown={event => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); void send(); } }}/>
    <div className="button-row"><button disabled={!valid} onClick={() => void send()}>{sending ? '正在发送…' : '发送'}</button><span className="muted">{new TextEncoder().encode(draft).length > 65536 ? '每条消息最多 64 KB' : 'Enter 换行 · Ctrl+Enter 发送'}</span></div>
    <div className={'message-copy-notice ' + (copyNotice ? 'visible' : '')} role="status">{copyNotice ? '已复制' : ''}</div>
  </section>;
}

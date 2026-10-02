import React, { useEffect, useRef, useState } from 'react';
import type { DesktopState } from '../shared';

export function TextPanel({ data, onError }: { data: DesktopState; onError: (text: string) => void }) {
  const [draft, setDraft] = useState(() => localStorage.getItem('text-draft') || ''); const [sending, setSending] = useState(false); const [notice, setNotice] = useState(false);
  useEffect(() => { localStorage.setItem('text-draft', draft); }, [draft]);
  const list = useRef<HTMLDivElement>(null); const follow = useRef(true);
  const rows = [...data.messages].reverse();
  useEffect(() => { if (follow.current) list.current?.scrollTo({ top: list.current.scrollHeight }); else setNotice(true); }, [data.messages[0]?.id]);
  const valid = draft.trim().length > 0 && new TextEncoder().encode(draft).length <= 65536 && !!data.device && !sending;
  async function send() { if (!valid) return; setSending(true); try { await window.desktop.sendText(draft); setDraft(''); follow.current = true; } catch (e) { onError(String(e)); } finally { setSending(false); } }
  return <section className="card text-card"><div className="history-title"><div className="section-label">文本消息</div><button onClick={() => void window.desktop.cleanMessages().catch(e => onError(String(e)))}>清理已送达</button></div>
    <div className="message-list" ref={list} onScroll={() => { const e = list.current!; follow.current = e.scrollHeight - e.scrollTop - e.clientHeight < 30; if (follow.current) setNotice(false); }}>
      {!rows.length && <p className="muted">可发送文字、链接或代码片段。离线时保留，手机打开 App 后接收。</p>}
      {rows.map(m => <article className={`message ${m.source}`} key={m.id}><p className="muted">{m.source === 'phone' ? '手机' : '电脑'} · {new Date(m.createdAt).toLocaleString('zh-CN')} · {m.state === 'delivered' ? '已送达' : '等待手机接收'}</p><pre>{m.text.split(/(https?:\/\/[^\s<>]+)/g).map((part, i) => /^https?:\/\//.test(part) ? <a href={part} key={i} onClick={e => { e.preventDefault(); void window.desktop.openTextLink(part).catch(error => onError(String(error))); }}>{part}</a> : part)}</pre><button onClick={() => void window.desktop.copyText(m.id).catch(e => onError(String(e)))}>复制</button></article>)}
    </div>
    {notice && <button onClick={() => { follow.current = true; setNotice(false); list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }); }}>有新消息 · 查看</button>}
    <textarea aria-label="文本消息内容" value={draft} onChange={e => setDraft(e.target.value)} placeholder="输入文字、链接或代码；Ctrl+Enter 发送" rows={3} onKeyDown={e => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); void send(); } }}/>
    <div className="button-row"><button disabled={!valid} onClick={() => void send()}>{sending ? '正在发送…' : '发送'}</button><span className="muted">{new TextEncoder().encode(draft).length > 65536 ? '每条消息最多 64 KB' : 'Enter 换行 · Ctrl+Enter 发送'}</span></div>
  </section>;
}

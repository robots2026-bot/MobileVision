import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopAPI, DesktopState } from '../shared';
import './style.css';
import { FileDropZone } from './FileDropZone';
import { TextPanel } from './TextPanel';
import { PhotoViewer } from './PhotoViewer';
declare global { interface Window { desktop: DesktopAPI; } }

function HeaderIcon({ kind }: { kind: 'photo' | 'file' | 'text' | 'folder' | 'chevron' }) {
  const paths = { photo: 'M3 3h18v18H3z M3 16l5-5 4 4 3-3 6 6 M16 7h.01', file: 'M6 3h8l4 4v14H6z M14 3v5h4', text: 'M4 4h16v13H9l-5 4z M8 8h8 M8 12h5', folder: 'M3 7V5h6l2 2h10v13H3z', chevron: 'M8 10l4 4 4-4' };
  return <svg className="header-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]}/></svg>;
}

function formatBytes(n: number) { return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`; }
function App() {
  const fileInputBusy = useRef(false);
  const historyStrip = useRef<HTMLDivElement>(null);
  const connectionDialog = useRef<HTMLDialogElement>(null);
  const selectionDrag = useRef<{ startX: number; startY: number; clientX: number; clientY: number; active: boolean; base: string[] } | undefined>(undefined);
  const suppressHistoryClick = useRef(false);
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number }>();
  const [largePreview, setLargePreview] = useState(() => localStorage.getItem('history-large-preview') !== 'off');
  const [hoverPhoto, setHoverPhoto] = useState<{ id: string; left: number; top: number }>();
  const [preparingFiles, setPreparingFiles] = useState(false);
  const [textPage, setTextPage] = useState(false);
  const [filesPage, setFilesPage] = useState(false);
  const [data, setData] = useState<DesktopState>();
  const [multi, setMulti] = useState(false); const [checked, setChecked] = useState<string[]>([]); const [deleting, setDeleting] = useState(false);
  const [historyPhoto, setHistoryPhoto] = useState<string>(); const [error, setError] = useState(''); const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    let alive = true; let generation = 0;
    const refresh = async () => { const request = ++generation; try { const next = await window.desktop.state(); if (alive && request === generation) setData(next); } catch (e) { if (alive) setError(String(e)); } };
    void refresh(); const unsubscribe = window.desktop.onChange(() => { void refresh(); });
    const timer = setInterval(() => setClock(Date.now()), 1000);
    const networkTimer = setInterval(() => { void refresh(); }, 5000);
    return () => { alive = false; unsubscribe(); clearInterval(timer); clearInterval(networkTimer); };
  }, []);
  useEffect(() => { if (!data) return; setChecked(ids => ids.filter(id => data.photos.some(p => p.id === id))); if (historyPhoto && !data.photos.some(p => p.id === historyPhoto)) setHistoryPhoto(undefined); }, [data?.photos]);
  useEffect(() => { setHistoryPhoto(undefined); historyStrip.current?.scrollTo({ left: 0 }); }, [data?.photos[0]?.id]);
  useEffect(() => {
    const preventNavigation = (event: DragEvent) => event.preventDefault();
    window.addEventListener('dragover', preventNavigation); window.addEventListener('drop', preventNavigation);
    return () => { window.removeEventListener('dragover', preventNavigation); window.removeEventListener('drop', preventNavigation); };
  }, []);
  useEffect(() => {
    if (!filesPage) return;
    const paste = (event: ClipboardEvent) => {
      if (connectionDialog.current?.open || event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]')) return;
      event.preventDefault(); void addFiles(window.desktop.pasteFiles);
    };
    document.addEventListener('paste', paste); return () => document.removeEventListener('paste', paste);
  }, [filesPage]);
  async function addFiles(fn: () => Promise<void>) {
    if (fileInputBusy.current) { setError('正在准备文件，请稍后再添加'); return; }
    fileInputBusy.current = true; setPreparingFiles(true);
    try { await act(fn); } finally { fileInputBusy.current = false; setPreparingFiles(false); }
  }
  useEffect(() => { setHoverPhoto(undefined); setSelectionBox(undefined); selectionDrag.current = undefined; }, [filesPage, textPage, data?.photos[0]?.id]);
  function startHistoryDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || deleting || e.clientY >= e.currentTarget.getBoundingClientRect().top + e.currentTarget.clientHeight) return;
    const r = e.currentTarget.getBoundingClientRect();
    // Leave ordinary clicks intact; capture only after the drag threshold.
    suppressHistoryClick.current = false; setHoverPhoto(undefined);
    selectionDrag.current = { startX: e.clientX - r.left + e.currentTarget.scrollLeft, startY: e.clientY - r.top, clientX: e.clientX, clientY: e.clientY, active: false, base: e.ctrlKey || e.metaKey || e.shiftKey ? [...checked] : [] };
  }
  function moveHistoryDrag(e: React.PointerEvent<HTMLDivElement>) {
    const drag = selectionDrag.current; if (!drag) return;
    if (!drag.active && Math.hypot(e.clientX - drag.clientX, e.clientY - drag.clientY) < 5) return;
    if (!drag.active) { drag.active = true; setMulti(true); e.currentTarget.setPointerCapture(e.pointerId); }
    e.preventDefault(); suppressHistoryClick.current = true;
    const strip = e.currentTarget; const r = strip.getBoundingClientRect();
    if (e.clientX < r.left + 24) strip.scrollLeft -= 14;
    else if (e.clientX > r.right - 24) strip.scrollLeft += 14;
    const x = Math.max(0, Math.min(strip.scrollWidth, e.clientX - r.left + strip.scrollLeft)); const y = Math.max(0, Math.min(strip.clientHeight, e.clientY - r.top));
    const box = { left: Math.min(drag.startX, x), top: Math.min(drag.startY, y), width: Math.abs(x - drag.startX), height: Math.abs(y - drag.startY) };
    const hits = [...strip.querySelectorAll<HTMLElement>('.thumbnail')].filter(node => { const n = node.getBoundingClientRect(); const left = n.left - r.left + strip.scrollLeft; const top = n.top - r.top; return left < box.left + box.width && left + n.width > box.left && top < box.top + box.height && top + n.height > box.top; }).map(node => node.dataset.photoId!);
    setSelectionBox(box); setChecked([...new Set([...drag.base, ...hits])]);
  }
  function finishHistoryDrag(e: React.PointerEvent<HTMLDivElement>) {
    selectionDrag.current = undefined; setSelectionBox(undefined);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }
  function showHistoryPreview(id: string, node: HTMLElement) {
    if (!largePreview || selectionDrag.current || deleting) return;
    const r = node.getBoundingClientRect(); setHoverPhoto({ id, left: Math.max(12, Math.min(window.innerWidth - 272, r.left + r.width / 2 - 130)), top: Math.max(56, r.top - 204) });
  }
  function toggle(id: string) { setChecked(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]); }
  async function removeSelected() { setDeleting(true); try { if (await window.desktop.deletePhotos(checked)) { setChecked([]); setMulti(false); } } catch (e) { setError(String(e)); } finally { setDeleting(false); setData(await window.desktop.state()); } }
  async function act(fn: () => Promise<void>) { try { setError(''); await fn(); setData(await window.desktop.state()); } catch (e) { setError(String(e).replace('Error: ', '')); } }
  const latestPhoto = data?.photos[0]; const inspected = data?.photos.find(p => p.id === historyPhoto); const photo = inspected || latestPhoto;
  const connected = !!data?.device && clock - data.device.lastSeen < 30_000;
  const seconds = Math.max(0, Math.ceil(((data?.pairing.expiresAt || 0) - clock) / 1000));
  const connectionPanel = data && <section className="connection"><div className="section-label">设备连接 <span className={`dot ${connected ? 'online' : ''}`}/></div>
          <h2>{data.device ? data.device.name : '连接你的手机'}</h2><p className="muted">{data.device ? connected ? '手机已连接，可以开始拍照' : '已配对，等待手机连接' : '打开 Android App，扫描下方二维码'}</p>
          {!data.device ? <><div className="qr"><img src={data.pairing.qr} alt="手机配对二维码"/>{seconds === 0 && <div className="qr-expired">二维码已过期</div>}</div><div className="pair-actions"><span>{seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 后过期` : '请刷新后重新扫码'}</span><button onClick={() => void act(window.desktop.refreshPairing)}>刷新二维码</button></div></> : <div className="paired"><span>✓</span><p>照片、文件与文本均可同步</p><details><summary>手机连接地址变化？</summary><div className="qr"><img src={data.pairing.qr} alt="更新电脑地址二维码"/></div><p>在已配对手机上点“扫码更新地址”</p></details><button onClick={() => void act(window.desktop.revoke)}>解除配对</button></div>}
          <div className="connection-settings"><label><input type="checkbox" checked={data.power.enabled} onChange={e => void act(() => window.desktop.setPowerEnabled(e.target.checked))}/> 允许已配对手机管理电脑电源</label><p className="network-tip">本次运行有效。息屏立即执行；其余操作确认后等待 5 秒。关闭开关可取消等待中的操作。</p>{data.power.job?.state === 'pending' && <p>电脑电源操作将在 {Math.max(0, Math.ceil((data.power.job.executeAt - clock) / 1000))} 秒后执行 <button onClick={() => void act(window.desktop.cancelPower)}>取消操作</button></p>}{data.power.job?.state === 'failed' && <p role="alert">电源操作失败，请检查系统电源设置或权限。</p>}</div>
          <details className="connection-settings"><summary>连接设置</summary><button onClick={() => void act(window.desktop.copyPairing)}>复制连接信息</button>
          <label className="field-label">电脑网络地址</label><select aria-label="电脑网络地址" value={data.selectedAddress} disabled={!data.addresses.length} onChange={e => void act(() => window.desktop.selectAddress(e.target.value))}>{(data.addresses.length ? data.addresses : ['127.0.0.1']).map(address => <option key={address} value={address}>{address}</option>)}</select>
          <p className="network-tip">{data.addresses.length ? '手机与电脑需在同一局域网。首次运行时，请允许 Windows 防火墙的专用网络访问。' : '未找到局域网地址，请先连接 Wi-Fi 或有线网络，再重新打开软件。'}</p></details>
        </section>;
  return <div className="app">
    <header><div className="brand" title="MobileVision · Windows 版"><span className="brand-icon">M</span><div><h1>MobileVision</h1></div></div><div className="button-row content-tabs"><button aria-pressed={!filesPage && !textPage} onClick={() => { setTextPage(false); setFilesPage(false); }}><HeaderIcon kind="photo"/>照片</button><button aria-pressed={filesPage} onClick={() => { setTextPage(false); setFilesPage(true); }}><HeaderIcon kind="file"/>文件</button><button aria-pressed={textPage} onClick={() => { setFilesPage(false); setTextPage(true); }}><HeaderIcon kind="text"/>文本</button></div><div className="header-actions">{data && !textPage && <details className="photo-storage"><summary title={filesPage ? '文件保存位置' : '照片保存位置'} aria-label={filesPage ? '文件保存位置' : '照片保存位置'}><HeaderIcon kind="folder"/></summary><div className="storage-panel"><div className="section-label">{filesPage ? '文件保存位置' : '照片保存位置'}</div><p className="directory" title={filesPage ? data.filesDirectory : data.directory}>{filesPage ? data.filesDirectory : data.directory}</p><div className="button-row"><button onClick={() => void act(filesPage ? window.desktop.chooseFilesDirectory : window.desktop.chooseDirectory)}>更改目录</button><button onClick={() => void act(filesPage ? window.desktop.openFilesDirectory : window.desktop.openDirectory)}>打开文件夹 ↗</button></div>{filesPage && <p className="muted">手机收到文件后保存在下载/MobileVision 文件夹。</p>}</div></details>}<button className="header-connection" onClick={() => connectionDialog.current?.showModal()} disabled={!data} title={data?.device && !connected ? '已断开，点击重新连接' : '连接设置'} aria-label="连接设置"><span className={`dot ${connected ? 'online' : ''}`}/><span className="device-status">{data?.device ? `${data.device.name} · ${connected ? '已连接' : '已断开'}` : '连接手机'}</span><HeaderIcon kind="chevron"/></button></div></header>
    {error || data?.error ? <div className="alert" role="alert">{error || data?.error}<button onClick={() => setError('')}>知道了</button></div> : null}
    {!data ? <div className="loading">正在启动照片接收服务…</div> : <main className="full-workspace">
      <div className="workspace">{!data.device && <div className="pairing-banner"><div><strong>连接手机，开始同步</strong><p>打开手机 App，扫码配对后即可传送照片、文件和文本。</p></div><button onClick={() => connectionDialog.current?.showModal()}>扫码配对</button></div>}
      {textPage ? <TextPanel data={data} onError={setError}/> : filesPage ? <section className="files-page"><div className="section-label">文件互传</div><div className="files-columns"><div className="card file-send-panel"><div className="section-label">发送到手机</div><FileDropZone paired={!!data.device} busy={preparingFiles} select={() => void addFiles(window.desktop.sendFiles)} paste={() => void addFiles(window.desktop.pasteFiles)} drop={files => void addFiles(() => window.desktop.sendDroppedFiles(files))} onError={setError}/></div><div className="card files-card"><div className="history-title"><div className="section-label">传输记录 <span className="count">{data.files.length}</span></div></div><div className="file-list">{data.files.length ? data.files.map(f => <div className="file-row" key={f.id}><div><strong title={f.name}>{f.name}</strong><p className="muted">{f.direction === "desktop" ? "电脑 → 手机" : "手机 → 电脑"} · {formatBytes(f.bytes)} · {f.state === 'ready' || f.state === 'sent' ? new Date(f.receivedAt).toLocaleString('zh-CN') : f.state === "canceled" ? "已取消" : `${f.direction === "desktop" ? "等待手机接收" : "接收中"} ${formatBytes(f.offset)} / ${formatBytes(f.bytes)}`}</p>{f.state === 'pending' && <progress value={f.offset} max={f.bytes || 1}/>}</div><div className="button-row"><button disabled={f.state !== 'ready' && f.state !== 'sent'} onClick={() => void act(() => window.desktop.openFile(f.id))}>打开</button><button disabled={f.state !== 'ready' && f.state !== 'sent'} onClick={() => void act(() => window.desktop.revealFile(f.id))}>定位</button>{f.direction === "desktop" && f.state === "pending" && <button onClick={() => void act(() => window.desktop.cancelSendFile(f.id))}>取消发送</button>}</div></div>) : <div className="files-empty"><p>还没有传输记录</p><span>拖入左侧区域发送文件，或从手机发送到电脑</span></div>}</div></div></div></section> : <><section className="card viewer-card">
        {photo ? <PhotoViewer key={photo.id} photo={photo} onError={setError}/> : <div className="viewer"><div className="empty"><h3>等待第一张照片</h3><p>手机拍照后会自动显示在这里</p></div></div>}
      </section>
      <section className="card history"><div className="history-title"><div className="section-label">最近接收 <span className="count">{data.photos.length}</span></div><div className="button-row"><label className="preview-switch"><input type="checkbox" role="switch" aria-label="大预览" checked={largePreview} onChange={e => { const enabled = e.target.checked; setLargePreview(enabled); localStorage.setItem('history-large-preview', enabled ? 'on' : 'off'); setHoverPhoto(undefined); }}/><span>大预览</span></label>{multi ? <><span>已选 {checked.length} 张</span><button disabled={deleting} onClick={() => setChecked(data.photos.map(p => p.id))}>全选当前列表</button><button disabled={deleting || !checked.length} className="danger" onClick={() => void removeSelected()}>{deleting ? "正在删除…" : "删除所选"}</button><button disabled={deleting} onClick={() => { setMulti(false); setChecked([]); }}>取消多选</button></> : <button disabled={!data.photos.length} onClick={() => setMulti(true)}>多选删除</button>}</div></div><div className={'thumbnails ' + (selectionBox ? 'selecting' : '')} ref={historyStrip} onPointerDown={startHistoryDrag} onPointerMove={moveHistoryDrag} onPointerUp={finishHistoryDrag} onPointerCancel={finishHistoryDrag} onLostPointerCapture={() => { selectionDrag.current = undefined; setSelectionBox(undefined); }} onPointerLeave={() => setHoverPhoto(undefined)} onClickCapture={e => { if (suppressHistoryClick.current) { e.preventDefault(); e.stopPropagation(); suppressHistoryClick.current = false; } }} onDragStart={e => e.preventDefault()} onKeyDown={e => { if (e.key === 'Escape') { setMulti(false); setChecked([]); setHoverPhoto(undefined); } else if (e.key === 'Delete' && multi && checked.length && !deleting) { e.preventDefault(); void removeSelected(); } }} aria-label="照片记录，滚轮浏览，左键拖动框选" onWheel={e => { if (!e.ctrlKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { const factor = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? e.currentTarget.clientWidth : 1; e.currentTarget.scrollLeft += e.deltaY * factor; } }}>{data.photos.length ? data.photos.map((p, index) => { const selected = multi ? checked.includes(p.id) : p.id === photo?.id; return <button key={p.id} data-photo-id={p.id} onPointerEnter={e => showHistoryPreview(p.id, e.currentTarget)} onFocus={e => showHistoryPreview(p.id, e.currentTarget)} onBlur={() => setHoverPhoto(undefined)} className={`thumbnail ${selected ? 'selected' : ''}`} disabled={deleting} aria-pressed={selected} onClick={() => { if (multi) { toggle(p.id); return; } setHistoryPhoto(index === 0 ? undefined : p.id); }} title={`${p.deviceName} · ${p.filename}`}><>{multi && <span className="selection-mark">{checked.includes(p.id) ? "☑" : "☐"}</span>}</><img draggable={false} loading="lazy" src={`mv-photo://thumb/${p.id}`} alt="已接收照片"/><span>{new Date(p.receivedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span></button>; }) : <p className="muted no-history">接收到的照片会排列在这里</p>}{selectionBox && <div className="history-selection-box" style={selectionBox}/>}</div>{largePreview && hoverPhoto && data.photos.some(p => p.id === hoverPhoto.id) && <div className="history-hover-preview" style={{ left: hoverPhoto.left, top: hoverPhoto.top }}><img src={`mv-photo://image/${hoverPhoto.id}`} alt="照片放大预览"/></div>}</section>
      </>}
      </div>
    </main>}
    <dialog ref={connectionDialog} className="connection-dialog" aria-labelledby="connection-title" onClick={e => { if (e.target === connectionDialog.current) { const r = connectionDialog.current.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) connectionDialog.current.close(); } }}><div className="dialog-heading"><h2 id="connection-title">连接手机</h2><button aria-label="关闭连接设置" onClick={() => connectionDialog.current?.close()}>✕</button></div>{data && connectionPanel}<div className="dialog-bottom"><button onClick={() => void act(window.desktop.exportDiagnostics)}>导出诊断日志</button></div></dialog>

    <footer><span><span className={`dot ${data?.running ? 'online' : ''}`}/>{data?.running ? '接收服务已就绪' : '正在启动'}</span><span>MobileVision · Windows 版</span></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);

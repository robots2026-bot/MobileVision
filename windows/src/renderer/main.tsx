import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopAPI, DesktopState } from '../shared';
import './style.css';
import { FileDropZone } from './FileDropZone';
import { TextPanel } from './TextPanel';
import { PhotoViewer } from './PhotoViewer';
declare global { interface Window { desktop: DesktopAPI; } }

function formatBytes(n: number) { return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`; }
function App() {
  const fileInputBusy = useRef(false);
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
  useEffect(() => { setHistoryPhoto(undefined); }, [data?.photos[0]?.id]);
  useEffect(() => {
    const preventNavigation = (event: DragEvent) => event.preventDefault();
    window.addEventListener('dragover', preventNavigation); window.addEventListener('drop', preventNavigation);
    return () => { window.removeEventListener('dragover', preventNavigation); window.removeEventListener('drop', preventNavigation); };
  }, []);
  useEffect(() => {
    if (!filesPage) return;
    const paste = (event: ClipboardEvent) => {
      if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]')) return;
      event.preventDefault(); void addFiles(window.desktop.pasteFiles);
    };
    document.addEventListener('paste', paste); return () => document.removeEventListener('paste', paste);
  }, [filesPage]);
  async function addFiles(fn: () => Promise<void>) {
    if (fileInputBusy.current) { setError('正在准备文件，请稍后再添加'); return; }
    fileInputBusy.current = true; setPreparingFiles(true);
    try { await act(fn); } finally { fileInputBusy.current = false; setPreparingFiles(false); }
  }
  function toggle(id: string) { setChecked(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]); }
  async function removeSelected() { setDeleting(true); try { if (await window.desktop.deletePhotos(checked)) { setChecked([]); setMulti(false); } } catch (e) { setError(String(e)); } finally { setDeleting(false); setData(await window.desktop.state()); } }
  async function act(fn: () => Promise<void>) { try { setError(''); await fn(); setData(await window.desktop.state()); } catch (e) { setError(String(e).replace('Error: ', '')); } }
  const latestPhoto = data?.photos[0]; const inspected = data?.photos.find(p => p.id === historyPhoto); const photo = inspected || latestPhoto;
  const connected = !!data?.device && clock - data.device.lastSeen < 30_000;
  const seconds = Math.max(0, Math.ceil(((data?.pairing.expiresAt || 0) - clock) / 1000));
  return <div className="app">
    <header><div className="brand"><span className="brand-icon">M</span><div><h1>MobileVision</h1><p>手机拍摄 · 电脑即刻查看</p></div></div><span className="local-badge">局域网传输 · 原图保存</span></header>
    {error || data?.error ? <div className="alert" role="alert">{error || data?.error}<button onClick={() => setError('')}>知道了</button></div> : null}
    {!data ? <div className="loading">正在启动照片接收服务…</div> : <main>
      <aside>
        <section className="card connection"><div className="section-label">设备连接 <span className={`dot ${connected ? 'online' : ''}`}/></div>
          <h2>{data.device ? data.device.name : '连接你的手机'}</h2><p className="muted">{data.device ? connected ? '手机已连接，可以开始拍照' : '已配对，等待手机连接' : '打开 Android App，扫描下方二维码'}</p>
          {!data.device ? <><div className="qr"><img src={data.pairing.qr} alt="手机配对二维码"/>{seconds === 0 && <div className="qr-expired">二维码已过期</div>}</div><div className="pair-actions"><span>{seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 后过期` : '请刷新后重新扫码'}</span><button onClick={() => void act(window.desktop.refreshPairing)}>刷新二维码</button></div></> : <div className="paired"><span>✓</span><p>照片会自动出现在右侧</p><details><summary>手机连接地址变化？</summary><div className="qr"><img src={data.pairing.qr} alt="更新电脑地址二维码"/></div><p>在已配对手机上点“扫码更新地址”</p></details><button onClick={() => void act(window.desktop.revoke)}>解除配对</button></div>}
          <button onClick={() => void act(window.desktop.copyPairing)}>复制连接信息</button>
          <label className="field-label">电脑网络地址</label><select aria-label="电脑网络地址" value={data.selectedAddress} disabled={!data.addresses.length} onChange={e => void act(() => window.desktop.selectAddress(e.target.value))}>{(data.addresses.length ? data.addresses : ['127.0.0.1']).map(address => <option key={address} value={address}>{address}</option>)}</select>
          <p className="network-tip">{data.addresses.length ? '手机与电脑需在同一局域网。首次运行时，请允许 Windows 防火墙的专用网络访问。' : '未找到局域网地址，请先连接 Wi-Fi 或有线网络，再重新打开软件。'}</p>
        </section>
        <section className="card"><div className="section-label">照片保存位置</div><p className="directory" title={data.directory}>{data.directory}</p><div className="button-row"><button onClick={() => void act(window.desktop.chooseDirectory)}>更改目录</button><button onClick={() => void act(window.desktop.openDirectory)}>打开文件夹 ↗</button></div></section>
        <div className="small-note">手机拍照后自动传输原图。电脑保存成功，手机才会收到确认。</div><button onClick={() => void act(window.desktop.exportDiagnostics)}>导出诊断日志</button>
      </aside>
      <div className="workspace"><div className="button-row content-tabs"><button aria-pressed={!filesPage && !textPage} onClick={() => { setTextPage(false); setFilesPage(false); }}>照片</button><button aria-pressed={filesPage} onClick={() => { setTextPage(false); setFilesPage(true); }}>文件</button><button aria-pressed={textPage} onClick={() => { setFilesPage(false); setTextPage(true); }}>文本</button></div>
      {textPage ? <TextPanel data={data} onError={setError}/> : filesPage ? <section className="card files-card"><div className="section-label">文件互传</div><FileDropZone paired={!!data.device} busy={preparingFiles} select={() => void addFiles(window.desktop.sendFiles)} paste={() => void addFiles(window.desktop.pasteFiles)} drop={files => void addFiles(() => window.desktop.sendDroppedFiles(files))} onError={setError}/><p className="directory">{data.filesDirectory}</p><div className="button-row"><button onClick={() => void act(window.desktop.chooseFilesDirectory)}>更改保存目录</button><button onClick={() => void act(window.desktop.openFilesDirectory)}>打开文件夹</button></div><p className="muted">两端均可选择文件发送。手机收到后保存到下载目录的 MobileVision 文件夹。</p>{data.files.length ? data.files.map(f => <div className="file-row" key={f.id}><div><strong title={f.name}>{f.name}</strong><p className="muted">{f.direction === "desktop" ? "电脑 → 手机" : "手机 → 电脑"} · {formatBytes(f.bytes)} · {f.state === 'ready' || f.state === 'sent' ? new Date(f.receivedAt).toLocaleString('zh-CN') : f.state === "canceled" ? "已取消" : `${f.direction === "desktop" ? "等待手机接收" : "接收中"} ${formatBytes(f.offset)} / ${formatBytes(f.bytes)}`}</p>{f.state === 'pending' && <progress value={f.offset} max={f.bytes || 1}/>}</div><div className="button-row"><button disabled={f.state !== 'ready' && f.state !== 'sent'} onClick={() => void act(() => window.desktop.openFile(f.id))}>打开</button><button disabled={f.state !== 'ready' && f.state !== 'sent'} onClick={() => void act(() => window.desktop.revealFile(f.id))}>定位</button>{f.direction === "desktop" && f.state === "pending" && <button onClick={() => void act(() => window.desktop.cancelSendFile(f.id))}>取消发送</button>}</div></div>) : <p className="muted">还没有收到文件</p>}</section> : <><section className="card viewer-card">
        {photo ? <PhotoViewer key={photo.id} photo={photo} onError={setError}/> : <div className="viewer"><div className="empty"><h3>等待第一张照片</h3><p>手机拍照后会自动显示在这里</p></div></div>}
      </section>
      <section className="card history"><div className="history-title"><div className="section-label">最近接收 <span className="count">{data.photos.length}</span></div><div className="button-row">{multi ? <><span>已选 {checked.length} 张</span><button disabled={deleting} onClick={() => setChecked(data.photos.map(p => p.id))}>全选当前列表</button><button disabled={deleting || !checked.length} className="danger" onClick={() => void removeSelected()}>{deleting ? "正在删除…" : "删除所选"}</button><button disabled={deleting} onClick={() => { setMulti(false); setChecked([]); }}>取消多选</button></> : <button disabled={!data.photos.length} onClick={() => setMulti(true)}>多选删除</button>}</div></div><div className="thumbnails">{data.photos.length ? data.photos.map((p, index) => { const selected = multi ? checked.includes(p.id) : p.id === photo?.id; return <button key={p.id} className={`thumbnail ${selected ? 'selected' : ''}`} disabled={deleting} aria-pressed={selected} onClick={() => { if (multi) { toggle(p.id); return; } setHistoryPhoto(index === 0 ? undefined : p.id); }} title={`${p.deviceName} · ${p.filename}`}><>{multi && <span className="selection-mark">{checked.includes(p.id) ? "☑" : "☐"}</span>}</><img loading="lazy" src={`mv-photo://thumb/${p.id}`} alt="已接收照片"/><span>{new Date(p.receivedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span></button>; }) : <p className="muted no-history">接收到的照片会排列在这里</p>}</div></section>
      </>}
      </div>
    </main>}
    <footer><span><span className={`dot ${data?.running ? 'online' : ''}`}/>{data?.running ? '接收服务已就绪' : '正在启动'}</span><span>MobileVision · Windows 版 0.2.1</span></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);

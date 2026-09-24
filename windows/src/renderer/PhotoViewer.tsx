import React, { useEffect, useRef, useState } from 'react';
import type { Photo } from '../shared';
type Point = { x: number; y: number };
type Region = { a: Point; b: Point };
type Corner = 'nw' | 'ne' | 'sw' | 'se';
type Drag = { mode: 'pan'; start: Point; x: number; y: number } | { mode: 'draw'; start: Point } | { mode: 'move'; start: Point; region: Region } | { mode: 'resize'; fixed: Point };
export function PhotoViewer({ photo, onError }: { photo: Photo; onError: (message: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const [view, setView] = useState({ scale: 0, x: 0, y: 0 });
  const [crop, setCrop] = useState(false); const [region, setRegion] = useState<Region>();
  const [saving, setSaving] = useState(false); const [message, setMessage] = useState(''); const [loaded, setLoaded] = useState(false);
  const [movingRegion, setMovingRegion] = useState(false);
  const drag = useRef<Drag | null>(null);
  useEffect(() => { const observer = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height })); observer.observe(host.current!); return () => observer.disconnect(); }, []);
  const fit = Math.min(size.w / photo.width, size.h / photo.height, 1);
  const scale = view.scale || fit;
  function bounded(v: typeof view) { const z = v.scale || fit; return { ...v, x: Math.max(-Math.max(0, (photo.width * z - size.w) / 2), Math.min(Math.max(0, (photo.width * z - size.w) / 2), v.x)), y: Math.max(-Math.max(0, (photo.height * z - size.h) / 2), Math.min(Math.max(0, (photo.height * z - size.h) / 2), v.y)) }; }
  const actual = bounded(view); const left = (size.w - photo.width * scale) / 2 + actual.x; const top = (size.h - photo.height * scale) / 2 + actual.y;
  function point(event: { clientX: number; clientY: number }) { const rect = host.current!.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
  function imagePoint(p: Point) { return { x: Math.max(0, Math.min(photo.width, (p.x - left) / scale)), y: Math.max(0, Math.min(photo.height, (p.y - top) / scale)) }; }
  const wheel = useRef<(e: WheelEvent) => void>(() => {});
  wheel.current = e => { e.preventDefault(); if (crop || saving || !loaded) return; const p = point(e); const next = Math.max(Math.min(fit, 0.1), Math.min(8, scale * Math.exp(-Math.max(-300, Math.min(300, e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.h : 1))) * 0.002))); setView(bounded({ scale: next, x: p.x - size.w / 2 - (p.x - size.w / 2 - actual.x) * next / scale, y: p.y - size.h / 2 - (p.y - size.h / 2 - actual.y) * next / scale })); };
  useEffect(() => { const element = host.current!; const listener = (e: WheelEvent) => wheel.current(e); element.addEventListener('wheel', listener, { passive: false }); return () => element.removeEventListener('wheel', listener); }, []);
  const validRegion = !!region && Math.abs(region.a.x - region.b.x) >= 1 && Math.abs(region.a.y - region.b.y) >= 1;
  function cropRegion() { if (!region) throw new Error('请先框选截图区域'); return { x: Math.min(region.a.x, region.b.x), y: Math.min(region.a.y, region.b.y), width: Math.abs(region.a.x - region.b.x), height: Math.abs(region.a.y - region.b.y) }; }
  function insideRegion(p: Point) { if (!region) return false; const image = imagePoint(p); return image.x >= Math.min(region.a.x, region.b.x) && image.x <= Math.max(region.a.x, region.b.x) && image.y >= Math.min(region.a.y, region.b.y) && image.y <= Math.max(region.a.y, region.b.y); }
  function oppositeCorner(corner: Corner, value: Region): Point {
    const minX = Math.min(value.a.x, value.b.x), maxX = Math.max(value.a.x, value.b.x), minY = Math.min(value.a.y, value.b.y), maxY = Math.max(value.a.y, value.b.y);
    return { x: corner.includes('w') ? maxX : minX, y: corner.includes('n') ? maxY : minY };
  }
  async function save() { if (!validRegion) return; setSaving(true); try { const result = await window.desktop.saveCrop(photo.id, cropRegion()); if (result) { setMessage('截图已保存：' + result); setCrop(false); setRegion(undefined); setMovingRegion(false); } } catch (error) { onError(String(error)); } finally { setSaving(false); } }
  async function copy() { if (!validRegion) return; setSaving(true); try { await window.desktop.copyCrop(photo.id, cropRegion()); setMessage('截图已复制到剪贴板'); setCrop(false); setRegion(undefined); setMovingRegion(false); drag.current = null; } catch (error) { onError(String(error)); } finally { setSaving(false); } }
  function moveRegion(original: Region, dx: number, dy: number): Region {
    const minX = Math.min(original.a.x, original.b.x), maxX = Math.max(original.a.x, original.b.x), minY = Math.min(original.a.y, original.b.y), maxY = Math.max(original.a.y, original.b.y);
    const safeX = Math.max(-minX, Math.min(photo.width - maxX, dx)); const safeY = Math.max(-minY, Math.min(photo.height - maxY, dy));
    return { a: { x: original.a.x + safeX, y: original.a.y + safeY }, b: { x: original.b.x + safeX, y: original.b.y + safeY } };
  }
  return <><div ref={host} className={'viewer interactive-viewer ' + (crop ? 'cropping ' : '') + (movingRegion ? 'moving-region' : '')} tabIndex={0} aria-label="照片预览：右键进入截图；滚轮缩放；按住鼠标左键拖动" onContextMenu={e => { e.preventDefault(); if (!loaded || saving) return; if (crop) {
    setCrop(false); setRegion(undefined); setMessage(''); setMovingRegion(false); drag.current = null; return;
  }
  setCrop(true); setMessage('拖动鼠标框选截图区域；右键任意位置退出'); host.current?.focus(); }} onKeyDown={e => { if (e.key === 'Escape') { setCrop(false); setRegion(undefined); setMovingRegion(false); drag.current = null; } }} onDoubleClick={e => { if (!crop) setView({ scale: 0, x: 0, y: 0 }); else if (insideRegion(point(e))) void copy(); }} onPointerDown={e => { if (e.button !== 0 || saving || !loaded) return; const p = point(e); if (crop) {
    if (p.x < left || p.y < top || p.x > left + photo.width * scale || p.y > top + photo.height * scale) return;
    e.currentTarget.setPointerCapture(e.pointerId); setMessage('');
    const corner = (e.target as HTMLElement).closest<HTMLElement>('[data-corner]')?.dataset.corner as Corner | undefined;
    if (region && corner) { drag.current = { mode: 'resize', fixed: oppositeCorner(corner, region) }; setMovingRegion(false); }
    else if (region && insideRegion(p)) { drag.current = { mode: 'move', start: p, region: { a: { ...region.a }, b: { ...region.b } } }; setMovingRegion(true); }
    else { drag.current = { mode: 'draw', start: p }; setMovingRegion(false); setRegion({ a: imagePoint(p), b: imagePoint(p) }); }
  } else { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { mode: 'pan', start: p, x: actual.x, y: actual.y }; } }} onPointerMove={e => { const current = drag.current; if (!current) return; const p = point(e); if (current.mode === 'draw') setRegion(r => r && ({ ...r, b: imagePoint(p) })); else if (current.mode === 'move') setRegion(moveRegion(current.region, (p.x - current.start.x) / scale, (p.y - current.start.y) / scale)); else if (current.mode === 'resize') setRegion({ a: current.fixed, b: imagePoint(p) }); else setView(bounded({ scale, x: current.x + p.x - current.start.x, y: current.y + p.y - current.start.y })); }} onPointerUp={() => { drag.current = null; setMovingRegion(false); }} onPointerCancel={() => { drag.current = null; setMovingRegion(false); }} onLostPointerCapture={() => { drag.current = null; setMovingRegion(false); }}>
    <img draggable={false} src={'mv-photo://image/' + photo.id} alt={photo.filename} onLoad={() => setLoaded(true)} onError={() => onError('无法打开照片，原文件可能已被移动或删除。')} style={{ position: 'absolute', width: photo.width * scale, height: photo.height * scale, left, top, maxWidth: 'none', maxHeight: 'none' }}/>
    {crop && !region && <div className="crop-mask"/ >}
    {crop && region && <div className={'crop-region ' + (movingRegion ? 'moving' : '')} style={{ left: left + Math.min(region.a.x, region.b.x) * scale, top: top + Math.min(region.a.y, region.b.y) * scale, width: Math.abs(region.a.x - region.b.x) * scale, height: Math.abs(region.a.y - region.b.y) * scale }}><i className="crop-handle nw" data-corner="nw"/><i className="crop-handle ne" data-corner="ne"/><i className="crop-handle sw" data-corner="sw"/><i className="crop-handle se" data-corner="se"/></div>}
  </div><div className="photo-toolbar"><span>{Math.round(scale * 100)}% · {crop ? '框外拖动重新框选 · 框内拖动调整位置 · 双击框复制并退出 · 右键任意位置退出' : '右键截图 · 滚轮缩放 · 拖动平移 · 双击适应窗口'}</span><div><button disabled={saving} onClick={() => { setView({ scale: 0, x: 0, y: 0 }); setRegion(undefined); }}>适应窗口</button><button disabled={saving || crop} onClick={() => setView({ scale: 1, x: 0, y: 0 })}>100%</button><button disabled={!loaded || saving} onClick={() => { setCrop(!crop); setRegion(undefined); setMovingRegion(false); setMessage(''); }}>{crop ? '取消截图' : '截图'}</button>{crop && <button className="save-crop-icon" aria-label="保存 PNG" title="保存 PNG" disabled={saving || !validRegion} onClick={() => void save()}><svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 3h14l3 3v15H3V3h1Z"/><path d="M7 3v7h10V3M7 21v-8h10v8"/></svg></button>}<button onClick={() => void window.desktop.revealPhoto(photo.id).catch(e => onError(String(e)))}>定位文件 ↗</button></div></div>{message && <div className="capture-message" role="status">{message}</div>}</>;
}

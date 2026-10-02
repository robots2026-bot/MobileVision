import React, { useState } from 'react';

export function FileDropZone({ paired, busy, select, paste, drop, onError }: { paired: boolean; busy: boolean; select: () => void; paste: () => void; drop: (files: File[]) => void; onError: (text: string) => void }) {
  const [dragging, setDragging] = useState(false);
  return <div className={`file-dropzone ${dragging ? 'dragging' : ''}`} tabIndex={0} role="region" aria-label="文件发送区"
    onDragEnter={e => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) setDragging(true); }}
    onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = paired && !busy ? 'copy' : 'none'; }}
    onDragLeave={e => { if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
    onDrop={e => { e.preventDefault(); e.stopPropagation(); setDragging(false); if (busy) { onError('正在准备文件，请稍后再添加'); return; } if (!paired) { onError('请先配对手机'); return; } const files = Array.from(e.dataTransfer.files); if (!files.length) { onError('请拖入磁盘上的文件，文字请到“文本”页发送'); return; } drop(files); }}>
    <strong>{busy ? '正在准备文件…' : dragging ? '松开发送到手机' : '拖入文件，或按 Ctrl+V 粘贴文件'}</strong>
    <p className="muted">{paired ? '支持多选 · 单文件最大 2 GB · 加入后自动发送' : '先配对手机，即可双向传输文件'}</p>
    <div className="button-row"><button disabled={!paired || busy} onClick={select}>选择文件发送到手机</button><button disabled={!paired || busy} onClick={paste}>粘贴文件</button></div>
  </div>;
}

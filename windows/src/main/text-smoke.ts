import { app, BrowserWindow, clipboard, ClipboardItem, nativeTheme } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Receiver } from './receiver';

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFor(win: BrowserWindow, expression: string) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await win.webContents.executeJavaScript(expression)) return; await delay(100); }
  throw new Error('Text UI timeout: ' + expression);
}
export async function runTextSmoke(receiver: Receiver, win: BrowserWindow) {
  const savedClipboard = await Promise.all((await clipboard.read()).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  try {
    await mkdir('test-results', { recursive: true });
    win.setSize(1000, 700); win.show();
    const today = new Date(); today.setHours(10, 20, 0, 0); const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const samples = [
      { source: 'phone', state: 'delivered', text: '你好，昨天的消息。', time: yesterday },
      { source: 'phone', state: 'delivered', text: '代码与链接：\nhttps://example.com\nconst value = 42;', time: today },
      { source: 'desktop', state: 'delivered', text: '收到，电脑回复。', time: today },
      { source: 'desktop', state: 'pending', text: 'LongCodeWithoutSpaces_'.repeat(30), time: today }
    ];
    const db = new DatabaseSync(path.join(app.getPath('userData'), 'messages.sqlite'));
    try { for (const sample of samples) db.prepare('INSERT INTO messages(id,deviceId,text,hash,source,state,createdAt) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), 'ui-test', sample.text, 'ui-test', sample.source, sample.state, sample.time.toISOString()); } finally { db.close(); }
    receiver.emit('change');
    await waitFor(win, "document.querySelector('.content-tabs button:last-child') !== null");
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.content-tabs button')].find(b => b.textContent === '文本').click()");
    await waitFor(win, "document.querySelectorAll('.message').length === 4");
    const layout = await win.webContents.executeJavaScript("(() => { const list = document.querySelector('.message-list'); const messages = [...document.querySelectorAll('.message')]; return { dates: document.querySelectorAll('.message-date').length, shortTimes: messages.every(m => /^\\d{2}:\\d{2}$/.test(m.querySelector('time').textContent)), noCopyButtons: messages.every(m => !m.querySelector('button')), noHorizontalOverflow: list.scrollWidth <= list.clientWidth + 1, bubbleBounds: messages.every(m => m.getBoundingClientRect().width <= list.clientWidth * .8 + 1), links: document.querySelectorAll('.message a').length }; })()");
    if (layout.dates !== 2 || !layout.shortTimes || !layout.noCopyButtons || !layout.noHorizontalOverflow || !layout.bubbleBounds || layout.links !== 1) throw new Error('Text layout checks failed: ' + JSON.stringify(layout));
    for (const theme of ['light', 'dark'] as const) {
      nativeTheme.themeSource = theme; await delay(200);
      await win.webContents.executeJavaScript("document.querySelector('.message-list').scrollTop = 0");
      await delay(150);
      await writeFile('test-results/windows-text-' + theme + '.png', (await win.webContents.capturePage()).toPNG());
    }
    nativeTheme.themeSource = 'light';
    await win.webContents.executeJavaScript("document.querySelector('.message-list').scrollTop = 0");
    const target = await win.webContents.executeJavaScript("(() => { const r = document.querySelector('.message pre').getBoundingClientRect(); return { x: Math.round(r.left + 12), y: Math.round(r.top + 10) }; })()");
    await clipboard.writeText('drag must not copy');
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...target });
    win.webContents.sendInputEvent({ type: 'mouseMove', x: target.x + 20, y: target.y }); await delay(750);
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: target.x + 20, y: target.y });
    if (await clipboard.readText() !== 'drag must not copy') throw new Error('Drag unexpectedly copied message');
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...target }); await delay(800);
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...target });
    if (await clipboard.readText() !== samples[0].text) throw new Error('Long press did not copy full message');
    await clipboard.writeText('right click test');
    await win.webContents.executeJavaScript("document.querySelector('.message').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))"); await delay(100);
    if (await clipboard.readText() !== samples[0].text) throw new Error('Right click did not copy full message');
    await writeFile('test-results/windows-text-smoke.json', JSON.stringify({ ...layout, longPressCopies: true, dragDoesNotCopy: true, rightClickCopies: true }, null, 2));
  } finally { await clipboard.write(savedClipboard); nativeTheme.themeSource = 'system'; }
}

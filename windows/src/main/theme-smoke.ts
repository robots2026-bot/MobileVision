import { BrowserWindow, nativeTheme } from 'electron';
import { writeFile } from 'node:fs/promises';

// Override only this test process. Never change the Windows theme setting.
export async function runThemeSmoke(win: BrowserWindow) {
  const original = nativeTheme.themeSource;
  const results: unknown[] = [];
  const waitFor = async (expression: string) => {
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Theme UI timeout: ${expression}`);
  };
  try {
    for (const theme of ['light', 'dark', 'light'] as const) {
      nativeTheme.themeSource = theme;
      await waitFor(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === 'dark'}`);
      for (const page of ['照片', '文件', '文本']) {
        await win.webContents.executeJavaScript(`[...document.querySelectorAll('.content-tabs button')].find(b => b.textContent === '${page}').click()`);
        const selector = page === '照片' ? '.viewer-card' : page === '文件' ? '.files-card' : '.text-card';
        await waitFor(`document.querySelector('${selector}') !== null`);
        if (page === '照片') {
          await waitFor("document.querySelector('.viewer img')?.naturalWidth === 1200");
          // A hidden smoke window needs a frame before ResizeObserver fits the photo.
          await win.webContents.capturePage();
          await waitFor("document.querySelector('.viewer img')?.getBoundingClientRect().width > 100");
        }
        const colors = await win.webContents.executeJavaScript(`(() => {
          const style = e => getComputedStyle(document.querySelector(e));
          return { root: style(':root').backgroundColor, panel: style('${selector}').backgroundColor, text: style('${selector}').color, header: style('header').backgroundColor, image: document.querySelector('.viewer img')?.src ?? null, textarea: document.querySelector('textarea') ? style('textarea').backgroundColor : null };
        })()`);
        const expected = theme === 'dark' ? { root: 'rgb(17, 21, 28)', panel: 'rgb(27, 34, 45)', text: 'rgb(230, 237, 247)', header: 'rgb(23, 29, 39)' } : { root: 'rgb(244, 246, 249)', panel: 'rgb(255, 255, 255)', text: 'rgb(35, 48, 71)', header: 'rgb(251, 252, 254)' };
        for (const key of ['root', 'panel', 'text', 'header'] as const) if (colors[key] !== expected[key]) throw new Error(`Unexpected ${theme}/${page}/${key}: ${colors[key]}`);
        if (colors.textarea && colors.textarea !== expected.panel) throw new Error('Textarea did not follow theme');
        if (win.getBackgroundColor().toLowerCase() !== (theme === 'dark' ? '#11151c' : '#f4f6f9')) throw new Error('Native window background did not follow theme');
        results.push({ theme, page, colors });
        await writeFile(`test-results/theme-${theme}-${page}.png`, (await win.webContents.capturePage()).toPNG());
      }
      await win.webContents.executeJavaScript("document.querySelector('.header-connection').click()");
      await waitFor("document.querySelector('.connection-dialog').open");
      const background = await win.webContents.executeJavaScript("getComputedStyle(document.querySelector('.connection-dialog')).backgroundColor");
      if (background !== (theme === 'dark' ? 'rgb(27, 34, 45)' : 'rgb(255, 255, 255)')) throw new Error('Connection dialog did not follow theme');
      await writeFile(`test-results/theme-${theme}-connection.png`, (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript("document.querySelector('.connection-dialog').close()");
    }
    await writeFile('test-results/theme-smoke.json', JSON.stringify({ passed: true, results }, null, 2));
  } finally { nativeTheme.themeSource = original; }
}

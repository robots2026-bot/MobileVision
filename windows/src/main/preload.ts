import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopAPI } from '../shared';
const api: DesktopAPI = {
  sendDroppedFiles: files => { const paths = files.map(file => webUtils.getPathForFile(file)); return ipcRenderer.invoke('send-file-paths', paths); }, pasteFiles: () => ipcRenderer.invoke('paste-files'),
  sendFiles: () => ipcRenderer.invoke('send-files'), cancelSendFile: id => ipcRenderer.invoke('cancel-send-file', id),
  openTextLink: url => ipcRenderer.invoke('open-text-link', url),
  sendText: text => ipcRenderer.invoke('send-text', text), copyText: id => ipcRenderer.invoke('copy-text', id), cleanMessages: () => ipcRenderer.invoke('clean-messages'),
  chooseFilesDirectory: () => ipcRenderer.invoke('choose-files-directory'), openFilesDirectory: () => ipcRenderer.invoke('open-files-directory'), openFile: id => ipcRenderer.invoke('open-file', id), revealFile: id => ipcRenderer.invoke('reveal-file', id),
  copyPairing: () => ipcRenderer.invoke('copy-pairing'), exportDiagnostics: () => ipcRenderer.invoke('export-diagnostics'),
  deletePhotos: ids => ipcRenderer.invoke('delete-photos', ids),
  saveCrop: (id, region) => ipcRenderer.invoke("save-crop", id, region),
  copyCrop: (id, region) => ipcRenderer.invoke('copy-crop', id, region),
  state: () => ipcRenderer.invoke('state'), chooseDirectory: () => ipcRenderer.invoke('choose-directory'),
  refreshPairing: () => ipcRenderer.invoke('refresh-pairing'), selectAddress: address => ipcRenderer.invoke('select-address', address),
  revoke: () => ipcRenderer.invoke('revoke'), openDirectory: () => ipcRenderer.invoke('open-directory'),
  revealPhoto: id => ipcRenderer.invoke('reveal-photo', id),
  onChange: callback => { const listener = () => callback(); ipcRenderer.on('changed', listener); return () => ipcRenderer.removeListener('changed', listener); }
};
contextBridge.exposeInMainWorld('desktop', api);

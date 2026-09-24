import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../shared';
const api: DesktopAPI = {
  copyPairing: () => ipcRenderer.invoke('copy-pairing'), exportDiagnostics: () => ipcRenderer.invoke('export-diagnostics'),
  deletePhotos: ids => ipcRenderer.invoke('delete-photos', ids),
  saveCrop: (id, region) => ipcRenderer.invoke("save-crop", id, region),
  copyCrop: (id, region) => ipcRenderer.invoke('copy-crop', id, region),
  state: () => ipcRenderer.invoke('state'), chooseDirectory: () => ipcRenderer.invoke('choose-directory'),
  refreshPairing: () => ipcRenderer.invoke('refresh-pairing'), selectAddress: address => ipcRenderer.invoke('select-address', address),
  revoke: () => ipcRenderer.invoke('revoke'), openDirectory: () => ipcRenderer.invoke('open-directory'),
  revealPhoto: id => ipcRenderer.invoke('reveal-photo', id),
  showFloat: () => ipcRenderer.invoke('show-float'), showMain: () => ipcRenderer.invoke('show-main'), floatMenu: () => ipcRenderer.invoke('float-menu'),
  onChange: callback => { const listener = () => callback(); ipcRenderer.on('changed', listener); return () => ipcRenderer.removeListener('changed', listener); }
};
contextBridge.exposeInMainWorld('desktop', api);

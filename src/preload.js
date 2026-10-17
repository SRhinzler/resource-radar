const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('resourceRadar', {
  scanPage: (url) => ipcRenderer.invoke('scan-page', url),
  inspectPlatform: (url) => ipcRenderer.invoke('inspect-platform', url),
  getMediaToolStatus: () => ipcRenderer.invoke('get-media-tool-status'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  downloadResources: (resources) => ipcRenderer.invoke('download-resources', resources),
  downloadPlatformMedia: (request) => ipcRenderer.invoke('download-platform-media', request),
  cancelDownloads: (jobId) => ipcRenderer.invoke('cancel-downloads', jobId),
  openDownloads: (destination) => ipcRenderer.invoke('open-downloads', destination),
  getPreferences: () => ipcRenderer.invoke('get-preferences'),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  getUrlHistory: () => ipcRenderer.invoke('get-url-history'),
  rememberUrl: (url) => ipcRenderer.invoke('remember-url', url),
  clearUrlHistory: () => ipcRenderer.invoke('clear-url-history'),
  getDownloadHistory: () => ipcRenderer.invoke('get-download-history'),
  clearDownloadHistory: () => ipcRenderer.invoke('clear-download-history'),
  openDownloadFile: (id) => ipcRenderer.invoke('open-download-file', id),
  onDownloadEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('download-event', listener);
    return () => ipcRenderer.removeListener('download-event', listener);
  },
  onUpdateEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('update-event', listener);
    return () => ipcRenderer.removeListener('update-event', listener);
  },
});

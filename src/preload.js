const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('resourceRadar', {
  scanPage: (url) => ipcRenderer.invoke('scan-page', url),
  inspectPlatform: (url) => ipcRenderer.invoke('inspect-platform', url),
  getMediaToolStatus: () => ipcRenderer.invoke('get-media-tool-status'),
  downloadResources: (resources) => ipcRenderer.invoke('download-resources', resources),
  downloadPlatformMedia: (request) => ipcRenderer.invoke('download-platform-media', request),
  cancelDownloads: (jobId) => ipcRenderer.invoke('cancel-downloads', jobId),
  openDownloads: (destination) => ipcRenderer.invoke('open-downloads', destination),
  onDownloadEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('download-event', listener);
    return () => ipcRenderer.removeListener('download-event', listener);
  },
});

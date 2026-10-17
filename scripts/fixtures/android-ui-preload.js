// Test-only replacement for Android's JavaScript bridge; never bundled in the APK.
const { ipcRenderer } = require('electron');
window.AndroidResourceRadar = {
  request(operation, requestId, payload) {
    ipcRenderer.invoke('smoke-android-request', operation, JSON.parse(payload)).then((result) => {
      window.resourceRadar.__receiveNativeResult(requestId, JSON.stringify(result));
    });
    return JSON.stringify({ ok: true, accepted: true, requestId });
  },
  onDownloadEvent() { return JSON.stringify({ ok: true }); },
};

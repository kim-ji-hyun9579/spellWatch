const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lcu', {
  getGameData: () => ipcRenderer.invoke('get-game-data'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  moveWindow: (dx, dy) => ipcRenderer.send('move-window', { dx, dy }),
  logError: (msg) => ipcRenderer.send('log-error', msg),
});

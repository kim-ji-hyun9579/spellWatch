const { contextBridge, ipcRenderer } = require('electron');

// 렌더러에선 window.lcu.getGameData() 만 노출 (보안상 contextIsolation 유지)
contextBridge.exposeInMainWorld('lcu', {
  getGameData: () => ipcRenderer.invoke('get-game-data'),
});

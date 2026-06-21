const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lcu', {
  getGameData: () => ipcRenderer.invoke('get-game-data'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  // renderer에서 명시적으로 에러 로그 파일에 기록할 때 사용
  logError: (msg) => ipcRenderer.send('log-error', msg),
});

const { app, BrowserWindow, ipcMain } = require('electron');
const https = require('https');
const path = require('path');

// Riot 라이브 클라이언트 API(127.0.0.1:2999)는 self-signed 인증서를 사용한다.
// 브라우저(fetch)에선 막히지만, main 프로세스에서 인증서 검증을 끄면 호출 가능.
const agent = new https.Agent({ rejectUnauthorized: false });

function getLiveData(endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://127.0.0.1:2999${endpoint}`,
      { agent },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('JSON parse error'));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(2500, () => req.destroy(new Error('timeout')));
  });
}

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 540,
    frame: false,        // 테두리 없는 오버레이
    transparent: true,   // 투명 배경
    resizable: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 전체화면(테두리 없음) 게임 위에도 떠 있도록 레벨 지정
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile('index.html');

  // 디버깅이 필요하면 아래 주석을 풀어 개발자 도구를 띄울 수 있다.
  // win.webContents.openDevTools({ mode: 'detach' });
}

// 렌더러 → main: 현재 게임 데이터 요청
ipcMain.handle('get-game-data', async () => {
  try {
    const data = await getLiveData('/liveclientdata/allgamedata');
    return { ok: true, data };
  } catch (e) {
    // 게임 중이 아니거나 클라이언트가 꺼져 있으면 여기로 온다.
    return { ok: false, error: e.message };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

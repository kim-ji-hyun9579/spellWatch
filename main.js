const { app, BrowserWindow, ipcMain } = require('electron');
const https = require('https');
const path = require('path');
const fs = require('fs');

const agent = new https.Agent({ rejectUnauthorized: false });

// ── 에러 로그 파일 설정 ───────────────────────────────────────────
// exe 옆 폴더(userData)가 아니라 exe와 같은 폴더에 저장
// → win-unpacked/spellwatch-error.log
const LOG_PATH = path.join(
  process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath),
  'spellwatch-error.log'
);

function writeLog(level, ...args) {
  try {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const line = `[${ts}] [${level}] ${args.map(a =>
      typeof a === 'object' ? JSON.stringify(a) : String(a)
    ).join(' ')}\n`;
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch (_) { /* 로그 쓰기 실패는 무시 */ }
}

// main 프로세스 미처리 에러 캐치
process.on('uncaughtException', (err) => {
  writeLog('FATAL', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  writeLog('FATAL', 'UnhandledRejection:', reason?.stack || reason);
});

// ── Live Client API 호출 ─────────────────────────────────────────
function getLiveData(endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://127.0.0.1:2999${endpoint}`,
      { agent },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(2500, () => req.destroy(new Error('timeout')));
  });
}

let win;
let keepOnTopTimer = null;

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 540,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile('index.html');

  // 시작하자마자 click-through 켜기
  win.setIgnoreMouseEvents(true, { forward: true });

  // 렌더러(renderer.js)의 console.error를 로그 파일에 기록
  win.webContents.on('console-message', (_, level, message, line, sourceId) => {
    // level: 0=verbose, 1=info, 2=warning, 3=error
    if (level >= 2) {
      const label = level === 3 ? 'ERROR' : 'WARN';
      writeLog(label, message, sourceId ? `(${path.basename(sourceId)}:${line})` : '');
    }
  });

  // 1초마다 최상단 유지 (독점 전체화면 대응)
  keepOnTopTimer = setInterval(() => {
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(true, 'screen-saver');
    }
  }, 1000);
}

// 게임 데이터 요청
ipcMain.handle('get-game-data', async () => {
  try {
    const data = await getLiveData('/liveclientdata/allgamedata');
    return { ok: true, data };
  } catch (e) {
    // 게임 미실행은 정상 상태라 로그 안 씀 (2초마다 시도하므로 노이즈가 너무 큼)
    return { ok: false, error: e.message };
  }
});

// 게임 중 발생한 명시적 에러만 로그 (renderer가 lcu.logError 호출 시)
ipcMain.on('log-error', (_, msg) => {
  writeLog('ERROR', msg);
});

// click-through 토글
ipcMain.on('set-ignore-mouse', (_, ignore) => {
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(ignore, { forward: true });
  }
});

// 타이틀바 JS 드래그 → 창 이동
ipcMain.on('move-window', (_, { dx, dy }) => {
  if (win && !win.isDestroyed()) {
    const [x, y] = win.getPosition();
    win.setPosition(x + dx, y + dy);
  }
});

app.whenReady().then(() => {
  writeLog('INFO', `SpellWatch 시작 — 로그: ${LOG_PATH}`);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  writeLog('INFO', 'SpellWatch 종료');
  if (keepOnTopTimer) clearInterval(keepOnTopTimer);
  if (process.platform !== 'darwin') app.quit();
});

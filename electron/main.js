/* =========================================================================
   byU 포토부스 키오스크 — Electron 메인 프로세스
   -------------------------------------------------------------------------
   · 풀스크린·키오스크 모드로 app/byU-kiosk.html(자체 완결형 번들)을 로드
   · electron-updater로 GitHub Releases를 확인해 자동 업데이트
   ========================================================================= */

const { app, BrowserWindow, globalShortcut, powerSaveBlocker, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

let psbId = null;
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    fullscreen: true,        // 풀스크린으로 시작
    kiosk: true,             // 키오스크 모드 (Alt+Tab/작업표시줄 차단)
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'app', 'byU-kiosk.html'));

  // 카메라 등 장치 권한 자동 허용
  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'camera', 'microphone'].includes(permission));
  });

  return mainWindow;
}

/* ---------- 자동 업데이트 ---------- */
function setupAutoUpdate() {
  if (!app.isPackaged) return;          // 개발 중엔 비활성

  autoUpdater.autoDownload = true;
  autoUpdater.on('update-available', (info) => {
    console.log('업데이트 발견:', info.version);
  });
  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '업데이트 준비 완료',
      message: `새 버전 ${info.version}을(를) 받았습니다.`,
      detail: '지금 재시작하여 업데이트를 적용할까요?',
      buttons: ['지금 재시작', '나중에'],
      defaultId: 0,
      cancelId: 1,
    }).then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); });
  });
  autoUpdater.on('error', (err) => { console.error('업데이트 오류:', err); });

  // 시작 시 1회 확인 + 이후 6시간마다 재확인
  autoUpdater.checkForUpdatesAndNotify();
  setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 6 * 60 * 60 * 1000);
}

app.whenReady().then(() => {
  createWindow();
  psbId = powerSaveBlocker.start('prevent-display-sleep');
  setupAutoUpdate();

  // 운영자 비상 종료 단축키
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (psbId !== null && powerSaveBlocker.isStarted(psbId)) powerSaveBlocker.stop(psbId);
  app.quit();
});

app.on('will-quit', () => globalShortcut.unregisterAll());

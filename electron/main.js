/* =========================================================================
   byU 포토부스 키오스크 — Electron 메인 프로세스
   -------------------------------------------------------------------------
   설치형 프로그램의 진입점입니다. 풀스크린·키오스크 모드로 띄우고
   app/byU-kiosk.html (자체 완결형 번들)을 로드합니다.
   ========================================================================= */

const { app, BrowserWindow, globalShortcut, powerSaveBlocker } = require('electron');
const path = require('path');

// 키오스크 운영 중 절전/화면 꺼짐 방지
let psbId = null;

function createWindow() {
  const win = new BrowserWindow({
    fullscreen: true,        // 풀스크린으로 시작
    kiosk: true,             // 키오스크 모드 (Alt+Tab/작업표시줄 차단)
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 카메라/마이크 등 장치 접근 허용이 필요하면 아래 주석 해제
      // permissions 은 setPermissionRequestHandler 로 별도 제어
    },
  });

  win.loadFile(path.join(__dirname, 'app', 'byU-kiosk.html'));

  // (선택) 카메라 등 장치 권한 자동 허용
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
    const allow = ['media', 'camera', 'microphone'];
    cb(allow.includes(permission));
  });

  return win;
}

app.whenReady().then(() => {
  createWindow();

  // 절전 방지 켜기
  psbId = powerSaveBlocker.start('prevent-display-sleep');

  // 비상 종료 단축키 (운영자 전용) — Ctrl+Shift+Q
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (psbId !== null && powerSaveBlocker.isStarted(psbId)) {
    powerSaveBlocker.stop(psbId);
  }
  app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

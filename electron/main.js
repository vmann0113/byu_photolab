/* =========================================================================
   byU 포토부스 키오스크 — Electron 메인 프로세스
   -------------------------------------------------------------------------
   · 풀스크린·키오스크 모드로 app/byU-kiosk.html(자체 완결형 번들)을 로드
   · electron-updater로 GitHub Releases를 확인해 자동 업데이트
   · 사진 전송: PC 안에 미니 웹서버를 띄워 같은 로컬망의 폰이 QR로 사진 수령
   ========================================================================= */

const { app, BrowserWindow, globalShortcut, powerSaveBlocker, dialog, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

let psbId = null;
let mainWindow = null;

/* ===================== 자가복구 (Watchdog) =====================
   무인운영의 핵심. 화면 멈춤 / 렌더러 크래시 / 하트비트 끊김을 실제로
   감지해 자동으로 복구하고, 그 이력을 디스크에 진짜로 기록한다. */
let lastHeartbeat = Date.now();
let watchdogTimer = null;
let recovering = false;
let wdConfig = { autoRestart: true, maxRetries: 3, hangSeconds: 20 };
let retryCount = 0;

function recoveryLogPath() {
  try { return path.join(app.getPath('userData'), 'recovery-log.json'); }
  catch (e) { return path.join(__dirname, 'recovery-log.json'); }
}
function readRecoveryLog() {
  try { return JSON.parse(fs.readFileSync(recoveryLogPath(), 'utf8')); }
  catch (e) { return []; }
}
function addRecovery(kind, detail, ok, ms) {
  const log = readRecoveryLog();
  log.unshift({ ts: Date.now(), kind, detail, ok: ok !== false, ms: ms || 0 });
  while (log.length > 200) log.pop();
  try { fs.writeFileSync(recoveryLogPath(), JSON.stringify(log)); } catch (e) {}
  // 화면에도 즉시 알림 (콘솔/배너용)
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('watchdog:event', { kind, detail, ok, ms, ts: Date.now() }); } catch (e) {}
  }
  return log;
}

function reloadRenderer(reason) {
  if (recovering) return;
  recovering = true;
  const t0 = Date.now();
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reloadIgnoringCache();
      mainWindow.webContents.once('did-finish-load', () => {
        lastHeartbeat = Date.now();
        addRecovery('화면 멈춤', reason + ' → 새로고침 복구', true, Date.now() - t0);
        recovering = false; retryCount = 0;
      });
      // 안전장치: 8초 안에 안 살아나면 창 재생성
      setTimeout(() => {
        if (recovering) { recovering = false; recreateWindow(reason); }
      }, 8000);
    } else { recovering = false; recreateWindow(reason); }
  } catch (e) { recovering = false; }
}

function recreateWindow(reason) {
  const t0 = Date.now();
  retryCount++;
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy(); } catch (e) {}
  createWindow();
  lastHeartbeat = Date.now();
  addRecovery('앱 응답 없음', reason + ' → 자동 재실행' + (retryCount > 1 ? ' (' + retryCount + '회)' : ''), true, Date.now() - t0);
}

function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    if (!wdConfig.autoRestart || recovering) return;
    const silent = Date.now() - lastHeartbeat;
    if (silent > wdConfig.hangSeconds * 1000) {
      if (retryCount >= wdConfig.maxRetries) {
        addRecovery('복구 한계', '최대 재시도(' + wdConfig.maxRetries + '회) 초과 · 수동 점검 필요', false, 0);
        retryCount = 0; lastHeartbeat = Date.now(); // 리셋 후 계속 감시
        return;
      }
      reloadRenderer('하트비트 ' + Math.round(silent / 1000) + '초 끊김');
    }
  }, 4000);
}

const SHARE_PORT = 8080;
const HOTSPOT_SSID = 'byU-Photo';      // 운영자가 Windows 모바일 핫스팟 SSID를 이 이름으로 설정
const sessions = {};                    // code -> { photos: [{name, buffer, mime}], createdAt }

/* ---------- 로컬망 IP 찾기 ---------- */
function getLanIp() {
  const ifaces = os.networkInterfaces();
  let fallback = '127.0.0.1';
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name]) {
      if (ni.family === 'IPv4' && !ni.internal) {
        // 192.168.x / 172.x / 10.x 사설망 우선
        if (/^(192\.168\.|10\.|172\.)/.test(ni.address)) return ni.address;
        fallback = ni.address;
      }
    }
  }
  return fallback;
}

function randomCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

/* ---------- 폰에서 열리는 사진 페이지 ---------- */
function galleryHtml(code, sess) {
  const items = sess.photos.map((p, i) => `
    <a class="ph" href="/p/${code}/file/${i}" download="${p.name || ('byu-' + (i + 1) + '.jpg')}">
      <img src="/p/${code}/file/${i}" alt="">
      <span class="dl">사진 ${i + 1} 저장 ↓</span>
    </a>`).join('');
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>byU PHOTO STUDIO</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,'Noto Sans KR',sans-serif;background:#14110e;color:#fff;min-height:100vh;padding:24px 16px 48px}
  .top{display:flex;align-items:center;gap:12px;justify-content:center;margin:8px 0 22px}
  .glyph{width:44px;height:44px;border:3px solid #FF5A4E;border-radius:12px;display:flex;align-items:center;justify-content:center;font-style:italic;font-weight:800;font-size:24px;color:#FF5A4E;transform:rotate(-3deg)}
  .wm b{font-weight:800;font-size:20px;letter-spacing:.06em}.wm span{display:block;font-size:9px;letter-spacing:.3em;color:rgba(255,255,255,.5);margin-top:3px}
  h1{font-size:18px;text-align:center;margin-bottom:6px}
  p.sub{text-align:center;color:rgba(255,255,255,.55);font-size:13px;margin-bottom:24px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:520px;margin:0 auto}
  .ph{display:block;background:#141a2c;border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden;text-decoration:none;color:#fff}
  .ph img{width:100%;display:block;aspect-ratio:3/4;object-fit:cover;background:#2c2520}
  .ph .dl{display:block;text-align:center;font-size:13px;font-weight:600;padding:11px;color:#FF5A4E}
  .empty{text-align:center;color:rgba(255,255,255,.4);padding:60px 20px;font-size:14px;line-height:1.7}
  .foot{text-align:center;color:rgba(255,255,255,.3);font-size:11px;margin-top:30px;font-family:monospace;letter-spacing:.1em}
</style></head><body>
  <div class="top"><div class="glyph">b</div><div class="wm"><b>byU</b><span>PHOTO&nbsp;STUDIO</span></div></div>
  <h1>사진이 준비됐어요 📸</h1>
  <p class="sub">아래 사진을 길게 눌러 저장하거나 버튼으로 받아가세요</p>
  ${sess.photos.length ? `<div class="grid">${items}</div>` : `<div class="empty">표시할 사진이 없습니다.<br>키오스크에서 다시 시도해 주세요.</div>`}
  <div class="foot">SESSION ${code} · byU PHOTO STUDIO</div>
</body></html>`;
}

function startShareServer() {
  const server = http.createServer((req, res) => {
    try {
      const url = decodeURIComponent((req.url || '').split('?')[0]);
      let m = url.match(/^\/p\/([A-Z0-9]+)\/file\/(\d+)$/);
      if (m) {
        const sess = sessions[m[1]];
        const photo = sess && sess.photos[Number(m[2])];
        if (!photo) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': photo.mime || 'image/jpeg' });
        return res.end(photo.buffer);
      }
      m = url.match(/^\/p\/([A-Z0-9]+)\/?$/);
      if (m) {
        const sess = sessions[m[1]];
        if (!sess) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<h1>만료된 링크입니다</h1>'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(galleryHtml(m[1], sess));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>byU PHOTO STUDIO</h1>');
    } catch (e) {
      res.writeHead(500); res.end('error');
    }
  });
  server.on('error', (e) => console.error('share server error:', e.message));
  server.listen(SHARE_PORT, '0.0.0.0', () => console.log('share server on', SHARE_PORT));
}

/* ---------- IPC: 화면 ↔ 서버 ---------- */
ipcMain.handle('net:info', () => ({ ip: getLanIp(), port: SHARE_PORT, ssid: HOTSPOT_SSID }));

ipcMain.handle('share:create', (evt, photos) => {
  const code = randomCode();
  const stored = (photos || []).map((p, i) => {
    let buffer = null, mime = 'image/jpeg';
    if (p && typeof p.dataUrl === 'string') {
      const mm = p.dataUrl.match(/^data:([^;]+);base64,(.*)$/);
      if (mm) { mime = mm[1]; buffer = Buffer.from(mm[2], 'base64'); }
    }
    return { name: (p && p.name) || ('byu-' + (i + 1) + '.jpg'), buffer, mime };
  }).filter(p => p.buffer);
  sessions[code] = { photos: stored, createdAt: Date.now() };
  // 2시간 뒤 자동 정리
  setTimeout(() => { delete sessions[code]; }, 2 * 60 * 60 * 1000);
  const ip = getLanIp();
  return { url: `http://${ip}:${SHARE_PORT}/p/${code}`, code, ssid: HOTSPOT_SSID, ip, port: SHARE_PORT };
});

/* ---------- IPC: 자가복구 (Watchdog) ---------- */
// 화면이 살아있다는 신호 (렌더러가 주기적으로 보냄)
ipcMain.on('watchdog:heartbeat', () => { lastHeartbeat = Date.now(); });
// 화면이 watchdog 설정을 보냄 (어드민 토글 반영)
ipcMain.on('watchdog:config', (evt, cfg) => {
  if (cfg && typeof cfg === 'object') {
    if (typeof cfg.autoRestart === 'boolean') wdConfig.autoRestart = cfg.autoRestart;
    if (cfg.maxRetries) wdConfig.maxRetries = cfg.maxRetries;
    if (cfg.hangSeconds) wdConfig.hangSeconds = cfg.hangSeconds;
  }
});
// 실제 복구 이력 조회
ipcMain.handle('watchdog:log', () => readRecoveryLog());
// 장치(카메라/프린터) 끊김을 화면이 보고 → 이력에 기록 + 콘솔 알림
ipcMain.handle('watchdog:report', (evt, e) => {
  e = e || {};
  return addRecovery(e.kind || '장치', e.detail || '', e.ok, e.ms);
});

/* ---------- IPC: 프린터 (실제 윈도우 인쇄 시스템 연동) ---------- */
// 설치된 프린터 목록
ipcMain.handle('printer:list', async () => {
  try {
    const printers = await mainWindow.webContents.getPrintersAsync();
    return printers.map(p => ({
      name: p.name, displayName: p.displayName || p.name,
      status: p.status, isDefault: p.isDefault, description: p.description || '',
    }));
  } catch (e) { return []; }
});

// 인쇄할 HTML을 숨겨진 창에 로드해 인쇄
function printHtml(html, opts) {
  return new Promise((resolve) => {
    const w = new BrowserWindow({ show: false, webPreferences: { offscreen: false } });
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    w.webContents.once('did-finish-load', () => {
      w.webContents.print(opts, (success, reason) => {
        resolve({ success, reason: reason || '' });
        setTimeout(() => { if (!w.isDestroyed()) w.destroy(); }, 800);
      });
    });
  });
}

// 프린터 설정/선택 대화상자 열기 (의견자가 용지·품질 확인) — 시스템 대화상자 표시
ipcMain.handle('printer:openDialog', async () => {
  const html = testPageHtml('프린터 설정 확인', true);
  return await printHtml(html, { silent: false, printBackground: true });
});

// 테스트 인쇄 (silent: 기본·지정 프린터로 바로, 아니면 대화상자)
ipcMain.handle('printer:testPrint', async (evt, opts) => {
  opts = opts || {};
  const html = testPageHtml('TEST PRINT', false);
  const printOpts = { silent: !!opts.silent, printBackground: true, margins: { marginType: 'none' } };
  if (opts.deviceName) printOpts.deviceName = opts.deviceName;
  return await printHtml(html, printOpts);
});

// 4×6 테스트 페이지
function testPageHtml(label, withGuides) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: 4in 6in; margin: 0; }
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:4in;height:6in}
    body{font-family:Arial,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;border:${withGuides ? '2px dashed #FF5A4E' : 'none'};position:relative}
    .mk{width:70px;height:70px;border:4px solid #FF5A4E;border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:800;font-style:italic;color:#FF5A4E;transform:rotate(-3deg);margin-bottom:18px}
    h1{font-size:26px;letter-spacing:.1em}
    p{font-size:13px;color:#666;margin-top:10px}
    .bars{display:flex;gap:6px;margin-top:22px}
    .bars i{width:26px;height:46px;border-radius:3px}
    .swatch{position:absolute;bottom:18px;display:flex;gap:0}
    .swatch i{width:34px;height:20px}
  </style></head><body>
    <div class="mk">b</div>
    <h1>BY.U PHOTO STUDIO</h1>
    <p>${label} · 4×6 · ${new Date().toLocaleString('ko-KR')}</p>
    <div class="bars">
      <i style="background:#FF5A4E"></i><i style="background:#222"></i><i style="background:#2a6fdb"></i><i style="background:#1f9d57"></i><i style="background:#e8b44a"></i>
    </div>
    <div class="swatch">
      <i style="background:#000"></i><i style="background:#444"></i><i style="background:#888"></i><i style="background:#bbb"></i><i style="background:#fff;border:1px solid #ddd"></i>
    </div>
  </body></html>`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    fullscreen: true,
    kiosk: true,
    autoHideMenuBar: true,
    backgroundColor: '#14110e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'app', 'byU-kiosk.html'));

  // 렌더러(화면)가 응답 없음 → 자동 복구
  mainWindow.webContents.on('unresponsive', () => {
    addRecovery('화면 무응답', '응답 없음 감지', true, 0);
    reloadRenderer('화면 무응답');
  });
  // 렌더러 프로세스가 죽음(크래시) → 창 재생성
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    recreateWindow('렌더러 종료(' + (details && details.reason || 'crash') + ')');
  });
  mainWindow.webContents.on('did-finish-load', () => { lastHeartbeat = Date.now(); });

  mainWindow.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'camera', 'microphone'].includes(permission));
  });

  return mainWindow;
}

/* ---------- 자동 업데이트 ---------- */
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info', title: '업데이트 준비 완료',
      message: `새 버전 ${info.version}을(를) 받았습니다.`,
      detail: '지금 재시작하여 업데이트를 적용할까요?',
      buttons: ['지금 재시작', '나중에'], defaultId: 0, cancelId: 1,
    }).then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); });
  });
  autoUpdater.on('error', (err) => console.error('업데이트 오류:', err));
  autoUpdater.checkForUpdatesAndNotify();
  setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 6 * 60 * 60 * 1000);
}

app.whenReady().then(() => {
  startShareServer();
  createWindow();
  startWatchdog();
  psbId = powerSaveBlocker.start('prevent-display-sleep');
  setupAutoUpdate();
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (psbId !== null && powerSaveBlocker.isStarted(psbId)) powerSaveBlocker.stop(psbId);
  app.quit();
});
app.on('will-quit', () => globalShortcut.unregisterAll());

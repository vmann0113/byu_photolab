/* =========================================================================
   byU 포토부스 — preload (보안 브릿지)
   렌더러(화면)와 메인 프로세스를 안전하게 연결합니다.
   화면 코드에서는 window.byuKiosk.* 로 접근합니다.
   ========================================================================= */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('byuKiosk', {
  isKiosk: true,
  // 이번 세션 사진을 미니서버에 올리고 공유 URL을 받음
  // photos: [{ name, dataUrl }] · 반환: { url, code, ssid }
  createShare: (photos) => ipcRenderer.invoke('share:create', photos),
  // 현재 PC의 로컬망 정보 (IP/포트/핫스팟 SSID)
  getNetInfo: () => ipcRenderer.invoke('net:info'),
  // 프린터 (실제 윈도우 인쇄 시스템)
  printer: {
    list: () => ipcRenderer.invoke('printer:list'),
    openDialog: () => ipcRenderer.invoke('printer:openDialog'),
    testPrint: (opts) => ipcRenderer.invoke('printer:testPrint', opts),
  },
  // 자가복구 (watchdog)
  watchdog: {
    // 화면이 살아있다는 신호 — 자동으로 주기 전송됨 (아래 setInterval)
    setConfig: (cfg) => ipcRenderer.send('watchdog:config', cfg),
    getLog: () => ipcRenderer.invoke('watchdog:log'),
    // 카메라/프린터 끊김 등 장치 이상을 화면이 보고 → 이력 기록 + 콘솔 알림
    report: (e) => ipcRenderer.invoke('watchdog:report', e),
    onEvent: (cb) => ipcRenderer.on('watchdog:event', (evt, data) => cb(data)),
  },
});

// 화면이 살아있다는 하트비트를 3초마다 메인 프로세스로 — 끊기면 watchdog이 복구
setInterval(() => { try { ipcRenderer.send('watchdog:heartbeat'); } catch (e) {} }, 3000);
try { ipcRenderer.send('watchdog:heartbeat'); } catch (e) {}

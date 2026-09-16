const { app, BrowserWindow, protocol, net, session, shell, dialog, desktopCapturer, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ORIGIN, isAppURL, assetPath, externalURL } = require('./policy.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, allowServiceWorkers: true, stream: true,
} }]);
let window;
const mediaApprovals = new Set();
function openExternal(url) { if (externalURL(url)) shell.openExternal(url).catch(() => {}); }
function createWindow() {
  window = new BrowserWindow({ width: 1180, height: 800, minWidth: 360, minHeight: 500,
    backgroundColor: '#f8f9fc', icon: path.join(__dirname, '../web/icon-512.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false },
  });
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppURL(url)) { event.preventDefault(); openExternal(url); }
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('closed', () => { window = null; mediaApprovals.clear(); });
  window.loadURL(ORIGIN + '/');
}
app.whenReady().then(() => {
  const root = path.join(app.getAppPath(), 'web');
  protocol.handle('app', async request => {
    const file = assetPath(root, request.url, request.method);
    if (!file) return new Response('Not found', { status: 404 });
    try { return await net.fetch(pathToFileURL(file).toString()); }
    catch { return new Response('Not found', { status: 404 }); }
  });
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((contents, permission, origin, details) => {
    return contents === window?.webContents && isAppURL(origin) && permission === 'media' && mediaApprovals.has(details.mediaType);
  });
  ses.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (contents !== window?.webContents || !isAppURL(details.requestingUrl) || !details.isMainFrame || permission !== 'media') return callback(false);
    const types = details.mediaTypes || [];
    if (!types.length || types.some(type => !['audio', 'video'].includes(type))) return callback(false);
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: 'question', title: 'Recording permission', message: `Allow UniLab to use your ${types.map(t => t === 'audio' ? 'microphone' : 'camera').join(' and ')}?`,
        detail: 'Only allow this if you just started a recording or camera tool. Processing stays on this device.',
        buttons: ['Cancel', 'Allow'], defaultId: 0, cancelId: 0,
      });
      if (response === 1) types.forEach(type => mediaApprovals.add(type));
      callback(response === 1);
    } catch { callback(false); }
  });
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!window || request.frame !== window.webContents.mainFrame || !isAppURL(request.securityOrigin)) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const choices = sources.slice(0, 12);
      if (!choices.length) return callback({});
      const { response } = await dialog.showMessageBox(window, { title: 'Choose what to record',
        message: 'Select one screen or window. System audio is not included in this desktop preview.',
        buttons: ['Cancel', ...choices.map(s => s.name)], defaultId: 0, cancelId: 0,
      });
      callback(response > 0 ? { video: choices[response - 1] } : {});
    } catch { callback({}); }
  }, { useSystemPicker: true });
  ses.on('will-download', (_event, item) => item.setSaveDialogOptions({ title: 'Save UniLab result' }));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'Downloads & release notes', click: () => openExternal('https://github.com/Thiha-Lynn/unilab-releases/releases') }] },
  ]));
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

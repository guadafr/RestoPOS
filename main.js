const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

function createWindow () {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // 👇 CAMBIÁ SOLO ESTA LÍNEA según dónde está tu archivo
  win.loadFile(path.join(__dirname, 'admin.html'));
  // win.loadFile(path.join(__dirname, 'RestoPOS_v3', 'admin.html'));

  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error('❌ did-fail-load:', code, desc, 'url:', url);
  });
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    console.log('🧭 console:', message, sourceId+':'+line);
  });
  win.webContents.openDevTools();
}

ipcMain.handle('print-html', async (e, html) => {
  const temp = new BrowserWindow({ show:false });
  await temp.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise(r=>setTimeout(r,150));
  await temp.webContents.print({ silent:true, printBackground:true, deviceName:'' });
  temp.close();
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

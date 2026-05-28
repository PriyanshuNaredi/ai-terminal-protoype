const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
const isLinux = process.platform === 'linux';
const isWaylandSession = isLinux && process.env.XDG_SESSION_TYPE === 'wayland';

if (isLinux && !isWaylandSession) {
  app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

// 1. Boot up your existing backend server seamlessly
require('./server.js'); 

let mainWindow = null;

function createWindow() {
  // 2. Create the native application window
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    backgroundColor: '#000000', // Matches your terminal vibe
    autoHideMenuBar: true,      // Hides the ugly default file menu
    menuBarVisible: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false
    }
  });

  mainWindow.on('close', () => {
    console.log('[ELECTRON] window close requested');
  });

  mainWindow.on('closed', () => {
    console.log('[ELECTRON] window closed');
    mainWindow = null;
  });

  // 3. Point the native window to your local Express server (with Auto-Retry)
  const loadUI = () => {
    mainWindow.loadURL('http://localhost:3000').catch((err) => {
      console.log('[ELECTRON] Server not ready yet, retrying in 250ms...');
      setTimeout(loadUI, 250);
    });
  };

  loadUI(); // Kick off the first attempt

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[ELECTRON] did-finish-load');
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[ELECTRON] did-fail-load:', { errorCode, errorDescription, validatedURL });
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[ELECTRON] render-process-gone:', details);
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.error('[ELECTRON] window became unresponsive');
  });

  // Optional: Uncomment to force DevTools open for debugging
  // mainWindow.webContents.openDevTools();
}

// When Electron is ready, open the window (ONLY ONCE!)
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  console.log('[ELECTRON] before-quit');
});

app.on('will-quit', () => {
  console.log('[ELECTRON] will-quit');
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  console.log('[ELECTRON] window-all-closed');
  if (process.platform !== 'darwin') app.quit();
});
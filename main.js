const { app, BrowserWindow, ipcMain, Notification, safeStorage, shell, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');
const fs = require('fs').promises;
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

// Set app name for notifications and system
app.setName('OTH Launcher');

// Note: In development, Windows will show "electron.app.OTH Launcher"
// When built with electron-builder, it will show just "OTH Launcher" perfectly!

// Set macOS dock icon
if (process.platform === 'darwin') {
  app.dock?.setIcon(path.join(__dirname, 'company.png'));
}

// Handle unhandled promise rejections globally
process.on('unhandledRejection', (reason, promise) => {
  // Log to console but don't try to send complex objects through IPC
  console.log('Caught unhandled rejection in main process:', reason?.message || reason);
  // Don't exit the app, just log it
});

// Try to load Discord RPC (optional dependency)
let DiscordPresenceManager;
try {
  DiscordPresenceManager = require('./discord/presence-manager');
} catch (error) {
  console.log('Discord RPC not available. Run: npm install discord-rpc');
  DiscordPresenceManager = null;
}

const store = new Store({
  encryptionKey: 'oth-secure-storage-key-v1' // This adds an extra layer of encryption
});

let mainWindow;
let discordPresence = null;
let pendingLoginCredentials = null; // Store credentials temporarily

const DISCORD_CLIENT_ID = '1348861044604534835';

// ===== IPC HANDLERS (Registered Once on App Start) =====

// Handle store connection
ipcMain.handle('connect-to-store', async (event, credentials) => {
  try {
    // Load the dashboard directly with credentials in URL hash
    const storeUrl = process.env.OTH_STORE_URL || 'http://localhost:3000';
    if (mainWindow) {
      // Encode credentials as base64 for URL
      const credentialsJson = JSON.stringify(credentials);
      const credentialsBase64 = Buffer.from(credentialsJson).toString('base64');
      
      // Load dashboard directly - it will handle signin invisibly
      mainWindow.loadURL(`${storeUrl}/dashboard#electron-login=${credentialsBase64}`);
    }
    
    return { success: true, message: 'Connected to OTH Store' };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// Get pending login credentials
ipcMain.handle('get-pending-credentials', async () => {
  try {
    if (pendingLoginCredentials) {
      const creds = pendingLoginCredentials;
      pendingLoginCredentials = null; // Clear after retrieval
      return { success: true, credentials: creds };
    }
    return { success: false, error: 'No pending credentials' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Handle user login notification
ipcMain.handle('user-logged-in', async (event, userEmail) => {
  // userEmail is now just a string, not an object
  if (Notification.isSupported()) {
    new Notification({
      title: 'Welcome to OTH',
      body: `Logged in as ${userEmail}`,
      icon: path.join(__dirname, 'company.png'),
    }).show();
  }
  return { success: true };
});

// Handle user logout notification
ipcMain.handle('user-logged-out', async () => {
  if (Notification.isSupported()) {
    new Notification({
      title: 'OTH Client',
      body: 'You have been logged out',
      icon: path.join(__dirname, 'company.png'),
    }).show();
  }
  return { success: true };
});

// Handle custom notifications from the app
ipcMain.handle('show-notification', async (event, options) => {
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: options.title || 'OTH Notification',
      body: options.body || '',
      icon: path.join(__dirname, 'company.png'),
      silent: options.silent || false,
      urgency: options.urgency || 'normal', // low, normal, critical
    });
    
    notification.show();
    
    // Handle notification click to focus the window
    notification.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }
  return { success: true };
});

// Check if user is already logged in on startup
ipcMain.handle('check-login-status', async () => {
  return { isClient: true };
});

// Secure credential storage handlers
ipcMain.handle('save-credentials', async (event, credentials) => {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      // Encrypt credentials using Electron's safeStorage (OS-level encryption)
      const encrypted = safeStorage.encryptString(JSON.stringify(credentials));
      // Store encrypted data
      store.set('user-credentials', encrypted.toString('base64'));
      return { success: true };
    } else {
      // Fallback: store with electron-store's encryption only
      store.set('user-credentials-fallback', credentials);
      return { success: true };
    }
  } catch (error) {
    console.error('Failed to save credentials:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-credentials', async () => {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = store.get('user-credentials');
      if (encrypted) {
        // Decrypt credentials
        const buffer = Buffer.from(encrypted, 'base64');
        const decrypted = safeStorage.decryptString(buffer);
        return { success: true, credentials: JSON.parse(decrypted) };
      }
    } else {
      // Fallback: get from electron-store
      const credentials = store.get('user-credentials-fallback');
      if (credentials) {
        return { success: true, credentials };
      }
    }
    return { success: false, error: 'No credentials found' };
  } catch (error) {
    console.error('Failed to retrieve credentials:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('clear-credentials', async () => {
  try {
    store.delete('user-credentials');
    store.delete('user-credentials-fallback');
    return { success: true };
  } catch (error) {
    console.error('Failed to clear credentials:', error);
    return { success: false, error: error.message };
  }
});

// ===== LIBRARY MANAGEMENT HANDLERS =====

// Get installed apps from local storage
ipcMain.handle('get-installed-apps', async () => {
  try {
    const installedApps = store.get('installed-apps', []);
    return { success: true, apps: installedApps };
  } catch (error) {
    console.error('Failed to get installed apps:', error);
    return { success: false, error: error.message };
  }
});

// Check if specific app is installed
ipcMain.handle('is-app-installed', async (event, marketplaceItemId) => {
  try {
    const installedApps = store.get('installed-apps', []);
    const isInstalled = installedApps.some(app => app.marketplaceItemId === marketplaceItemId);
    return { success: true, isInstalled };
  } catch (error) {
    console.error('Failed to check if app is installed:', error);
    return { success: false, error: error.message };
  }
});

// Launch an installed app
ipcMain.handle('launch-app', async (event, marketplaceItemId) => {
  try {
    const installedApps = store.get('installed-apps', []);
    const app = installedApps.find(a => a.marketplaceItemId === marketplaceItemId);
    
    if (!app) {
      return { success: false, error: 'App not installed' };
    }

    // Check if executable exists
    try {
      await fs.access(app.executablePath);
    } catch (error) {
      return { success: false, error: 'Executable not found. Please reinstall the app.' };
    }

    // Launch the executable
    const child = spawn(app.executablePath, [], {
      detached: true,
      stdio: 'ignore',
      cwd: app.installPath
    });

    child.unref();

    // Update last launched time
    app.lastLaunched = new Date().toISOString();
    const updatedApps = installedApps.map(a => 
      a.marketplaceItemId === marketplaceItemId ? app : a
    );
    store.set('installed-apps', updatedApps);

    // Update Discord presence
    if (discordPresence && discordPresence.isActive()) {
      await discordPresence.setAppPresence(app.title);
    }

    // Show notification
    const settings = store.get('launcher-settings', {});
    if (settings.notifications?.launch !== false && Notification.isSupported()) {
      new Notification({
        title: 'Launching...',
        body: `Starting ${app.title}`,
        icon: path.join(__dirname, 'company.png'),
      }).show();
    }

    return { success: true };
  } catch (error) {
    console.error('Failed to launch app:', error);
    return { success: false, error: error.message };
  }
});

// Download an app (this is a simple example - you'd want to implement proper download logic)
ipcMain.handle('download-app', async (event, downloadInfo) => {
  try {
    const { marketplaceItemId, title, downloadUrl } = downloadInfo;
    
    // Create downloads directory in user's documents
    const userDataPath = app.getPath('userData');
    const downloadsDir = path.join(userDataPath, 'downloads');
    
    try {
      await fs.mkdir(downloadsDir, { recursive: true });
    } catch (error) {
      // Directory might already exist, that's fine
    }

    const fileName = `${title.replace(/[^a-z0-9]/gi, '_')}.zip`;
    const filePath = path.join(downloadsDir, fileName);

    // Show download dialog
    const { canceled, filePath: savePath } = await dialog.showSaveDialog(mainWindow, {
      title: `Download ${title}`,
      defaultPath: filePath,
      filters: [
        { name: 'ZIP Archives', extensions: ['zip'] },
        { name: 'Executables', extensions: ['exe', 'msi'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (canceled || !savePath) {
      return { success: false, error: 'Download canceled' };
    }

    // For now, just create a placeholder file
    // In production, you'd implement actual download logic here
    await fs.writeFile(savePath, 'Placeholder download file. Replace with actual download logic.');

    // Show completion notification
    if (Notification.isSupported()) {
      new Notification({
        title: 'Download Complete',
        body: `${title} has been downloaded`,
        icon: path.join(__dirname, 'company.png'),
      }).show();
    }

    return { 
      success: true, 
      downloadPath: savePath,
      message: 'Download completed successfully'
    };
  } catch (error) {
    console.error('Failed to download app:', error);
    return { success: false, error: error.message };
  }
});

// Register an installation
ipcMain.handle('register-installation', async (event, installInfo) => {
  try {
    const installedApps = store.get('installed-apps', []);
    
    // Check if already installed
    const existingIndex = installedApps.findIndex(
      app => app.marketplaceItemId === installInfo.marketplaceItemId
    );

    if (existingIndex >= 0) {
      // Update existing installation
      installedApps[existingIndex] = {
        ...installedApps[existingIndex],
        ...installInfo,
        installDate: installedApps[existingIndex].installDate // Keep original install date
      };
    } else {
      // Add new installation
      installedApps.push({
        ...installInfo,
        installDate: new Date().toISOString()
      });
    }

    store.set('installed-apps', installedApps);

    // Show notification
    if (Notification.isSupported()) {
      new Notification({
        title: 'Installation Complete',
        body: `${installInfo.title} is now installed`,
        icon: path.join(__dirname, 'company.png'),
      }).show();
    }

    return { success: true };
  } catch (error) {
    console.error('Failed to register installation:', error);
    return { success: false, error: error.message };
  }
});

// Uninstall an app
ipcMain.handle('uninstall-app', async (event, marketplaceItemId) => {
  try {
    const installedApps = store.get('installed-apps', []);
    const app = installedApps.find(a => a.marketplaceItemId === marketplaceItemId);
    
    if (!app) {
      return { success: false, error: 'App not found' };
    }

    // Ask for confirmation
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Uninstall', 'Cancel'],
      defaultId: 1,
      title: 'Confirm Uninstall',
      message: `Are you sure you want to uninstall ${app.title}?`,
      detail: 'This will remove the app from your library. You can reinstall it later from your purchases.'
    });

    if (response !== 0) {
      return { success: false, error: 'Uninstall canceled' };
    }

    // Remove from installed apps
    const updatedApps = installedApps.filter(a => a.marketplaceItemId !== marketplaceItemId);
    store.set('installed-apps', updatedApps);

    // Show notification
    if (Notification.isSupported()) {
      new Notification({
        title: 'Uninstalled',
        body: `${app.title} has been removed`,
        icon: path.join(__dirname, 'company.png'),
      }).show();
    }

    return { success: true };
  } catch (error) {
    console.error('Failed to uninstall app:', error);
    return { success: false, error: error.message };
  }
});

// Open install location in file explorer
ipcMain.handle('open-install-location', async (event, marketplaceItemId) => {
  try {
    const installedApps = store.get('installed-apps', []);
    const app = installedApps.find(a => a.marketplaceItemId === marketplaceItemId);

    if (!app) {
      return { success: false, error: 'App not found' };
    }

    // Open the install directory
    await shell.openPath(app.installPath);
    return { success: true };
  } catch (error) {
    console.error('Failed to open install location:', error);
    return { success: false, error: error.message };
  }
});

// ===== LAUNCHER SETTINGS HANDLERS =====

// Get launcher settings
ipcMain.handle('get-launcher-settings', async () => {
  try {
    const defaultSettings = {
      downloads: {
        autoInstall: false,
        pauseOnLaunch: false,
        location: path.join(app.getPath('userData'), 'downloads')
      },
      notifications: {
        downloadComplete: true,
        updates: true,
        launch: true
      },
      behavior: {
        startOnStartup: false,
        minimizeToTray: false,
        closeAfterLaunch: false
      },
      discord: {
        enabled: true,
        showAppName: true,
        showElapsedTime: true
      },
      storage: {
        cacheSize: 0,
        totalSoftwareSize: 0
      }
    };

    const settings = store.get('launcher-settings', defaultSettings);
    return { success: true, settings };
  } catch (error) {
    console.error('Failed to get launcher settings:', error);
    return { success: false, error: error.message };
  }
});

// Save launcher settings
ipcMain.handle('save-launcher-settings', async (event, settings) => {
  try {
    const oldSettings = store.get('launcher-settings', {});
    store.set('launcher-settings', settings);
    
    // Handle Discord presence changes
    if (discordPresence) {
      const discordChanged = oldSettings.discord?.enabled !== settings.discord?.enabled;
      
      if (discordChanged) {
        if (settings.discord?.enabled) {
          await discordPresence.enable();
        } else {
          await discordPresence.disable();
        }
      }
    }
    
    return { success: true };
  } catch (error) {
    console.error('Failed to save launcher settings:', error);
    return { success: false, error: error.message };
  }
});

// Change download location
ipcMain.handle('change-download-location', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Download Location',
      properties: ['openDirectory', 'createDirectory']
    });

    if (canceled || !filePaths || filePaths.length === 0) {
      return { success: false, error: 'Selection canceled' };
    }

    const newPath = filePaths[0];
    
    // Update settings with new path
    const settings = store.get('launcher-settings', {});
    settings.downloads = settings.downloads || {};
    settings.downloads.location = newPath;
    store.set('launcher-settings', settings);

    return { success: true, path: newPath };
  } catch (error) {
    console.error('Failed to change download location:', error);
    return { success: false, error: error.message };
  }
});

// Clear cache
ipcMain.handle('clear-cache', async () => {
  try {
    const userDataPath = app.getPath('userData');
    const cacheDir = path.join(userDataPath, 'cache');
    
    // Check if cache directory exists
    try {
      await fs.access(cacheDir);
      // Remove all files in cache directory
      const files = await fs.readdir(cacheDir);
      for (const file of files) {
        await fs.unlink(path.join(cacheDir, file));
      }
    } catch (error) {
      // Cache directory doesn't exist or is already empty
    }

    // Show notification
    if (Notification.isSupported()) {
      new Notification({
        title: 'Cache Cleared',
        body: 'All cached files have been removed',
        icon: path.join(__dirname, 'company.png'),
      }).show();
    }

    return { success: true };
  } catch (error) {
    console.error('Failed to clear cache:', error);
    return { success: false, error: error.message };
  }
});

// Get storage info
ipcMain.handle('get-storage-info', async () => {
  try {
    const userDataPath = app.getPath('userData');
    const cacheDir = path.join(userDataPath, 'cache');
    const downloadsDir = path.join(userDataPath, 'downloads');
    
    let cacheSize = 0;
    let downloadSize = 0;
    
    // Calculate cache size
    try {
      const cacheFiles = await fs.readdir(cacheDir);
      for (const file of cacheFiles) {
        const stats = await fs.stat(path.join(cacheDir, file));
        cacheSize += stats.size;
      }
    } catch (error) {
      // Cache directory doesn't exist
    }
    
    // Calculate downloads size
    try {
      const downloadFiles = await fs.readdir(downloadsDir);
      for (const file of downloadFiles) {
        const stats = await fs.stat(path.join(downloadsDir, file));
        downloadSize += stats.size;
      }
    } catch (error) {
      // Downloads directory doesn't exist
    }
    
    // Calculate total installed software size
    const installedApps = store.get('installed-apps', []);
    const totalSoftwareSize = installedApps.reduce((total, app) => total + (app.size || 0), 0);
    
    return {
      success: true,
      cacheSize,
      downloadSize,
      totalSoftwareSize
    };
  } catch (error) {
    console.error('Failed to get storage info:', error);
    return { success: false, error: error.message };
  }
});

// Open folder in explorer
ipcMain.handle('open-folder', async (event, folderPath) => {
  try {
    await shell.openPath(folderPath);
    return { success: true };
  } catch (error) {
    console.error('Failed to open folder:', error);
    return { success: false, error: error.message };
  }
});

// ===== DISCORD RICH PRESENCE HANDLERS =====

// Set Discord presence to idle
ipcMain.handle('discord-set-idle', async () => {
  try {
    if (discordPresence && discordPresence.isActive()) {
      await discordPresence.setIdlePresence();
      return { success: true };
    }
    return { success: false, error: 'Discord presence not active' };
  } catch (error) {
    console.error('Failed to set Discord idle:', error);
    return { success: false, error: error.message };
  }
});

// Check if Discord is connected
ipcMain.handle('discord-is-connected', async () => {
  try {
    const isConnected = discordPresence ? discordPresence.isActive() : false;
    return { success: true, isConnected };
  } catch (error) {
    console.error('Failed to check Discord status:', error);
    return { success: false, error: error.message };
  }
});

// Set Discord update mode
ipcMain.handle('discord-set-mode', async (event, mode) => {
  try {
    if (!discordPresence || !discordPresence.isActive()) {
      return { success: false, error: 'Discord presence not active' };
    }

    switch (mode) {
      case 'aggressive':
        discordPresence.enableAggressiveMode();
        break;
      case 'balanced':
        discordPresence.enableBalancedMode();
        break;
      case 'eco':
        discordPresence.enableEcoMode();
        break;
      default:
        return { success: false, error: 'Invalid mode. Use: aggressive, balanced, or eco' };
    }

    return { success: true, mode };
  } catch (error) {
    console.error('Failed to set Discord mode:', error);
    return { success: false, error: error.message };
  }
});

// Window controls
ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('maximize-window', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('close-window', () => {
  if (mainWindow) mainWindow.close();
});

// Toggle always on top
ipcMain.handle('toggle-always-on-top', async (event, shouldBeOnTop) => {
  try {
    if (mainWindow) {
      mainWindow.setAlwaysOnTop(shouldBeOnTop);
      return { success: true, alwaysOnTop: shouldBeOnTop };
    }
    return { success: false, error: 'Window not found' };
  } catch (error) {
    console.error('Failed to toggle always on top:', error);
    return { success: false, error: error.message };
  }
});

// Get always on top status
ipcMain.handle('get-always-on-top', async () => {
  try {
    if (mainWindow) {
      return { success: true, alwaysOnTop: mainWindow.isAlwaysOnTop() };
    }
    return { success: false, error: 'Window not found' };
  } catch (error) {
    console.error('Failed to get always on top status:', error);
    return { success: false, error: error.message };
  }
});

// ===== WINDOW CREATION =====

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#0f172a',
    frame: false,
    title: 'OTH Launcher',
    icon: path.join(__dirname, 'company.png'),
    alwaysOnTop: true, // Window stays on top of other applications
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
    darkTheme: true,
  });

  // Load the local launcher page first
  mainWindow.loadFile(path.join(__dirname, 'launcher.html'));

  // Listen for navigation events - if user logs out (about:blank), reload launcher
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === 'about:blank') {
      console.log('User logged out, returning to launcher...');
      event.preventDefault();
      mainWindow.loadFile(path.join(__dirname, 'launcher.html'));
    }
  });

  mainWindow.webContents.on('did-navigate', (event, url) => {
    if (url === 'about:blank') {
      console.log('Navigation to about:blank detected, loading launcher...');
      mainWindow.loadFile(path.join(__dirname, 'launcher.html'));
    }
  });

  // Suppress console errors and unhandled rejections
  mainWindow.webContents.on('did-finish-load', () => {
    // Suppress auth-related console errors and IPC errors
    mainWindow.webContents.executeJavaScript(`
      // Catch unhandled promise rejections
      window.addEventListener('unhandledrejection', (event) => {
        console.log('Caught unhandled rejection:', event.reason?.message || event.reason);
        event.preventDefault();
      });
      
      // Suppress specific console errors
      const originalError = console.error;
      console.error = function(...args) {
        const message = args.join(' ');
        // Suppress auth fetch errors and IPC cloning errors during startup
        if (message.includes('ClientFetchError') || 
            message.includes('Unexpected token') ||
            message.includes('not valid JSON') ||
            message.includes('authjs.dev') ||
            message.includes('could not be cloned')) {
          // Silently ignore these errors
          return;
        }
        originalError.apply(console, args);
      };
    `);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Enable F12 to open DevTools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }
    // Also enable Ctrl+Shift+I for DevTools
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.toggleDevTools();
    }
  });
}

// ===== APP LIFECYCLE =====

app.whenReady().then(async () => {
  createWindow();

  // Initialize Discord Rich Presence (if available)
  if (DiscordPresenceManager && DISCORD_CLIENT_ID && DISCORD_CLIENT_ID !== '1234567890123456789') {
    const settings = store.get('launcher-settings', {});
    const discordEnabled = settings.discord?.enabled !== false; // Default to true
    
    if (discordEnabled) {
      discordPresence = new DiscordPresenceManager();
      // Use async init but don't await it - let it run in background
      discordPresence.init(DISCORD_CLIENT_ID, discordEnabled)
        .then(() => {
          // Enable ultra-aggressive mode by default to fight other apps
          if (discordPresence.isActive()) {
            discordPresence.enableUltraAggressiveMode();
            console.log('Discord presence set to ultra-aggressive mode (2s updates)');
          }
        })
        .catch(err => {
          console.log('Discord RPC initialization failed (non-critical):', err.message);
        });
    }
  } else {
    if (!DiscordPresenceManager) {
      console.log('Discord Rich Presence not installed. Run: npm install discord-rpc');
    } else {
      console.log('Discord Rich Presence not configured. Set DISCORD_CLIENT_ID in main.js');
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Cleanup Discord presence
  if (discordPresence) {
    discordPresence.destroy();
  }
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  // Cleanup Discord presence before quitting
  if (discordPresence) {
    await discordPresence.destroy();
  }
});

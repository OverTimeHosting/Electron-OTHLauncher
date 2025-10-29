const { app, BrowserWindow, ipcMain, Notification, safeStorage, shell, dialog, session, globalShortcut } = require('electron');
const path = require('path');
const Store = require('electron-store');
const ModuleManager = require('../modules/module-manager');
const ModuleDockManager = require('../modules/module-dock-manager');
const ModuleWindowManager = require('../modules/module-window-manager');
const UpdateManager = require('../updates/update-manager');
const DownloadQueueManager = require('../downloads/download-queue-manager');
const fs = require('fs').promises;
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const mime = require('mime-types');

// Set app name for notifications and system
app.setName('OTH Launcher');

// Set macOS dock icon
if (process.platform === 'darwin') {
  app.dock?.setIcon(path.join(__dirname, '../../assets/company.png'));
}

// Handle unhandled promise rejections globally
process.on('unhandledRejection', (reason, promise) => {
  console.log('Caught unhandled rejection in main process:', reason?.message || reason);
});

// Try to load Discord RPC (optional dependency)
let DiscordPresenceManager;
try {
  DiscordPresenceManager = require('../discord/presence-manager');
} catch (error) {
  console.log('Discord RPC not available. Run: npm install discord-rpc');
  DiscordPresenceManager = null;
}

const store = new Store({
  encryptionKey: 'oth-secure-storage-key-v1'
});

let mainWindow;
let aiChatWindow = null;
let registerWindow = null;
let discordPresence = null;
let pendingLoginCredentials = null;
let moduleManager = null;
let dockManager = null;
let dockButtonWindow = null; // Floating dock button window
let updateManager = null; // Update manager for auto-updates
let downloadQueueManager = null; // Download queue manager

const DISCORD_CLIENT_ID = '1348861044604534835';

// ===== PERFORMANCE OPTIMIZATIONS =====

// Enable hardware acceleration
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,VaapiVideoEncoder');
app.commandLine.appendSwitch('ignore-gpu-blacklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

// Optimize renderer process
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-frame-rate-limit');

// ===== IPC HANDLERS (Registered Once on App Start) =====

// Handle store connection
ipcMain.handle('connect-to-store', async (event, credentials) => {
  try {
    const storeUrl = process.env.OTH_STORE_URL || 'http://localhost:3000';
    if (mainWindow) {
      // Encode credentials as base64 for URL
      const credentialsJson = JSON.stringify(credentials);
      const credentialsBase64 = Buffer.from(credentialsJson).toString('base64');
      
      // Preload the next.js app before navigating
      await mainWindow.webContents.session.preconnect({
        url: storeUrl,
        numSockets: 4
      });
      
      // Load dashboard directly - it will handle signin invisibly
      mainWindow.loadURL(`${storeUrl}/dashboard#electron-login=${credentialsBase64}`);
      
      // Restore dock state after connection
      setTimeout(() => {
        if (dockManager) {
          dockManager.restoreDockState(mainWindow);
        }
      }, 2000);
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
      pendingLoginCredentials = null;
      return { success: true, credentials: creds };
    }
    return { success: false, error: 'No pending credentials' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Handle user login notification
ipcMain.handle('user-logged-in', async (event, userEmail) => {
  if (Notification.isSupported()) {
    new Notification({
      title: 'Welcome to OTH',
      body: `Logged in as ${userEmail}`,
      icon: path.join(__dirname, '../../assets/company.png'),
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
      icon: path.join(__dirname, '../../assets/company.png'),
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
      icon: path.join(__dirname, '../../assets/company.png'),
      silent: options.silent || false,
      urgency: options.urgency || 'normal',
    });
    
    notification.show();
    
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
      const encrypted = safeStorage.encryptString(JSON.stringify(credentials));
      store.set('user-credentials', encrypted.toString('base64'));
      return { success: true };
    } else {
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
        const buffer = Buffer.from(encrypted, 'base64');
        const decrypted = safeStorage.decryptString(buffer);
        return { success: true, credentials: JSON.parse(decrypted) };
      }
    } else {
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

// ===== UPDATE HANDLERS =====

// Get app version
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// Update check
ipcMain.on('check-for-updates', () => {
  if (updateManager) {
    updateManager.checkForUpdates();
  }
});

// Download update
ipcMain.on('download-update', () => {
  if (updateManager) {
    updateManager.downloadUpdate();
  }
});

// Install update and restart
ipcMain.on('install-update', () => {
  if (updateManager) {
    updateManager.quitAndInstall();
  }
});

// ===== LIBRARY MANAGEMENT HANDLERS =====

// Get all installed apps
ipcMain.handle('get-installed-apps', async () => {
  try {
    const installedApps = store.get('installed-apps', []);
    return { success: true, apps: installedApps };
  } catch (error) {
    console.error('Failed to get installed apps:', error);
    return { success: false, error: error.message, apps: [] };
  }
});

// Check if an app is installed
ipcMain.handle('is-app-installed', async (event, marketplaceItemId) => {
  try {
    const installedApps = store.get('installed-apps', []);
    const isInstalled = installedApps.some(app => app.marketplaceItemId === marketplaceItemId);
    return { success: true, isInstalled };
  } catch (error) {
    console.error('Failed to check if app is installed:', error);
    return { success: false, error: error.message, isInstalled: false };
  }
});

// Launch an installed app
ipcMain.handle('launch-app', async (event, marketplaceItemId) => {
  try {
    const installedApps = store.get('installed-apps', []);
    const app = installedApps.find(app => app.marketplaceItemId === marketplaceItemId);
    
    if (!app) {
      throw new Error('App not found');
    }
    
    console.log('🚀 Launching app:', app.title);
    console.log('📂 Executable path:', app.executablePath);
    
    // Check if it's a demo file (not .exe)
    const fileExtension = path.extname(app.executablePath).toLowerCase();
    
    if (fileExtension !== '.exe') {
      // It's a demo file - open with default application
      console.log('ℹ️ Demo file detected, opening with default application');
      await shell.openPath(app.executablePath);
      return { 
        success: true, 
        message: 'Demo file opened',
        isDemo: true
      };
    }
    
    // It's a real executable - launch it
    console.log('▶️ Spawning executable process');
    const appProcess = spawn(app.executablePath, [], {
      detached: true,
      stdio: 'ignore'
    });
    
    appProcess.unref();
    
    console.log('✅ App launched successfully');
    return { success: true, message: 'App launched successfully' };
  } catch (error) {
    console.error('❌ Failed to launch app:', error);
    return { success: false, error: error.message };
  }
});

// Save downloaded file (called from renderer after authenticated download)
ipcMain.handle('save-downloaded-file', async (event, fileData) => {
  try {
    console.log('💾 Save file request received:', fileData.fileName)
    
    const { fileName, base64Data, downloadPath } = fileData
    
    if (!fileName || !base64Data) {
      console.error('❌ Missing required file data')
      return { success: false, error: 'File name and data are required' }
    }
    
    // Get download path
    let actualDownloadPath = downloadPath
    if (!actualDownloadPath) {
      const settings = store.get('launcher-settings', {})
      if (settings.downloads?.location) {
        actualDownloadPath = settings.downloads.location
      } else {
        try {
          actualDownloadPath = app.getPath('downloads')
        } catch (e) {
          const documentsDir = app.getPath('documents')
          actualDownloadPath = path.join(documentsDir, 'OTH Downloads')
        }
      }
    }
    
    console.log('📁 Download path:', actualDownloadPath)
    
    // Create directory if it doesn't exist
    await fs.mkdir(actualDownloadPath, { recursive: true })
    
    const filePath = path.join(actualDownloadPath, fileName)
    console.log('📄 Full file path:', filePath)
    
    // Convert base64 to buffer and save
    const buffer = Buffer.from(base64Data, 'base64')
    await fs.writeFile(filePath, buffer)
    
    console.log('✅ File saved successfully:', filePath)
    console.log('📊 File size:', buffer.length, 'bytes')
    
    return { 
      success: true, 
      filePath,
      message: 'File saved successfully'
    }
  } catch (error) {
    console.error('❌ Save file error:', error)
    return { 
      success: false, 
      error: error.message || 'Failed to save file'
    }
  }
})

// Download an app (LEGACY - kept for backwards compatibility)
ipcMain.handle('download-app', async (event, downloadInfo) => {
  try {
    console.log('Download request received:', downloadInfo);
    
    const { url, downloadUrl, marketplaceItemId, title, fileName } = downloadInfo;
    const actualUrl = url || downloadUrl;
    
    if (!actualUrl) {
      console.error('No download URL provided');
      return { success: false, error: 'Download URL is required' };
    }
    
    console.log('Download URL:', actualUrl);
    
    // Generate filename if not provided
    const actualFileName = fileName || `${(title || 'download').replace(/[^a-z0-9]/gi, '_')}-${marketplaceItemId || Date.now()}.exe`;
    console.log('Download filename:', actualFileName);
    
    const settings = store.get('launcher-settings', {});
    let downloadPath;
    
    // Get download path with multiple fallbacks
    try {
      if (settings.downloads?.location) {
        downloadPath = settings.downloads.location;
      } else {
        // Try to get downloads folder, fall back to documents/OTH Downloads
        try {
          const downloadsDir = app.getPath('downloads');
          if (downloadsDir) {
            downloadPath = downloadsDir;
          }
        } catch (e) {
          // downloads path not available, use documents
          const documentsDir = app.getPath('documents');
          downloadPath = path.join(documentsDir, 'OTH Downloads');
        }
      }
    } catch (pathError) {
      console.error('Failed to get download path:', pathError);
      // Final fallback to documents/OTH Downloads
      const documentsDir = app.getPath('documents');
      downloadPath = path.join(documentsDir, 'OTH Downloads');
    }
    
    if (!downloadPath) {
      console.error('Download path is still undefined after all fallbacks');
      // Last resort - use temp directory
      downloadPath = app.getPath('temp');
    }
    
    console.log('Download path:', downloadPath);
    
    const filePath = path.join(downloadPath, actualFileName);
    console.log('Full file path:', filePath);
    
    // Create download directory if it doesn't exist
    try {
      await fs.mkdir(downloadPath, { recursive: true });
    } catch (mkdirError) {
      console.error('Failed to create download directory:', mkdirError);
      return { success: false, error: `Could not create download directory: ${mkdirError.message}` };
    }
    
    // For API routes, we need to make a proper HTTP request
    // If URL starts with /, it's a local API route
    if (actualUrl.startsWith('/')) {
      const baseUrl = process.env.OTH_STORE_URL || 'http://localhost:3000';
      const fullUrl = `${baseUrl}${actualUrl}`;
      console.log('Downloading from local API:', fullUrl);
      
      return new Promise((resolve, reject) => {
        http.get(fullUrl, (response) => {
          console.log('Response status:', response.statusCode);
          console.log('Response headers:', response.headers);
          
          if (response.statusCode === 302 || response.statusCode === 301) {
            // Handle redirect
            const redirectUrl = response.headers.location;
            if (redirectUrl) {
              console.log('Following redirect to:', redirectUrl);
              const redirectProtocol = redirectUrl.startsWith('https') ? https : http;
              redirectProtocol.get(redirectUrl, (redirectResponse) => {
                const writeStream = require('fs').createWriteStream(filePath);
                redirectResponse.pipe(writeStream);
                
                writeStream.on('finish', () => {
                  writeStream.close();
                  console.log('Download completed:', filePath);
                  resolve({ success: true, filePath, downloadPath: filePath, message: 'Download completed' });
                });
                
                writeStream.on('error', (error) => {
                  console.error('Write stream error:', error);
                  require('fs').unlink(filePath, () => {}); // Delete partial file
                  reject({ success: false, error: error.message });
                });
              }).on('error', (error) => {
                console.error('Redirect request error:', error);
                reject({ success: false, error: error.message });
              });
            } else {
              console.error('Redirect location header missing');
              reject({ success: false, error: 'Redirect location not found' });
            }
          } else if (response.statusCode === 200) {
            const writeStream = require('fs').createWriteStream(filePath);
            response.pipe(writeStream);
            
            writeStream.on('finish', () => {
              writeStream.close();
              console.log('Download completed:', filePath);
              resolve({ success: true, filePath, downloadPath: filePath, message: 'Download completed' });
            });
            
            writeStream.on('error', (error) => {
              console.error('Write stream error:', error);
              require('fs').unlink(filePath, () => {}); // Delete partial file
              reject({ success: false, error: error.message });
            });
          } else {
            console.error('Unexpected status code:', response.statusCode);
            reject({ success: false, error: `Download failed with status ${response.statusCode}` });
          }
        }).on('error', (error) => {
          console.error('HTTP request error:', error);
          reject({ success: false, error: error.message });
        });
      });
    } else {
      // External URL
      console.log('Downloading from external URL:', actualUrl);
      const protocol = actualUrl.startsWith('https') ? https : http;
      
      return new Promise((resolve, reject) => {
        protocol.get(actualUrl, (response) => {
          console.log('Response status:', response.statusCode);
          
          if (response.statusCode === 302 || response.statusCode === 301) {
            // Handle redirect
            const redirectUrl = response.headers.location;
            if (redirectUrl) {
              console.log('Following redirect to:', redirectUrl);
              const redirectProtocol = redirectUrl.startsWith('https') ? https : http;
              redirectProtocol.get(redirectUrl, (redirectResponse) => {
                const writeStream = require('fs').createWriteStream(filePath);
                redirectResponse.pipe(writeStream);
                
                writeStream.on('finish', () => {
                  writeStream.close();
                  console.log('Download completed:', filePath);
                  resolve({ success: true, filePath, downloadPath: filePath, message: 'Download completed' });
                });
                
                writeStream.on('error', (error) => {
                  console.error('Write stream error:', error);
                  require('fs').unlink(filePath, () => {}); // Delete partial file
                  reject({ success: false, error: error.message });
                });
              }).on('error', (error) => {
                console.error('Redirect request error:', error);
                reject({ success: false, error: error.message });
              });
            } else {
              console.error('Redirect location header missing');
              reject({ success: false, error: 'Redirect location not found' });
            }
          } else if (response.statusCode === 200) {
            const writeStream = require('fs').createWriteStream(filePath);
            response.pipe(writeStream);
            
            writeStream.on('finish', () => {
              writeStream.close();
              console.log('Download completed:', filePath);
              resolve({ success: true, filePath, downloadPath: filePath, message: 'Download completed' });
            });
            
            writeStream.on('error', (error) => {
              console.error('Write stream error:', error);
              require('fs').unlink(filePath, () => {}); // Delete partial file
              reject({ success: false, error: error.message });
            });
          } else {
            console.error('Unexpected status code:', response.statusCode);
            reject({ success: false, error: `Download failed with status ${response.statusCode}` });
          }
        }).on('error', (error) => {
          console.error('HTTP request error:', error);
          reject({ success: false, error: error.message });
        });
      });
    }
  } catch (error) {
    console.error('Download handler error:', error);
    return { success: false, error: error.message || 'Failed to download application' };
  }
});

// Register app installation
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
        updatedAt: new Date().toISOString()
      };
    } else {
      // Add new installation
      installedApps.push({
        ...installInfo,
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
    
    store.set('installed-apps', installedApps);
    return { success: true, message: 'Installation registered successfully' };
  } catch (error) {
    console.error('Failed to register installation:', error);
    return { success: false, error: error.message };
  }
});

// Uninstall an app
ipcMain.handle('uninstall-app', async (event, marketplaceItemId) => {
  try {
    const installedApps = store.get('installed-apps', []);
    const app = installedApps.find(app => app.marketplaceItemId === marketplaceItemId);
    
    if (!app) {
      throw new Error('App not found in installed apps list');
    }
    
    console.log('🗑️ Starting uninstallation of:', app.title);
    
    // Track what we've deleted for the response
    const deletedItems = [];
    const errors = [];
    
    // 1. Delete the executable file if it exists
    if (app.executablePath) {
      try {
        console.log('📂 Deleting executable:', app.executablePath);
        const fileExists = await fs.access(app.executablePath).then(() => true).catch(() => false);
        if (fileExists) {
          await fs.unlink(app.executablePath);
          deletedItems.push(`Executable: ${path.basename(app.executablePath)}`);
          console.log('✅ Executable deleted');
        }
      } catch (err) {
        console.error('❌ Failed to delete executable:', err);
        errors.push(`Executable: ${err.message}`);
      }
    }
    
    // 2. Delete the installation directory if it exists
    if (app.installPath) {
      try {
        console.log('📁 Deleting installation directory:', app.installPath);
        const dirExists = await fs.access(app.installPath).then(() => true).catch(() => false);
        if (dirExists) {
          // Get directory size before deletion for reporting
          let dirSize = 0;
          try {
            const files = await fs.readdir(app.installPath, { recursive: true });
            for (const file of files) {
              try {
                const filePath = path.join(app.installPath, file);
                const stats = await fs.stat(filePath);
                if (stats.isFile()) {
                  dirSize += stats.size;
                }
              } catch (e) {
                // Skip files we can't stat
              }
            }
          } catch (e) {
            console.log('Could not calculate directory size');
          }
          
          await fs.rm(app.installPath, { recursive: true, force: true });
          deletedItems.push(`Installation folder (${formatBytes(dirSize)})`);
          console.log('✅ Installation directory deleted');
        }
      } catch (err) {
        console.error('❌ Failed to delete installation directory:', err);
        errors.push(`Installation directory: ${err.message}`);
      }
    }
    
    // 3. Delete desktop shortcut if it was created
    try {
      const desktopPath = app.getPath('desktop');
      const shortcutName = `${app.title}.lnk`;
      const shortcutPath = path.join(desktopPath, shortcutName);
      
      console.log('🔗 Checking for desktop shortcut:', shortcutPath);
      const shortcutExists = await fs.access(shortcutPath).then(() => true).catch(() => false);
      if (shortcutExists) {
        await fs.unlink(shortcutPath);
        deletedItems.push('Desktop shortcut');
        console.log('✅ Desktop shortcut deleted');
      }
    } catch (err) {
      console.error('❌ Failed to delete desktop shortcut:', err);
      errors.push(`Desktop shortcut: ${err.message}`);
    }
    
    // 4. Delete start menu shortcut if it was created
    if (process.platform === 'win32') {
      try {
        const startMenuPath = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
        const shortcutName = `${app.title}.lnk`;
        const shortcutPath = path.join(startMenuPath, shortcutName);
        
        console.log('📌 Checking for start menu shortcut:', shortcutPath);
        const shortcutExists = await fs.access(shortcutPath).then(() => true).catch(() => false);
        if (shortcutExists) {
          await fs.unlink(shortcutPath);
          deletedItems.push('Start menu shortcut');
          console.log('✅ Start menu shortcut deleted');
        }
      } catch (err) {
        console.error('❌ Failed to delete start menu shortcut:', err);
        errors.push(`Start menu shortcut: ${err.message}`);
      }
    }
    
    // 5. Remove from installed apps list
    const updatedApps = installedApps.filter(a => a.marketplaceItemId !== marketplaceItemId);
    store.set('installed-apps', updatedApps);
    console.log('✅ Removed from installed apps list');
    
    // Helper function for formatting bytes
    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }
    
    // Send notification
    if (Notification.isSupported()) {
      new Notification({
        title: 'Uninstallation Complete',
        body: `${app.title} has been removed from your system`,
        icon: path.join(__dirname, '../../assets/company.png'),
      }).show();
    }
    
    console.log('🎉 Uninstallation complete!');
    console.log('Deleted items:', deletedItems);
    if (errors.length > 0) {
      console.log('Errors encountered:', errors);
    }
    
    return { 
      success: true, 
      message: 'App uninstalled successfully',
      deletedItems,
      errors: errors.length > 0 ? errors : undefined
    };
  } catch (error) {
    console.error('❌ Uninstallation failed:', error);
    
    // Send error notification
    if (Notification.isSupported()) {
      new Notification({
        title: 'Uninstallation Failed',
        body: error.message,
        icon: path.join(__dirname, '../../assets/company.png'),
      }).show();
    }
    
    return { success: false, error: error.message };
  }
});

// Open app install location
ipcMain.handle('open-install-location', async (event, marketplaceItemId) => {
  try {
    const installedApps = store.get('installed-apps', []);
    const app = installedApps.find(app => app.marketplaceItemId === marketplaceItemId);
    
    if (!app || !app.installPath) {
      throw new Error('App install location not found');
    }
    
    await shell.openPath(app.installPath);
    return { success: true };
  } catch (error) {
    console.error('Failed to open install location:', error);
    return { success: false, error: error.message };
  }
});

// ===== DOWNLOAD QUEUE HANDLERS =====

// Get all download queues
ipcMain.handle('get-download-queues', async () => {
  try {
    if (!downloadQueueManager) {
      throw new Error('Download queue manager not initialized');
    }

    const queues = downloadQueueManager.getAllQueues();
    const stats = downloadQueueManager.getStats();

    return { success: true, queues, stats };
  } catch (error) {
    console.error('Failed to get download queues:', error);
    return { success: false, error: error.message, queues: { scheduled: [], upNext: [], complete: [], activeDownloads: [] }, stats: { scheduled: 0, upNext: 0, complete: 0, active: 0, paused: 0 } };
  }
});

// Add module to download queue
ipcMain.handle('add-to-download-queue', async (event, moduleInfo) => {
  try {
    if (!downloadQueueManager) {
      throw new Error('Download queue manager not initialized');
    }

    const download = downloadQueueManager.addToQueue(moduleInfo);
    return { success: true, download };
  } catch (error) {
    console.error('Failed to add to download queue:', error);
    return { success: false, error: error.message };
  }
});

// Start next download
ipcMain.handle('start-next-download', async () => {
  try {
    if (!downloadQueueManager) {
      throw new Error('Download queue manager not initialized');
    }

    const download = await downloadQueueManager.startNextDownload();
    return { success: true, download };
  } catch (error) {
    console.error('Failed to start next download:', error);
    return { success: false, error: error.message };
  }
});

// Move to up next
ipcMain.handle('move-to-up-next', async (event, downloadId) => {
  try {
    if (!downloadQueueManager) {
      throw new Error('Download queue manager not initialized');
    }

    const download = downloadQueueManager.moveToUpNext(downloadId);
    return { success: true, download };
  } catch (error) {
    console.error('Failed to move to up next:', error);
    return { success: false, error: error.message };
  }
});

// Move to scheduled
ipcMain.handle('move-to-scheduled', async (event, downloadId) => {
  try {
    if (!downloadQueueManager) {
      throw new Error('Download queue manager not initialized');
    }

    const download = downloadQueueManager.moveToScheduled(downloadId);
    return { success: true, download };
  } catch (error) {
    console.error('Failed to move to scheduled:', error);
    return { success: false, error: error.message };
  }
});

// Remove from queue
ipcMain.handle('remove-from-queue', async (event, downloadId) => {
  try {
    if (!downloadQueueManager) {
      throw new Error('Download queue manager not initialized');
    }

    const result = downloadQueueManager.removeFromQueue(downloadId);
    return { success: result };
  } catch (error) {
    console.error('Failed to remove from queue:', error);
    return { success: false, error: error.message };
  }
});

// Clear completed downloads
ipcMain.handle('clear-completed', async () => {
  try {
    if (!downloadQueueManager) {
      throw new Error('Download queue manager not initialized');
    }

    downloadQueueManager.clearCompleted();
    return { success: true };
  } catch (error) {
    console.error('Failed to clear completed:', error);
    return { success: false, error: error.message };
  }
});

// Remove from completed
ipcMain.handle('remove-from-completed', async (event, downloadId) => {
  try {
    if (!downloadQueueManager) {
      throw new Error('Download queue manager not initialized');
    }

    const result = downloadQueueManager.removeFromCompleted(downloadId);
    return { success: result };
  } catch (error) {
    console.error('Failed to remove from completed:', error);
    return { success: false, error: error.message };
  }
});

// Install from downloaded file
ipcMain.handle('install-from-download', async (event, downloadId) => {
  try {
    if (!downloadQueueManager || !moduleManager) {
      throw new Error('Manager not initialized');
    }

    const download = downloadQueueManager.getDownload(downloadId);
    if (!download) {
      throw new Error('Download not found');
    }

    if (download.status !== 'complete') {
      throw new Error('Download not complete');
    }

    // Install the module using ModuleManager
    const result = await moduleManager.installModule(download.filePath, download);
    
    if (Notification.isSupported()) {
      new Notification({
        title: 'Module Installed',
        body: `${download.displayName} has been installed successfully`,
        icon: path.join(__dirname, '../../assets/company.png'),
      }).show();
    }

    return result;
  } catch (error) {
    console.error('❌ Install from download failed:', error);
    return { success: false, error: error.message };
  }
});

// ===== MODULE MANAGEMENT HANDLERS (NEW SYSTEM) =====

// Download and install a module
ipcMain.handle('download-module', async (event, moduleInfo) => {
  try {
    if (!moduleManager) {
      throw new Error('Module manager not initialized');
    }

    console.log('🧩 Module download request:', moduleInfo);
    const { id, name, displayName, downloadUrl, version, category } = moduleInfo;
    
    if (!downloadUrl) {
      throw new Error('Download URL is required');
    }

    // Generate filename
    const fileName = `${name.replace(/[^a-z0-9]/gi, '_')}-v${version}.zip`;
    const settings = store.get('launcher-settings', {});
    let downloadPath;
    
    // Get download path
    try {
      if (settings.downloads?.location) {
        downloadPath = settings.downloads.location;
      } else {
        try {
          downloadPath = app.getPath('downloads');
        } catch (e) {
          downloadPath = path.join(app.getPath('documents'), 'OTH Downloads', 'Modules');
        }
      }
    } catch (pathError) {
      downloadPath = path.join(app.getPath('documents'), 'OTH Downloads', 'Modules');
    }

    const filePath = path.join(downloadPath, fileName);
    await fs.mkdir(downloadPath, { recursive: true });

    // Download the file
    const baseUrl = process.env.OTH_STORE_URL || 'http://localhost:3000';
    const fullUrl = downloadUrl.startsWith('/') ? `${baseUrl}${downloadUrl}` : downloadUrl;
    const protocol = fullUrl.startsWith('https') ? https : http;

    await new Promise((resolve, reject) => {
      protocol.get(fullUrl, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            const redirectProtocol = redirectUrl.startsWith('https') ? https : http;
            redirectProtocol.get(redirectUrl, (redirectResponse) => {
              const writeStream = require('fs').createWriteStream(filePath);
              redirectResponse.pipe(writeStream);
              writeStream.on('finish', () => {
                writeStream.close();
                resolve();
              });
              writeStream.on('error', reject);
            }).on('error', reject);
          } else {
            reject(new Error('Redirect location not found'));
          }
        } else if (response.statusCode === 200) {
          const writeStream = require('fs').createWriteStream(filePath);
          response.pipe(writeStream);
          writeStream.on('finish', () => {
            writeStream.close();
            resolve();
          });
          writeStream.on('error', reject);
        } else {
          reject(new Error(`Download failed with status ${response.statusCode}`));
        }
      }).on('error', reject);
    });

    // Install the module using ModuleManager
    const result = await moduleManager.installModule(filePath, moduleInfo);
    
    if (Notification.isSupported()) {
      new Notification({
        title: 'Module Installed',
        body: `${displayName} has been installed successfully`,
        icon: path.join(__dirname, '../../assets/company.png'),
      }).show();
    }

    return result;
  } catch (error) {
    console.error('❌ Module download/install failed:', error);
    return { success: false, error: error.message || 'Failed to download/install module' };
  }
});

// Get installed modules (including dev modules for testing)
ipcMain.handle('get-installed-modules', async () => {
  try {
    if (!moduleManager) {
      throw new Error('Module manager not initialized');
    }

    // Use getAllModulesWithDev to include modules from the /modules folder for testing
    const modules = await moduleManager.getAllModulesWithDev();
    return { success: true, modules };
  } catch (error) {
    console.error('Failed to get installed modules:', error);
    return { success: false, error: error.message, modules: [] };
  }
});

// Uninstall a module
ipcMain.handle('uninstall-module', async (event, moduleId) => {
  try {
    if (!moduleManager) {
      throw new Error('Module manager not initialized');
    }

    const result = await moduleManager.uninstallModule(moduleId);
    
    if (Notification.isSupported()) {
      new Notification({
        title: 'Module Uninstalled',
        body: result.message,
        icon: path.join(__dirname, '../../assets/company.png'),
      }).show();
    }

    return result;
  } catch (error) {
    console.error('❌ Module uninstall failed:', error);
    return { success: false, error: error.message };
  }
});

// Enable a module (including dev modules)
ipcMain.handle('enable-module', async (event, moduleId) => {
  try {
    if (!moduleManager) {
      throw new Error('Module manager not initialized');
    }

    // Check if it's a dev module - if so, just load it without saving to store
    const module = moduleManager.getInstalledModule(moduleId);
    if (module && module.isDev) {
      console.log('🔌 Enabling dev module:', module.displayName);
      await moduleManager.loadModule(module);
      module.enabled = true;
      moduleManager.installedModules.set(moduleId, module);
      moduleManager.activeModules.set(moduleId, module);
      return {
        success: true,
        message: `${module.displayName} enabled (dev mode)`,
      };
    }

    const result = await moduleManager.enableModule(moduleId);
    return result;
  } catch (error) {
    console.error('❌ Failed to enable module:', error);
    return { success: false, error: error.message };
  }
});

// Disable a module (including dev modules)
ipcMain.handle('disable-module', async (event, moduleId) => {
  try {
    if (!moduleManager) {
      throw new Error('Module manager not initialized');
    }

    // Check if it's a dev module - if so, just unload it without saving to store
    const module = moduleManager.getInstalledModule(moduleId);
    if (module && module.isDev) {
      console.log('🔌 Disabling dev module:', module.displayName);
      await moduleManager.unloadModule(module);
      module.enabled = false;
      moduleManager.installedModules.set(moduleId, module);
      moduleManager.activeModules.delete(moduleId);
      return {
        success: true,
        message: `${module.displayName} disabled (dev mode)`,
      };
    }

    const result = await moduleManager.disableModule(moduleId);
    return result;
  } catch (error) {
    console.error('❌ Failed to disable module:', error);
    return { success: false, error: error.message };
  }
});

// Get module settings
ipcMain.handle('get-module-settings', async (event, moduleId) => {
  try {
    if (!moduleManager) {
      throw new Error('Module manager not initialized');
    }

    const settings = moduleManager.getModuleSettings(moduleId);
    return { success: true, settings };
  } catch (error) {
    console.error('Failed to get module settings:', error);
    return { success: false, error: error.message };
  }
});

// Save module settings
ipcMain.handle('save-module-settings', async (event, moduleId, settings) => {
  try {
    if (!moduleManager) {
      throw new Error('Module manager not initialized');
    }

    moduleManager.saveModuleSettings(moduleId, settings);
    return { success: true, message: 'Settings saved successfully' };
  } catch (error) {
    console.error('Failed to save module settings:', error);
    return { success: false, error: error.message };
  }
});

// Check for module updates
ipcMain.handle('check-module-updates', async (event, moduleIds) => {
  try {
    if (!moduleManager) {
      throw new Error('Module manager not initialized');
    }

    const updates = await moduleManager.checkForUpdates(moduleIds);
    return { success: true, updates };
  } catch (error) {
    console.error('Failed to check module updates:', error);
    return { success: false, error: error.message, updates: [] };
  }
});

// Launch module window
ipcMain.handle('launch-module-window', async (event, moduleId) => {
  try {
    console.log('🚀 [IPC] Launch module window request for:', moduleId);
    
    if (!moduleManager || !mainWindow) {
      throw new Error('Module manager or main window not initialized');
    }

    const module = moduleManager.getInstalledModule(moduleId);
    if (!module) {
      console.error('❌ Module not found:', moduleId);
      throw new Error('Module not found');
    }

    console.log('📦 Module found:', module.displayName);
    console.log('🏠 Has window:', module.hasWindow);
    console.log('📄 Window file:', module.window);
    console.log('📁 Install path:', module.installPath);

    // Get dock window if available
    const dockWindow = dockManager ? dockManager.getDockWindow() : null;
    console.log('🎨 Dock window available:', !!dockWindow);

    const result = await ModuleWindowManager.launchModuleWindow(module, mainWindow, dockWindow);
    console.log('✅ Module window manager result:', result);
    return result;
  } catch (error) {
    console.error('❌ Failed to launch module window:', error);
    console.error('Stack trace:', error.stack);
    return { success: false, error: error.message };
  }
});

// ===== SCREEN CAPTURE HANDLERS (For Clipper Module) =====

let captureOverlayWindow = null;

// Capture region
ipcMain.handle('capture-region', async (event, bounds) => {
  try {
    console.log('📸 Capturing region:', bounds);
    
    const { desktopCapturer, nativeImage, clipboard, screen: electronScreen, Notification: ElectronNotification } = require('electron');
    
    // CRITICAL: Hide the capture overlay window BEFORE taking the screenshot
    if (captureOverlayWindow && !captureOverlayWindow.isDestroyed()) {
      captureOverlayWindow.hide();
      // Wait a moment for the window to actually disappear from screen
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Get all screens
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: electronScreen.getPrimaryDisplay().size
    });

    if (sources.length === 0) {
      throw new Error('No screens found');
    }

    // Use primary screen
    const primaryScreen = sources[0];
    const fullImage = primaryScreen.thumbnail;
    
    // Get scale factor
    const scaleFactor = electronScreen.getPrimaryDisplay().scaleFactor;
    
    // Crop to selected region with scale factor
    const croppedImage = fullImage.crop({
      x: Math.floor(bounds.x * scaleFactor),
      y: Math.floor(bounds.y * scaleFactor),
      width: Math.floor(bounds.width * scaleFactor),
      height: Math.floor(bounds.height * scaleFactor)
    });

    // Get module settings
    const settings = moduleManager ? moduleManager.getModuleSettings('screen-clipper-v1') : {};
    
    // Copy to clipboard if enabled
    if (settings.copyToClipboard !== false) {
      clipboard.writeImage(croppedImage);
      console.log('📋 Image copied to clipboard');
    }

    // Auto-save if enabled
    let savedPath = null;
    if (settings.autoSave !== false) {
      savedPath = await saveScreenshot(croppedImage, settings);
      console.log('💾 Screenshot saved:', savedPath);
    }

    // Show notification if enabled
    if (settings.showNotification !== false) {
      if (Notification.isSupported()) {
        new Notification({
          title: 'Screenshot Captured',
          body: savedPath ? `Saved to ${path.basename(savedPath)}` : 'Copied to clipboard',
          icon: path.join(__dirname, '../../assets/company.png'),
        }).show();
      }
    }

    // Close capture overlay
    if (captureOverlayWindow && !captureOverlayWindow.isDestroyed()) {
      captureOverlayWindow.close();
      captureOverlayWindow = null;
    }

    return { success: true, path: savedPath };
  } catch (error) {
    console.error('❌ Failed to capture region:', error);
    return { success: false, error: error.message };
  }
});

// Cancel capture
ipcMain.handle('cancel-capture', async () => {
  try {
    console.log('❌ Canceling capture');
    
    if (captureOverlayWindow && !captureOverlayWindow.isDestroyed()) {
      captureOverlayWindow.close();
      captureOverlayWindow = null;
    }
    
    return { success: true };
  } catch (error) {
    console.error('❌ Failed to cancel capture:', error);
    return { success: false, error: error.message };
  }
});

// Capture fullscreen
ipcMain.handle('capture-fullscreen', async () => {
  try {
    console.log('📸 Capturing fullscreen');
    
    const { desktopCapturer, clipboard, screen: electronScreen, Notification: ElectronNotification } = require('electron');
    
    // Hide any capture overlay if open
    if (captureOverlayWindow && !captureOverlayWindow.isDestroyed()) {
      captureOverlayWindow.hide();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: electronScreen.getPrimaryDisplay().size
    });

    if (sources.length === 0) {
      throw new Error('No screens found');
    }

    const primaryScreen = sources[0];
    const image = primaryScreen.thumbnail;
    
    // Get module settings
    const settings = moduleManager ? moduleManager.getModuleSettings('screen-clipper-v1') : {};
    
    // Copy to clipboard if enabled
    if (settings.copyToClipboard !== false) {
      clipboard.writeImage(image);
      console.log('📋 Image copied to clipboard');
    }

    // Auto-save if enabled
    let savedPath = null;
    if (settings.autoSave !== false) {
      savedPath = await saveScreenshot(image, settings);
      console.log('💾 Screenshot saved:', savedPath);
    }

    // Show notification if enabled
    if (settings.showNotification !== false) {
      if (Notification.isSupported()) {
        new Notification({
          title: 'Screenshot Captured',
          body: savedPath ? `Saved to ${path.basename(savedPath)}` : 'Copied to clipboard',
          icon: path.join(__dirname, '../../assets/company.png'),
        }).show();
      }
    }

    return { success: true, path: savedPath };
  } catch (error) {
    console.error('❌ Failed to capture fullscreen:', error);
    return { success: false, error: error.message };
  }
});

// Helper function to save screenshot
async function saveScreenshot(image, settings) {
  try {
    // Get save location
    let saveDir = settings.saveLocation || path.join(app.getPath('pictures'), 'OTH Clips');
    
    // Create directory if it doesn't exist
    await fs.mkdir(saveDir, { recursive: true });

    // Generate filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const format = settings.imageFormat || 'png';
    const filename = `screenshot-${timestamp}.${format}`;
    const filepath = path.join(saveDir, filename);

    // Get image buffer based on format
    let buffer;
    if (format === 'jpg' || format === 'jpeg') {
      const quality = settings.jpegQuality || 90;
      buffer = image.toJPEG(quality);
    } else if (format === 'webp') {
      buffer = image.toPNG(); // Electron doesn't support webp export, use PNG
    } else {
      buffer = image.toPNG();
    }

    // Save file
    await fs.writeFile(filepath, buffer);
    
    return filepath;
  } catch (error) {
    console.error('Failed to save screenshot:', error);
    throw error;
  }
}

// Function to open capture overlay
function openCaptureOverlay() {
  try {
    // Close existing overlay if open
    if (captureOverlayWindow && !captureOverlayWindow.isDestroyed()) {
      captureOverlayWindow.close();
    }

    console.log('📸 Opening capture overlay');

    // Get primary display bounds
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.bounds;

    // Create fullscreen overlay window
    captureOverlayWindow = new BrowserWindow({
      width: width,
      height: height,
      x: 0,
      y: 0,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      fullscreen: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Load clipper HTML
    const clipperPath = path.join(__dirname, '../../modules/screen-clipper/clipper.html');
    captureOverlayWindow.loadFile(clipperPath);

    // Handle window close
    captureOverlayWindow.on('closed', () => {
      captureOverlayWindow = null;
    });

    console.log('✅ Capture overlay opened');
  } catch (error) {
    console.error('❌ Failed to open capture overlay:', error);
  }
}

// Get all clips from save directory
ipcMain.handle('get-clips', async () => {
  try {
    const settings = moduleManager ? moduleManager.getModuleSettings('screen-clipper-v1') : {};
    let saveDir = settings.saveLocation || path.join(app.getPath('pictures'), 'OTH Clips');
    
    console.log('📂 Loading clips from:', saveDir);
    
    // Check if directory exists
    try {
      await fs.access(saveDir);
    } catch (error) {
      // Directory doesn't exist yet
      return { success: true, clips: [] };
    }
    
    // Read directory
    const files = await fs.readdir(saveDir);
    
    // Filter for image files
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
    const imageFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return imageExtensions.includes(ext);
    });
    
    // Get file info for each image
    const clips = await Promise.all(imageFiles.map(async (filename) => {
      const filepath = path.join(saveDir, filename);
      const stats = await fs.stat(filepath);
      
      return {
        filename,
        filepath,
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
      };
    }));
    
    // Sort by creation date (newest first)
    clips.sort((a, b) => b.created.getTime() - a.created.getTime());
    
    console.log(`✅ Found ${clips.length} clips`);
    
    return { success: true, clips };
  } catch (error) {
    console.error('❌ Failed to get clips:', error);
    return { success: false, error: error.message, clips: [] };
  }
});

// Delete a clip
ipcMain.handle('delete-clip', async (event, filepath) => {
  try {
    console.log('🗑️ Deleting clip:', filepath);
    
    await fs.unlink(filepath);
    
    console.log('✅ Clip deleted');
    
    return { success: true };
  } catch (error) {
    console.error('❌ Failed to delete clip:', error);
    return { success: false, error: error.message };
  }
});

// Open clip in default viewer
ipcMain.handle('open-clip', async (event, filepath) => {
  try {
    console.log('👁️ Opening clip:', filepath);
    
    await shell.openPath(filepath);
    
    return { success: true };
  } catch (error) {
    console.error('❌ Failed to open clip:', error);
    return { success: false, error: error.message };
  }
});

// Open clips folder
ipcMain.handle('open-clips-folder', async () => {
  try {
    const settings = moduleManager ? moduleManager.getModuleSettings('screen-clipper-v1') : {};
    let saveDir = settings.saveLocation || path.join(app.getPath('pictures'), 'OTH Clips');
    
    console.log('📁 Opening clips folder:', saveDir);
    
    // Create directory if it doesn't exist
    await fs.mkdir(saveDir, { recursive: true });
    
    await shell.openPath(saveDir);
    
    return { success: true };
  } catch (error) {
    console.error('❌ Failed to open clips folder:', error);
    return { success: false, error: error.message };
  }
});

// ===== LAUNCHER SETTINGS HANDLERS =====

// Get launcher settings
ipcMain.handle('get-launcher-settings', async () => {
  try {
    let downloadLocation;
    try {
      downloadLocation = app.getPath('downloads');
    } catch (e) {
      downloadLocation = path.join(app.getPath('documents'), 'OTH Downloads');
    }

    const settings = store.get('launcher-settings', {
      downloads: {
        autoInstall: false,
        pauseOnLaunch: false,
        location: downloadLocation
      },
      notifications: {
        downloadComplete: true,
        updates: true,
        launch: false
      },
      behavior: {
        startOnStartup: false,
        minimizeToTray: true,
        closeAfterLaunch: false
      },
      discord: {
        enabled: true,
        showAppName: true,
        showElapsedTime: true
      }
    });
    
    // Ensure downloads.location exists
    if (!settings.downloads) {
      settings.downloads = {
        autoInstall: false,
        pauseOnLaunch: false,
        location: downloadLocation
      };
    } else if (!settings.downloads.location) {
      settings.downloads.location = downloadLocation;
    }
    
    return { success: true, settings };
  } catch (error) {
    console.error('Failed to get launcher settings:', error);
    return { success: false, error: error.message };
  }
});

// Save launcher settings
ipcMain.handle('save-launcher-settings', async (event, settings) => {
  try {
    store.set('launcher-settings', settings);
    
    // Update Discord presence if discord settings changed
    if (settings.discord && discordPresence) {
      if (settings.discord.enabled) {
        // Reinitialize Discord with new settings
        try {
          await discordPresence.init(DISCORD_CLIENT_ID, true);
          if (discordPresence.isActive()) {
            discordPresence.enableUltraAggressiveMode();
          }
        } catch (err) {
          console.log('Discord RPC update failed:', err.message);
        }
      } else {
        await discordPresence.destroy();
      }
    }
    
    return { success: true, message: 'Settings saved successfully' };
  } catch (error) {
    console.error('Failed to save launcher settings:', error);
    return { success: false, error: error.message };
  }
});

// Change download location
ipcMain.handle('change-download-location', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Download Location'
    });
    
    if (result.canceled) {
      return { success: false, canceled: true };
    }
    
    const newPath = result.filePaths[0];
    const settings = store.get('launcher-settings', {});
    
    // Update the downloads.location property
    if (!settings.downloads) {
      settings.downloads = {};
    }
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
    if (mainWindow) {
      await mainWindow.webContents.session.clearCache();
      await mainWindow.webContents.session.clearStorageData();
    }
    return { success: true, message: 'Cache cleared successfully' };
  } catch (error) {
    console.error('Failed to clear cache:', error);
    return { success: false, error: error.message };
  }
});

// Get storage info
ipcMain.handle('get-storage-info', async () => {
  try {
    const settings = store.get('launcher-settings', {});
    const downloadPath = settings.downloads?.location || app.getPath('downloads');
    const installedApps = store.get('installed-apps', []);
    
    // Calculate cache size (Electron cache)
    let cacheSize = 0;
    try {
      const cachePath = app.getPath('userData');
      const cacheStats = await fs.stat(path.join(cachePath, 'Cache'));
      if (cacheStats.isDirectory()) {
        const cacheFiles = await fs.readdir(path.join(cachePath, 'Cache'));
        for (const file of cacheFiles) {
          try {
            const filePath = path.join(cachePath, 'Cache', file);
            const stats = await fs.stat(filePath);
            if (stats.isFile()) {
              cacheSize += stats.size;
            }
          } catch (err) {
            // Skip files we can't read
          }
        }
      }
    } catch (err) {
      console.log('Could not calculate cache size:', err.message);
    }
    
    // Calculate download folder size
    let downloadSize = 0;
    try {
      const downloadFiles = await fs.readdir(downloadPath);
      for (const file of downloadFiles) {
        try {
          const filePath = path.join(downloadPath, file);
          const stats = await fs.stat(filePath);
          if (stats.isFile()) {
            downloadSize += stats.size;
          }
        } catch (err) {
          // Skip files we can't read
        }
      }
    } catch (err) {
      console.log('Could not calculate download size:', err.message);
    }
    
    // Calculate total size of installed apps
    let totalSoftwareSize = 0;
    for (const app of installedApps) {
      if (app.size) {
        totalSoftwareSize += app.size;
      }
    }
    
    return {
      success: true,
      cacheSize,
      downloadSize,
      totalSoftwareSize,
      info: {
        downloadPath,
        installedAppsCount: installedApps.length,
        totalSize: totalSoftwareSize
      }
    };
  } catch (error) {
    console.error('Failed to get storage info:', error);
    return { success: false, error: error.message };
  }
});

// Open folder
ipcMain.handle('open-folder', async (event, folderPath) => {
  try {
    await shell.openPath(folderPath);
    return { success: true };
  } catch (error) {
    console.error('Failed to open folder:', error);
    return { success: false, error: error.message };
  }
});

// Uninstall the launcher itself
ipcMain.handle('uninstall-launcher', async () => {
  try {
    console.log('🗑️ Starting launcher self-uninstall process...');
    
    if (process.platform === 'win32') {
      // On Windows, the NSIS installer creates an uninstaller
      const { execFile } = require('child_process');
      const uninstallerPath = path.join(path.dirname(app.getPath('exe')), '..', 'Uninstall OTHLauncher.exe');
      
      // Check if the uninstaller exists
      try {
        await fs.access(uninstallerPath);
        
        // Show confirmation
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Uninstall OTH Launcher',
          message: 'Are you sure you want to uninstall OTH Launcher?',
          detail: 'This will remove the launcher from your computer. Your purchased software will remain in your account and can be downloaded again later.',
          buttons: ['Cancel', 'Uninstall'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        });
        
        if (result.response === 1) {
          // User confirmed - run the uninstaller
          console.log('✅ User confirmed uninstall, launching uninstaller...');
          
          // Close the launcher first
          execFile(uninstallerPath, [], { detached: true });
          
          // Wait a moment then quit
          setTimeout(() => {
            app.quit();
          }, 500);
          
          return { success: true, message: 'Uninstaller launched' };
        } else {
          console.log('❌ User canceled uninstall');
          return { success: false, canceled: true };
        }
      } catch (err) {
        // Uninstaller not found - we're probably in development or portable mode
        console.log('ℹ️ NSIS uninstaller not found, using manual cleanup...');
        
        // Manual cleanup for portable/dev mode
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Remove OTH Launcher',
          message: 'Are you sure you want to remove OTH Launcher?',
          detail: 'This will delete all launcher data. Your purchased software will remain in your account.',
          buttons: ['Cancel', 'Remove'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        });
        
        if (result.response === 1) {
          // Create a cleanup script
          const cleanupScript = `
@echo off
title OTH Launcher Cleanup
echo Cleaning up OTH Launcher...
timeout /t 2 /nobreak >nul

REM Delete app data
rd /s /q "%APPDATA%\\OTHLauncher" 2>nul
rd /s /q "%LOCALAPPDATA%\\OTHLauncher" 2>nul

REM Delete desktop shortcut
del "%USERPROFILE%\\Desktop\\OTH Launcher.lnk" 2>nul

REM Delete start menu shortcut
del "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\OTH Launcher.lnk" 2>nul

echo Cleanup complete!
timeout /t 2
del "%~f0"
          `;
          
          const tempScript = path.join(app.getPath('temp'), 'oth-cleanup.bat');
          await fs.writeFile(tempScript, cleanupScript);
          
          // Run the cleanup script
          const { spawn } = require('child_process');
          spawn('cmd.exe', ['/c', tempScript], {
            detached: true,
            stdio: 'ignore'
          }).unref();
          
          // Quit the app
          setTimeout(() => {
            app.quit();
          }, 500);
          
          return { success: true, message: 'Cleanup initiated' };
        } else {
          return { success: false, canceled: true };
        }
      }
    } else if (process.platform === 'darwin') {
      // macOS - move to trash
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Uninstall OTH Launcher',
        message: 'Are you sure you want to uninstall OTH Launcher?',
        detail: 'This will move the launcher to Trash. Your purchased software will remain in your account.',
        buttons: ['Cancel', 'Move to Trash'],
        defaultId: 0,
        cancelId: 0
      });
      
      if (result.response === 1) {
        const appPath = app.getPath('exe');
        await shell.trashItem(appPath);
        app.quit();
        return { success: true, message: 'Moved to trash' };
      } else {
        return { success: false, canceled: true };
      }
    } else {
      // Linux
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Uninstall OTH Launcher',
        message: 'Are you sure you want to uninstall OTH Launcher?',
        detail: 'This will remove the launcher. Your purchased software will remain in your account.',
        buttons: ['Cancel', 'Uninstall'],
        defaultId: 0,
        cancelId: 0
      });
      
      if (result.response === 1) {
        // Remove app data
        const configPath = path.join(app.getPath('home'), '.config', 'OTHLauncher');
        try {
          await fs.rm(configPath, { recursive: true, force: true });
        } catch (err) {
          console.log('Could not remove config:', err);
        }
        
        app.quit();
        return { success: true, message: 'Uninstalled' };
      } else {
        return { success: false, canceled: true };
      }
    }
  } catch (error) {
    console.error('❌ Launcher uninstall failed:', error);
    return { success: false, error: error.message };
  }
});

// ===== DISCORD RICH PRESENCE HANDLERS =====

// Set Discord to idle
ipcMain.handle('discord-set-idle', async () => {
  try {
    if (discordPresence) {
      await discordPresence.setIdle();
      return { success: true };
    }
    return { success: false, error: 'Discord presence not initialized' };
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
    console.error('Failed to check Discord connection:', error);
    return { success: false, error: error.message, isConnected: false };
  }
});

// Set Discord mode
ipcMain.handle('discord-set-mode', async (event, mode) => {
  try {
    if (discordPresence) {
      // Mode can be 'browsing', 'playing', 'idle', etc.
      await discordPresence.setMode(mode);
      return { success: true };
    }
    return { success: false, error: 'Discord presence not initialized' };
  } catch (error) {
    console.error('Failed to set Discord mode:', error);
    return { success: false, error: error.message };
  }
});

// ===== FILE OPERATION HANDLERS =====

// Select file
ipcMain.handle('select-file', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: 'Select File'
    });
    
    if (result.canceled) {
      return { success: false, canceled: true };
    }
    
    return { success: true, path: result.filePaths[0] };
  } catch (error) {
    console.error('Failed to select file:', error);
    return { success: false, error: error.message };
  }
});

// Select folder
ipcMain.handle('select-folder', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Folder'
    });
    
    if (result.canceled) {
      return { success: false, canceled: true };
    }
    
    return { success: true, path: result.filePaths[0] };
  } catch (error) {
    console.error('Failed to select folder:', error);
    return { success: false, error: error.message };
  }
});

// Read file
ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { success: true, content };
  } catch (error) {
    console.error('Failed to read file:', error);
    return { success: false, error: error.message };
  }
});

// Read folder
ipcMain.handle('read-folder', async (event, folderPath) => {
  try {
    const items = await fs.readdir(folderPath, { withFileTypes: true });
    const files = items.map(item => ({
      name: item.name,
      isDirectory: item.isDirectory(),
      path: path.join(folderPath, item.name)
    }));
    return { success: true, files };
  } catch (error) {
    console.error('Failed to read folder:', error);
    return { success: false, error: error.message };
  }
});

// Open AI Chat window
ipcMain.handle('open-ai-chat', async () => {
  try {
    // If window already exists, focus it
    if (aiChatWindow && !aiChatWindow.isDestroyed()) {
      aiChatWindow.focus();
      return { success: true, message: 'AI Chat window focused' };
    }

    // Create new AI Chat window
    const storeUrl = process.env.OTH_STORE_URL || 'http://localhost:3000';
    
    aiChatWindow = new BrowserWindow({
      width: 900,
      height: 700,
      backgroundColor: '#000000',
      frame: false,
      title: 'AI Assistant',
      icon: path.join(__dirname, '../../assets/company.png'),
      parent: mainWindow,
      modal: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        sandbox: false,
      },
      autoHideMenuBar: true,
      darkTheme: true,
    });

    // Load a simple HTML page with just the AI chat
    aiChatWindow.loadURL(`${storeUrl}/ai-chat-standalone`);

    // Show when ready
    aiChatWindow.once('ready-to-show', () => {
      aiChatWindow.show();
      aiChatWindow.focus();
    });

    // Clean up when closed
    aiChatWindow.on('closed', () => {
      aiChatWindow = null;
    });

    // Enable F12 for DevTools
    aiChatWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12') {
        aiChatWindow.webContents.toggleDevTools();
      }
    });

    return { success: true, message: 'AI Chat window opened' };
  } catch (error) {
    console.error('Failed to open AI chat:', error);
    return { success: false, error: error.message };
  }
});

// Open Register window
ipcMain.handle('open-register-window', async () => {
  try {
    // If window already exists, focus it
    if (registerWindow && !registerWindow.isDestroyed()) {
      registerWindow.focus();
      return { success: true, message: 'Register window focused' };
    }

    // Create new Register window
    const storeUrl = process.env.OTH_STORE_URL || 'http://localhost:3000';

    registerWindow = new BrowserWindow({
      width: 600,
      height: 800,
      backgroundColor: '#000000',
      frame: false,
      title: 'Create OTH Account',
      icon: path.join(__dirname, '../../assets/company.png'),
      parent: mainWindow,
      modal: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        sandbox: false,
      },
      autoHideMenuBar: true,
      darkTheme: true,
    });

    // Load the server's register page
    registerWindow.loadURL(`${storeUrl}/register`);

    // Show when ready
    registerWindow.once('ready-to-show', () => {
      registerWindow.show();
      registerWindow.focus();
    });

    // Clean up when closed
    registerWindow.on('closed', () => {
      registerWindow = null;
    });

    // Enable F12 for DevTools
    registerWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12') {
        registerWindow.webContents.toggleDevTools();
      }
    });

    return { success: true, message: 'Register window opened' };
  } catch (error) {
    console.error('Failed to open register window:', error);
    return { success: false, error: error.message };
  }
});

// Window controls - handle the window that sent the event
ipcMain.on('minimize-window', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) window.minimize();
});

ipcMain.on('maximize-window', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) {
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  }
});

ipcMain.on('close-window', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) window.close();
});

// Close the current window (for AI chat window)
ipcMain.handle('close-current-window', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) {
    window.close();
  }
  return { success: true };
});

// Navigate main window from AI chat
ipcMain.handle('navigate-main-window', async (event, url) => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const storeUrl = process.env.OTH_STORE_URL || 'http://localhost:3000';
      const fullUrl = url.startsWith('http') ? url : `${storeUrl}${url}`;
      mainWindow.loadURL(fullUrl);
      
      // Focus the main window
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
      
      return { success: true, message: 'Navigated main window' };
    }
    return { success: false, error: 'Main window not found' };
  } catch (error) {
    console.error('Failed to navigate main window:', error);
    return { success: false, error: error.message };
  }
});

// ===== FLOATING DOCK BUTTON WINDOW =====

function createDockButton() {
  if (dockButtonWindow && !dockButtonWindow.isDestroyed()) {
    return dockButtonWindow;
  }

  const mainBounds = mainWindow.getBounds();

  dockButtonWindow = new BrowserWindow({
    width: 70,
    height: 70,
    x: mainBounds.x + mainBounds.width + 2, // Match dock gap
    y: mainBounds.y + 40, // Start near the top (below title bar)
    frame: false,
    transparent: true,
    alwaysOnTop: false, // Will be managed based on main window focus
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  dockButtonWindow.loadFile(path.join(__dirname, '../renderer/dock-button-overlay.html'));

  dockButtonWindow.once('ready-to-show', () => {
    dockButtonWindow.show();
    // Set always on top when main window is focused
    if (mainWindow.isFocused()) {
      dockButtonWindow.setAlwaysOnTop(true, 'floating');
    }
  });

  // Keep button positioned with main window
  mainWindow.on('move', () => {
    updateDockButtonPosition();
  });

  mainWindow.on('resize', () => {
    updateDockButtonPosition();
  });

  mainWindow.on('minimize', () => {
    if (dockButtonWindow && !dockButtonWindow.isDestroyed()) {
      dockButtonWindow.hide();
    }
  });

  mainWindow.on('restore', () => {
    if (dockButtonWindow && !dockButtonWindow.isDestroyed()) {
      dockButtonWindow.show();
      updateDockButtonPosition();
    }
  });

  // Manage always on top based on main window focus
  mainWindow.on('focus', () => {
    if (dockButtonWindow && !dockButtonWindow.isDestroyed()) {
      dockButtonWindow.setAlwaysOnTop(true, 'floating');
    }
  });

  mainWindow.on('blur', () => {
    if (dockButtonWindow && !dockButtonWindow.isDestroyed()) {
      dockButtonWindow.setAlwaysOnTop(false);
    }
  });

  dockButtonWindow.on('closed', () => {
    dockButtonWindow = null;
  });

  return dockButtonWindow;
}

function updateDockButtonPosition() {
  if (!dockButtonWindow || dockButtonWindow.isDestroyed() || !mainWindow) {
    return;
  }

  const mainBounds = mainWindow.getBounds();
  dockButtonWindow.setPosition(
    mainBounds.x + mainBounds.width + 2, // Match dock gap
    mainBounds.y + 40 // Start near the top
  );
}

// ===== MODULE DOCK HANDLERS =====

// Toggle module dock (attach/detach)
ipcMain.handle('toggle-module-dock', async () => {
  try {
    if (!dockManager) {
      throw new Error('Dock manager not initialized');
    }

    const result = dockManager.toggleDock(mainWindow);
    return { success: true, ...result };
  } catch (error) {
    console.error('Failed to toggle module dock:', error);
    return { success: false, error: error.message };
  }
});

// Check if dock is detached
ipcMain.handle('is-dock-detached', async () => {
  try {
    if (!dockManager) {
      return { success: true, detached: false };
    }

    const detached = dockManager.isDetachedDock();
    return { success: true, detached };
  } catch (error) {
    console.error('Failed to check dock status:', error);
    return { success: false, error: error.message, detached: false };
  }
});

// Close module dock
ipcMain.handle('close-module-dock', async () => {
  try {
    if (!dockManager) {
      throw new Error('Dock manager not initialized');
    }

    dockManager.closeDetachedDock();
    return { success: true };
  } catch (error) {
    console.error('Failed to close module dock:', error);
    return { success: false, error: error.message };
  }
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
    icon: path.join(__dirname, '../../assets/company.png'),
    show: false, // Don't show until ready
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Performance optimizations
      backgroundThrottling: false,
      sandbox: false, // Better performance
    },
    autoHideMenuBar: true,
    darkTheme: true,
  });

  // Configure session for performance and security
  const ses = mainWindow.webContents.session;

  // Enable caching
  ses.setPreloads([path.join(__dirname, 'preload.js')]);

  // Preconnect to the store URL for faster loading
  const storeUrl = process.env.OTH_STORE_URL || 'http://localhost:3000';
  ses.preconnect({ url: storeUrl, numSockets: 4 });

  // Set Content Security Policy
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' " + storeUrl + "; " +
          "script-src 'self' 'unsafe-inline' " + storeUrl + "; " +
          "style-src 'self' 'unsafe-inline' " + storeUrl + "; " +
          "img-src 'self' data: https: " + storeUrl + "; " +
          "font-src 'self' data: " + storeUrl + "; " +
          "connect-src 'self' " + storeUrl + " ws: wss:;"
        ]
      }
    });
  });

  // Note: Electron manages cache automatically, size is controlled via app.getPath('userData')

  // Load the local launcher page first
  mainWindow.loadFile(path.join(__dirname, '../renderer/launcher.html'));

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    
    // Initialize update manager after window is shown
    updateManager = new UpdateManager(mainWindow);
    console.log('🔄 Update Manager initialized');
    
    // Check for updates after 3 seconds
    setTimeout(() => {
      if (updateManager) {
        updateManager.checkForUpdates();
      }
    }, 3000);
  });

  // Listen for navigation events
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === 'about:blank') {
      console.log('User logged out, returning to launcher...');
      event.preventDefault();
      mainWindow.loadFile(path.join(__dirname, '../renderer/launcher.html'));
    }
  });

  mainWindow.webContents.on('did-navigate', (event, url) => {
    if (url === 'about:blank') {
      console.log('Navigation to about:blank detected, loading launcher...');
      mainWindow.loadFile(path.join(__dirname, '../renderer/launcher.html'));
    }
  });

  // Optimize loading
  mainWindow.webContents.on('did-start-loading', () => {
    // Set loading priority
    mainWindow.webContents.setBackgroundThrottling(false);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    // Inject performance optimizations
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
        if (message.includes('ClientFetchError') || 
            message.includes('Unexpected token') ||
            message.includes('not valid JSON') ||
            message.includes('authjs.dev') ||
            message.includes('could not be cloned')) {
          return;
        }
        originalError.apply(console, args);
      };

      // Performance optimization: Preload critical resources
      if ('requestIdleCallback' in window) {
        requestIdleCallback(() => {
          // Preload fonts
          if (document.fonts) {
            document.fonts.load('1em Inter');
          }
        });
      }
    `);
    
    // Check if we're on the dashboard page and restore dock if needed
    mainWindow.webContents.executeJavaScript('window.location.pathname').then(pathname => {
      if (pathname && pathname.includes('dashboard') && dockManager) {
        setTimeout(() => {
          dockManager.restoreDockState(mainWindow);
        }, 1500);
      }
    }).catch(() => {});
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Enable F12 for DevTools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.toggleDevTools();
    }
  });
}

// ===== APP LIFECYCLE =====

app.whenReady().then(async () => {
  // Set default session properties for performance
  const defaultSession = session.defaultSession;
  
  // Enable persistent cache
  await defaultSession.clearCache();
  await defaultSession.clearStorageData({
    storages: ['cookies', 'localstorage']
  });

  // Initialize Module Manager
  moduleManager = new ModuleManager(store);
  console.log('📦 Module Manager initialized');
  
  // Initialize Module Dock Manager
  dockManager = new ModuleDockManager();
  dockManager.setStore(store); // Pass store for state persistence
  console.log('🎨 Module Dock Manager initialized');
  
  // Initialize Download Queue Manager
  downloadQueueManager = new DownloadQueueManager(store);
  console.log('📥 Download Queue Manager initialized');
  
  // Setup download queue event listeners
  downloadQueueManager.on('download-started', (download) => {
    console.log('📥 Download started:', download.displayName);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-started', download);
    }
  });
  
  downloadQueueManager.on('download-progress', (download) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-progress', download);
    }
  });
  
  downloadQueueManager.on('download-complete', (download) => {
    console.log('✅ Download complete:', download.displayName);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-complete', download);
    }
    if (Notification.isSupported()) {
      new Notification({
        title: 'Download Complete',
        body: `${download.displayName} has finished downloading`,
        icon: path.join(__dirname, '../../assets/company.png'),
      }).show();
    }
  });
  
  downloadQueueManager.on('download-error', (download) => {
    console.error('❌ Download error:', download.displayName, download.error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-error', download);
    }
  });
  
  downloadQueueManager.on('queues-updated', (queues) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('queues-updated', queues);
    }
  });
  
  // Load all enabled modules
  await moduleManager.loadAllModules();

  // Register global hotkey for screen capture
  const captureHotkey = 'CommandOrControl+Shift+S';
  const registered = globalShortcut.register(captureHotkey, () => {
    console.log('⏸️ Hotkey pressed:', captureHotkey);
    openCaptureOverlay();
  });

  if (registered) {
    console.log('✅ Screen capture hotkey registered:', captureHotkey);
  } else {
    console.warn('⚠️ Failed to register hotkey:', captureHotkey);
  }

  createWindow();

  // Create floating dock button - HIDDEN FOR NOW
  // setTimeout(() => {
  //   createDockButton();
  //   console.log('🎯 Floating dock button created');
  // }, 1000);

  // Initialize Discord Rich Presence
  if (DiscordPresenceManager && DISCORD_CLIENT_ID && DISCORD_CLIENT_ID !== '1234567890123456789') {
    const settings = store.get('launcher-settings', {});
    const discordEnabled = settings.discord?.enabled !== false;
    
    if (discordEnabled) {
      discordPresence = new DiscordPresenceManager();
      discordPresence.init(DISCORD_CLIENT_ID, discordEnabled)
        .then(() => {
          if (discordPresence.isActive()) {
            discordPresence.enableUltraAggressiveMode();
            console.log('Discord presence set to ultra-aggressive mode (2s updates)');
          }
        })
        .catch(err => {
          console.log('Discord RPC initialization failed (non-critical):', err.message);
        });
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (discordPresence) {
    discordPresence.destroy();
  }
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (discordPresence) {
    await discordPresence.destroy();
  }
  
  // Unregister all global shortcuts
  globalShortcut.unregisterAll();
});

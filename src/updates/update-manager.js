const { autoUpdater } = require('electron-updater');
const { app, dialog, BrowserWindow } = require('electron');
const log = require('electron-log');

// Configure logging
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
log.info('Auto-updater initialized');

// IMPORTANT: Set GitHub token for private repository access
// The token will be read from environment variable or embedded config
if (process.env.GH_TOKEN) {
  autoUpdater.requestHeaders = {
    'Authorization': `token ${process.env.GH_TOKEN}`
  };
  log.info('GitHub token configured for private repository');
} else {
  // Try to load from config file (not committed to git)
  try {
    const updateConfig = require('../config/update-config');
    if (updateConfig && updateConfig.githubToken) {
      autoUpdater.requestHeaders = {
        'Authorization': `token ${updateConfig.githubToken}`
      };
      log.info('GitHub token loaded from config file');
    }
  } catch (err) {
    log.warn('No GitHub token found - private repo updates will fail');
  }
}

class UpdateManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.updateAvailable = false;
    this.updateDownloaded = false;
    
    // Configure auto-updater
    autoUpdater.autoDownload = false; // Don't auto-download, ask user first
    autoUpdater.autoInstallOnAppQuit = true; // Install when app quits
    
    this.setupListeners();
  }

  setupListeners() {
    // Checking for update
    autoUpdater.on('checking-for-update', () => {
      log.info('Checking for updates...');
      this.sendStatusToWindow('Checking for updates...');
    });

    // Update available
    autoUpdater.on('update-available', (info) => {
      log.info('Update available:', info);
      this.updateAvailable = true;
      
      // Notify renderer
      this.sendStatusToWindow('update-available', {
        version: info.version,
        releaseNotes: info.releaseNotes,
        releaseDate: info.releaseDate
      });
    });

    // No update available
    autoUpdater.on('update-not-available', (info) => {
      log.info('Update not available:', info);
      this.sendStatusToWindow('update-not-available');
    });

    // Update error
    autoUpdater.on('error', (err) => {
      log.error('Update error:', err);
      this.sendStatusToWindow('update-error', { message: err.message });
    });

    // Download progress
    autoUpdater.on('download-progress', (progressObj) => {
      let message = `Download speed: ${progressObj.bytesPerSecond}`;
      message += ` - Downloaded ${progressObj.percent}%`;
      message += ` (${progressObj.transferred}/${progressObj.total})`;
      
      log.info(message);
      this.sendStatusToWindow('download-progress', {
        percent: progressObj.percent,
        transferred: progressObj.transferred,
        total: progressObj.total,
        bytesPerSecond: progressObj.bytesPerSecond
      });
    });

    // Update downloaded
    autoUpdater.on('update-downloaded', (info) => {
      log.info('Update downloaded:', info);
      this.updateDownloaded = true;
      
      this.sendStatusToWindow('update-downloaded', {
        version: info.version
      });
    });
  }

  // Send status to renderer process
  sendStatusToWindow(event, data = {}) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('update-status', { event, data });
    }
  }

  // Check for updates
  checkForUpdates() {
    if (app.isPackaged) {
      log.info('App is packaged, checking for updates...');
      autoUpdater.checkForUpdates();
    } else {
      log.info('App is not packaged, skipping update check (dev mode)');
      this.sendStatusToWindow('update-not-available', { 
        message: 'Update checking disabled in development mode' 
      });
    }
  }

  // Download update
  downloadUpdate() {
    if (this.updateAvailable) {
      log.info('Starting update download...');
      autoUpdater.downloadUpdate();
    }
  }

  // Install update and restart
  quitAndInstall() {
    if (this.updateDownloaded) {
      log.info('Installing update and restarting...');
      // true, true = quit immediately and install
      autoUpdater.quitAndInstall(true, true);
    }
  }
}

module.exports = UpdateManager;

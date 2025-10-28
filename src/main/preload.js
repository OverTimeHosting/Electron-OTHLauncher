const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Connection and auth
  connectToStore: (credentials) => ipcRenderer.invoke('connect-to-store', credentials),
  getPendingCredentials: () => ipcRenderer.invoke('get-pending-credentials'),
  userLoggedIn: (userEmail) => ipcRenderer.invoke('user-logged-in', userEmail), // Pass email string only
  userLoggedOut: () => ipcRenderer.invoke('user-logged-out'),
  checkLoginStatus: () => ipcRenderer.invoke('check-login-status'),
  isElectronClient: () => true,
  
  // Window controls
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  closeCurrentWindow: () => ipcRenderer.invoke('close-current-window'),
  toggleAlwaysOnTop: (shouldBeOnTop) => ipcRenderer.invoke('toggle-always-on-top', shouldBeOnTop),
  getAlwaysOnTop: () => ipcRenderer.invoke('get-always-on-top'),
  
  // AI Chat
  openAIChat: () => ipcRenderer.invoke('open-ai-chat'),
  navigateMainWindow: (url) => ipcRenderer.invoke('navigate-main-window', url),
  
  // Secure credential storage
  saveCredentials: (credentials) => ipcRenderer.invoke('save-credentials', credentials),
  getCredentials: () => ipcRenderer.invoke('get-credentials'),
  clearCredentials: () => ipcRenderer.invoke('clear-credentials'),
  
  // Notifications
  showNotification: (options) => ipcRenderer.invoke('show-notification', options),
  
  // Library Management
  getInstalledApps: () => ipcRenderer.invoke('get-installed-apps'),
  isAppInstalled: (marketplaceItemId) => ipcRenderer.invoke('is-app-installed', marketplaceItemId),
  launchApp: (marketplaceItemId) => ipcRenderer.invoke('launch-app', marketplaceItemId),
  downloadApp: (downloadInfo) => ipcRenderer.invoke('download-app', downloadInfo), // LEGACY
  saveDownloadedFile: (fileData) => ipcRenderer.invoke('save-downloaded-file', fileData), // NEW - for authenticated downloads
  registerInstallation: (installInfo) => ipcRenderer.invoke('register-installation', installInfo),
  uninstallApp: (marketplaceItemId) => ipcRenderer.invoke('uninstall-app', marketplaceItemId),
  openInstallLocation: (marketplaceItemId) => ipcRenderer.invoke('open-install-location', marketplaceItemId),
  
  // Launcher Settings
  getLauncherSettings: () => ipcRenderer.invoke('get-launcher-settings'),
  saveLauncherSettings: (settings) => ipcRenderer.invoke('save-launcher-settings', settings),
  changeDownloadLocation: () => ipcRenderer.invoke('change-download-location'),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  getStorageInfo: () => ipcRenderer.invoke('get-storage-info'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  uninstallLauncher: () => ipcRenderer.invoke('uninstall-launcher'),
  
  // Discord Rich Presence
  discordSetIdle: () => ipcRenderer.invoke('discord-set-idle'),
  discordIsConnected: () => ipcRenderer.invoke('discord-is-connected'),
  discordSetMode: (mode) => ipcRenderer.invoke('discord-set-mode', mode),
  
  // File Operations
  selectFile: () => ipcRenderer.invoke('select-file'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  readFolder: (folderPath) => ipcRenderer.invoke('read-folder', folderPath),
  
  // Module Management (Enhanced)
  downloadModule: (moduleInfo) => ipcRenderer.invoke('download-module', moduleInfo),
  getInstalledModules: () => ipcRenderer.invoke('get-installed-modules'),
  uninstallModule: (moduleId) => ipcRenderer.invoke('uninstall-module', moduleId),
  enableModule: (moduleId) => ipcRenderer.invoke('enable-module', moduleId),
  disableModule: (moduleId) => ipcRenderer.invoke('disable-module', moduleId),
  getModuleSettings: (moduleId) => ipcRenderer.invoke('get-module-settings', moduleId),
  saveModuleSettings: (moduleId, settings) => ipcRenderer.invoke('save-module-settings', moduleId, settings),
  checkModuleUpdates: (moduleIds) => ipcRenderer.invoke('check-module-updates', moduleIds),
  launchModuleWindow: (moduleId) => ipcRenderer.invoke('launch-module-window', moduleId),
  
  // Screen Capture (for clipper module)
  captureRegion: (bounds) => ipcRenderer.invoke('capture-region', bounds),
  cancelCapture: () => ipcRenderer.invoke('cancel-capture'),
  captureFullscreen: () => ipcRenderer.invoke('capture-fullscreen'),
  getClips: () => ipcRenderer.invoke('get-clips'),
  deleteClip: (filepath) => ipcRenderer.invoke('delete-clip', filepath),
  openClip: (filepath) => ipcRenderer.invoke('open-clip', filepath),
  openClipsFolder: () => ipcRenderer.invoke('open-clips-folder'),
  
  // Module Dock
  toggleModuleDock: () => ipcRenderer.invoke('toggle-module-dock'),
  isDockDetached: () => ipcRenderer.invoke('is-dock-detached'),
  closeModuleDock: () => ipcRenderer.invoke('close-module-dock'),
});

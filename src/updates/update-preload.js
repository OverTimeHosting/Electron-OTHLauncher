const { contextBridge, ipcRenderer } = require('electron');

// Expose update functions to renderer
contextBridge.exposeInMainWorld('updateAPI', {
  // Check for updates
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
  
  // Download update
  downloadUpdate: () => ipcRenderer.send('download-update'),
  
  // Install update and restart
  installUpdate: () => ipcRenderer.send('install-update'),
  
  // Listen for update status
  onUpdateStatus: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('update-status', listener);
    
    // Return cleanup function
    return () => {
      ipcRenderer.removeListener('update-status', listener);
    };
  },
  
  // Get current app version
  getVersion: () => ipcRenderer.invoke('get-app-version')
});

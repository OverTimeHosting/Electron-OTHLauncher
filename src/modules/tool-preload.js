/**
 * Preload script for Tool Module Windows
 * Provides safe API for tool modules
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose safe APIs to tool modules
contextBridge.exposeInMainWorld('electronAPI', {
  // Capture APIs
  captureRegion: (bounds) => ipcRenderer.send('capture-region', bounds),
  cancelCapture: () => ipcRenderer.send('cancel-capture'),
  
  // Notification
  showNotification: (title, body) => ipcRenderer.invoke('show-notification', { title, body }),
  
  // File operations
  saveFile: (filename, data) => ipcRenderer.invoke('tool-save-file', filename, data),
  openFile: () => ipcRenderer.invoke('tool-open-file'),
  
  // Window control
  closeWindow: () => ipcRenderer.send('tool-close-window'),
  minimizeWindow: () => ipcRenderer.send('tool-minimize-window'),
  
  // Module communication
  sendToModule: (channel, data) => ipcRenderer.send('tool-module-message', channel, data),
  onModuleMessage: (callback) => {
    ipcRenderer.on('module-message', (event, channel, data) => {
      callback(channel, data);
    });
  },
});

// Prevent navigation
window.addEventListener('beforeunload', (e) => {
  e.returnValue = false;
});

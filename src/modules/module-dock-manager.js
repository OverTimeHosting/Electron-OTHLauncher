/**
 * Module Dock Manager
 * Handles the module dock window (detachable from main window)
 */

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

class ModuleDockManager {
  /**
   * Restore dock state on app launch
   */
  restoreDockState(mainWindow) {
    const shouldBeVisible = this.getDockState();
    if (shouldBeVisible) {
      // Wait a bit for the main window to be ready
      setTimeout(() => {
        this.createDetachedDock(mainWindow);
      }, 1000);
    }
  }

  /**
   * Set the electron-store instance for state persistence
   */
  setStore(store) {
    this.store = store;
  }

  /**
   * Save dock visibility state
   */
  saveDockState(isVisible) {
    if (this.store) {
      this.store.set('dock-visible', isVisible);
    }
  }

  /**
   * Get saved dock visibility state
   */
  getDockState() {
    if (this.store) {
      return this.store.get('dock-visible', false); // Default to false (closed)
    }
    return false;
  }

  constructor() {
    this.dockWindow = null;
    this.isDetached = false;
    this.dockPosition = { x: 0, y: 0 };
    this.mainWindow = null;
    this.store = null; // Will be set from main.js
    // Store event handlers so we can remove them later
    this.eventHandlers = {
      move: null,
      minimize: null,
      restore: null,
      close: null,
      closed: null,
      focus: null,
      blur: null,
      resize: null
    };
  }

  /**
   * Remove all event listeners from main window
   */
  removeEventListeners() {
    if (!this.mainWindow) return;

    if (this.eventHandlers.move) {
      this.mainWindow.removeListener('move', this.eventHandlers.move);
    }
    if (this.eventHandlers.resize) {
      this.mainWindow.removeListener('resize', this.eventHandlers.resize);
    }
    if (this.eventHandlers.minimize) {
      this.mainWindow.removeListener('minimize', this.eventHandlers.minimize);
    }
    if (this.eventHandlers.restore) {
      this.mainWindow.removeListener('restore', this.eventHandlers.restore);
    }
    if (this.eventHandlers.close) {
      this.mainWindow.removeListener('close', this.eventHandlers.close);
    }
    if (this.eventHandlers.closed) {
      this.mainWindow.removeListener('closed', this.eventHandlers.closed);
    }
    if (this.eventHandlers.focus) {
      this.mainWindow.removeListener('focus', this.eventHandlers.focus);
    }
    if (this.eventHandlers.blur) {
      this.mainWindow.removeListener('blur', this.eventHandlers.blur);
    }
  }

  /**
   * Update dock position based on main window
   */
  updateDockPosition() {
    try {
      if (!this.dockWindow || this.dockWindow.isDestroyed() || !this.mainWindow || this.mainWindow.isDestroyed()) {
        return;
      }

      const mainBounds = this.mainWindow.getBounds();
      const dockX = mainBounds.x + mainBounds.width + 2;
      const dockY = mainBounds.y + 40; // Start from the top

      // Validate positions are numbers
      if (!isNaN(dockX) && !isNaN(dockY) && isFinite(dockX) && isFinite(dockY)) {
        this.dockWindow.setPosition(dockX, dockY);
      }
    } catch (error) {
      console.error('Error updating dock position:', error);
    }
  }

  /**
   * Create or show the detached dock window
   */
  createDetachedDock(mainWindow) {
    if (this.dockWindow && !this.dockWindow.isDestroyed()) {
      this.dockWindow.focus();
      return this.dockWindow;
    }

    // Remove old event listeners if they exist
    this.removeEventListeners();
    
    // Store main window reference
    this.mainWindow = mainWindow;

    // Get main window bounds to position dock
    const mainBounds = mainWindow.getBounds();
    
    this.dockWindow = new BrowserWindow({
      width: 88,
      height: 600, // Fixed height - reverted from dynamic sizing
      x: mainBounds.x + mainBounds.width + 2, // Very close to main window
      y: mainBounds.y + 40, // Start from the top (below title bar)
      frame: false,
      transparent: false,
      backgroundColor: '#000000',
      alwaysOnTop: false,
      skipTaskbar: true, // Don't show in taskbar!
      resizable: false,
      movable: false, // Can't be moved!
      minimizable: false,
      maximizable: false,
      focusable: true, // CHANGED: Allow focus for keyboard input
      show: false,
      hasShadow: false, // No shadow to make it feel more attached
      webPreferences: {
        preload: path.join(__dirname, '../main/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this.dockWindow.loadFile(path.join(__dirname, '../renderer/module-dock.html'));

    this.dockWindow.once('ready-to-show', () => {
      this.dockWindow.show();
      // Set always on top when main window is focused
      if (mainWindow.isFocused()) {
        this.dockWindow.setAlwaysOnTop(true, 'floating');
      }
    });

    // Enable F12 for DevTools (detached mode for better visibility)
    this.dockWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12') {
        if (this.dockWindow.webContents.isDevToolsOpened()) {
          this.dockWindow.webContents.closeDevTools();
        } else {
          this.dockWindow.webContents.openDevTools({ mode: 'detach' });
        }
      }
    });

    this.dockWindow.on('closed', () => {
      this.removeEventListeners();
      this.dockWindow = null;
      this.isDetached = false;
      this.saveDockState(false); // Save closed state when window is closed
    });

    // Create event handlers
    this.eventHandlers.move = () => {
      this.updateDockPosition();
    };

    this.eventHandlers.resize = () => {
      this.updateDockPosition();
    };

    this.eventHandlers.minimize = () => {
      if (this.dockWindow && !this.dockWindow.isDestroyed()) {
        this.dockWindow.hide();
      }
    };

    this.eventHandlers.restore = () => {
      if (this.dockWindow && !this.dockWindow.isDestroyed()) {
        this.dockWindow.show();
        this.updateDockPosition();
      }
    };

    this.eventHandlers.close = () => {
      if (this.dockWindow && !this.dockWindow.isDestroyed()) {
        this.dockWindow.close();
      }
    };

    this.eventHandlers.closed = () => {
      if (this.dockWindow && !this.dockWindow.isDestroyed()) {
        this.dockWindow.close();
      }
    };

    this.eventHandlers.focus = () => {
      if (this.dockWindow && !this.dockWindow.isDestroyed()) {
        this.dockWindow.setAlwaysOnTop(true, 'floating');
      }
    };

    this.eventHandlers.blur = () => {
      if (this.dockWindow && !this.dockWindow.isDestroyed()) {
        this.dockWindow.setAlwaysOnTop(false);
      }
    };

    // Attach event listeners to main window
    mainWindow.on('move', this.eventHandlers.move);
    mainWindow.on('resize', this.eventHandlers.resize);
    mainWindow.on('minimize', this.eventHandlers.minimize);
    mainWindow.on('restore', this.eventHandlers.restore);
    mainWindow.on('close', this.eventHandlers.close);
    mainWindow.on('closed', this.eventHandlers.closed);
    mainWindow.on('focus', this.eventHandlers.focus);
    mainWindow.on('blur', this.eventHandlers.blur);

    this.isDetached = true;
    return this.dockWindow;
  }

  /**
   * Close the detached dock
   */
  closeDetachedDock() {
    this.removeEventListeners();
    
    if (this.dockWindow && !this.dockWindow.isDestroyed()) {
      this.dockWindow.close();
    }
    
    this.dockWindow = null;
    this.isDetached = false;
    this.saveDockState(false); // Save closed state
  }

  /**
   * Toggle dock detachment
   */
  toggleDock(mainWindow) {
    if (this.isDetached) {
      this.closeDetachedDock();
      return { detached: false };
    } else {
      this.createDetachedDock(mainWindow);
      this.saveDockState(true); // Save opened state
      return { detached: true };
    }
  }

  /**
   * Check if dock is detached
   */
  isDetachedDock() {
    return this.isDetached && this.dockWindow && !this.dockWindow.isDestroyed();
  }

  /**
   * Get dock window
   */
  getDockWindow() {
    return this.dockWindow;
  }
}

module.exports = ModuleDockManager;

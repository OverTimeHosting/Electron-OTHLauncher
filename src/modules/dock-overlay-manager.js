/**
 * Dock Overlay Manager
 * Creates a persistent floating dock toggle button that stays on top of all pages
 */

const { BrowserWindow } = require('electron');
const path = require('path');

class DockOverlayManager {
  constructor() {
    this.overlayWindow = null;
    this.mainWindow = null;
    this.dockManager = null;
  }

  /**
   * Create the floating overlay button
   */
  createOverlay(mainWindow, dockManager) {
    this.mainWindow = mainWindow;
    this.dockManager = dockManager;

    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      return this.overlayWindow;
    }

    // Get main window bounds
    const mainBounds = mainWindow.getBounds();

    this.overlayWindow = new BrowserWindow({
      width: 80,
      height: 80,
      x: mainBounds.x + mainBounds.width - 100,
      y: mainBounds.y + Math.floor(mainBounds.height / 2) - 40,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
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

    // Make window click-through except for the button
    this.overlayWindow.setIgnoreMouseEvents(true, { forward: true });

    this.overlayWindow.loadFile(path.join(__dirname, 'dock-overlay.html'));

    this.overlayWindow.once('ready-to-show', () => {
      this.overlayWindow.show();
    });

    // Keep overlay positioned with main window
    mainWindow.on('move', () => {
      this.updateOverlayPosition();
    });

    mainWindow.on('resize', () => {
      this.updateOverlayPosition();
    });

    mainWindow.on('closed', () => {
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        this.overlayWindow.close();
      }
    });

    this.overlayWindow.on('closed', () => {
      this.overlayWindow = null;
    });

    return this.overlayWindow;
  }

  /**
   * Update overlay position to follow main window
   */
  updateOverlayPosition() {
    if (!this.overlayWindow || this.overlayWindow.isDestroyed() || !this.mainWindow) {
      return;
    }

    const mainBounds = this.mainWindow.getBounds();
    this.overlayWindow.setPosition(
      mainBounds.x + mainBounds.width - 100,
      mainBounds.y + Math.floor(mainBounds.height / 2) - 40
    );
  }

  /**
   * Show the overlay
   */
  show() {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.show();
    }
  }

  /**
   * Hide the overlay
   */
  hide() {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.hide();
    }
  }

  /**
   * Close the overlay
   */
  close() {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.close();
    }
    this.overlayWindow = null;
  }

  /**
   * Update module count badge
   */
  async updateBadge() {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.webContents.send('update-badge');
    }
  }
}

module.exports = DockOverlayManager;

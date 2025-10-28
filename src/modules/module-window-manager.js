const { BrowserWindow } = require('electron');
const path = require('path');

// Track open module windows
const moduleWindows = new Map();

/**
 * Launch a module window
 * @param {object} module - The module object
 * @param {BrowserWindow} parentWindow - The main window
 * @param {BrowserWindow} dockWindow - The dock window (optional)
 * @returns {Promise<object>} Result object
 */
async function launchModuleWindow(module, parentWindow, dockWindow = null) {
  try {
    // Check if window already exists
    if (moduleWindows.has(module.id)) {
      const existingWindow = moduleWindows.get(module.id);
      if (existingWindow && !existingWindow.isDestroyed()) {
        existingWindow.focus();
        return { success: true, message: 'Window focused' };
      } else {
        // Clean up dead reference
        moduleWindows.delete(module.id);
      }
    }

    // Check if module has a window file
    if (!module.hasWindow || !module.window) {
      throw new Error('Module does not support windows');
    }

    // Get window HTML path
    const windowPath = path.join(module.installPath, module.window);

    // Get positioning based on dock or parent window
    let windowX, windowY;
    
    if (dockWindow && !dockWindow.isDestroyed()) {
      // Position to the right of the dock window
      const dockBounds = dockWindow.getBounds();
      windowX = dockBounds.x + dockBounds.width + 2; // 2px gap
      windowY = dockBounds.y; // Align with dock top
    } else {
      // Fallback: position to the right of parent window
      const parentBounds = parentWindow.getBounds();
      windowX = parentBounds.x + parentBounds.width + 10;
      windowY = parentBounds.y;
    }

    // Create module window
    const moduleWindow = new BrowserWindow({
      width: 800,
      height: 600,
      x: windowX,
      y: windowY,
      backgroundColor: '#000000',
      frame: false,
      title: module.displayName || module.name,
      icon: module.icon ? path.join(module.installPath, module.icon) : null,
      parent: null, // Don't parent to main window - let it be independent
      modal: false,
      show: true, // Show immediately for debugging
      webPreferences: {
        preload: path.join(__dirname, '../main/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        sandbox: false,
      },
      autoHideMenuBar: true,
      darkTheme: true,
    });

    console.log('🪟 BrowserWindow created at x:', windowX, 'y:', windowY);
    console.log('📐 Window size: 800x600');
    console.log('🔧 Loading file:', windowPath);

    // Load module window HTML
    try {
      await moduleWindow.loadFile(windowPath);
      console.log('✅ HTML file loaded successfully');
    } catch (loadError) {
      console.error('❌ Failed to load HTML file:', loadError);
      throw loadError;
    }

    // Inject module information into window
    moduleWindow.webContents.on('did-finish-load', () => {
      moduleWindow.webContents.executeJavaScript(`
        window.MODULE_INFO = ${JSON.stringify({
          id: module.id,
          name: module.name,
          displayName: module.displayName,
          version: module.version,
          author: module.author,
          description: module.description,
        })};
      `);
    });

    // Show when ready
    moduleWindow.once('ready-to-show', () => {
      console.log('🎬 Window ready-to-show event fired');
      moduleWindow.show();
      console.log('👁️ Window show() called');
      moduleWindow.focus();
      console.log('🎯 Window focus() called');
    });

    // Add timeout fallback in case ready-to-show doesn't fire
    setTimeout(() => {
      if (!moduleWindow.isDestroyed() && !moduleWindow.isVisible()) {
        console.warn('⚠️ Window not visible after 2s, forcing show');
        moduleWindow.show();
        moduleWindow.focus();
      }
    }, 2000);

    // Track window
    moduleWindows.set(module.id, moduleWindow);

    // Clean up when closed
    moduleWindow.on('closed', () => {
      moduleWindows.delete(module.id);
    });

    // Enable F12 for DevTools
    moduleWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12') {
        moduleWindow.webContents.toggleDevTools();
      }
    });

    // Log any console messages from the window
    moduleWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      console.log(`[Module Window Console] ${message}`);
    });

    // Log any errors
    moduleWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      console.error('❌ Module window failed to load:', errorCode, errorDescription);
    });

    console.log(`✅ Module window launched: ${module.displayName}`);
    return { success: true, message: 'Module window opened' };
  } catch (error) {
    console.error('❌ Failed to launch module window:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get all open module windows
 * @returns {Map} Map of module ID to window
 */
function getOpenModuleWindows() {
  return moduleWindows;
}

/**
 * Close a specific module window
 * @param {string} moduleId - The module ID
 * @returns {boolean} Success
 */
function closeModuleWindow(moduleId) {
  if (moduleWindows.has(moduleId)) {
    const window = moduleWindows.get(moduleId);
    if (window && !window.isDestroyed()) {
      window.close();
      return true;
    }
    moduleWindows.delete(moduleId);
  }
  return false;
}

/**
 * Close all module windows
 */
function closeAllModuleWindows() {
  moduleWindows.forEach((window, moduleId) => {
    if (window && !window.isDestroyed()) {
      window.close();
    }
  });
  moduleWindows.clear();
}

module.exports = {
  launchModuleWindow,
  getOpenModuleWindows,
  closeModuleWindow,
  closeAllModuleWindows,
};

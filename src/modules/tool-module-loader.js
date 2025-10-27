const { BrowserWindow, globalShortcut, desktopCapturer, screen } = require('electron');
const path = require('path');

/**
 * Tool Module Loader
 * Handles loading and running tool-type modules
 */
class ToolModuleLoader {
  constructor() {
    this.loadedTools = new Map();
    this.toolWindows = new Map();
  }

  /**
   * Load a tool module
   */
  async loadTool(module) {
    try {
      console.log('🛠️ Loading tool module:', module.displayName);

      const toolPath = path.join(module.installPath, module.main || 'index.js');
      
      // Load the tool's main file
      const toolModule = require(toolPath);
      
      // Store tool reference
      this.loadedTools.set(module.id, {
        module,
        instance: toolModule,
      });

      // Initialize tool if it has an init function
      if (toolModule.init) {
        await toolModule.init({
          moduleId: module.id,
          settings: module.settings || {},
          createWindow: (options) => this.createToolWindow(module, options),
          registerHotkey: (accelerator, callback) => this.registerHotkey(module, accelerator, callback),
        });
      }

      console.log('✅ Tool loaded:', module.displayName);
      return { success: true };
    } catch (error) {
      console.error('❌ Failed to load tool:', error);
      throw error;
    }
  }

  /**
   * Unload a tool module
   */
  async unloadTool(moduleId) {
    try {
      console.log('📤 Unloading tool module:', moduleId);

      const tool = this.loadedTools.get(moduleId);
      if (!tool) {
        console.warn('Tool not found:', moduleId);
        return;
      }

      // Call cleanup if available
      if (tool.instance.cleanup) {
        await tool.instance.cleanup();
      }

      // Close any open windows for this tool
      const window = this.toolWindows.get(moduleId);
      if (window && !window.isDestroyed()) {
        window.close();
      }

      // Unregister hotkeys
      this.unregisterHotkeys(moduleId);

      // Remove from loaded tools
      this.loadedTools.delete(moduleId);
      this.toolWindows.delete(moduleId);

      console.log('✅ Tool unloaded:', moduleId);
    } catch (error) {
      console.error('❌ Failed to unload tool:', error);
      throw error;
    }
  }

  /**
   * Create a window for a tool
   */
  createToolWindow(module, options = {}) {
    const defaultOptions = {
      width: 800,
      height: 600,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'tool-preload.js'),
      },
    };

    const windowOptions = { ...defaultOptions, ...options };
    const toolWindow = new BrowserWindow(windowOptions);

    // Load tool HTML
    const toolHtmlPath = options.htmlFile 
      ? path.join(module.installPath, options.htmlFile)
      : path.join(module.installPath, 'index.html');

    toolWindow.loadFile(toolHtmlPath);

    // Show when ready
    toolWindow.once('ready-to-show', () => {
      toolWindow.show();
    });

    // Store reference
    this.toolWindows.set(module.id, toolWindow);

    return toolWindow;
  }

  /**
   * Register global hotkey for a tool
   */
  registerHotkey(module, accelerator, callback) {
    try {
      const success = globalShortcut.register(accelerator, callback);
      if (success) {
        console.log(`🔥 Hotkey registered for ${module.displayName}: ${accelerator}`);
      } else {
        console.warn(`Failed to register hotkey for ${module.displayName}: ${accelerator}`);
      }
      return success;
    } catch (error) {
      console.error('Failed to register hotkey:', error);
      return false;
    }
  }

  /**
   * Unregister all hotkeys for a module
   */
  unregisterHotkeys(moduleId) {
    globalShortcut.unregisterAll();
    console.log('🔥 Hotkeys unregistered for:', moduleId);
  }

  /**
   * Get all loaded tools
   */
  getLoadedTools() {
    return Array.from(this.loadedTools.values()).map(t => t.module);
  }
}

module.exports = ToolModuleLoader;

/**
 * OTH Screen Clipper Module
 * Main module file that interfaces with the launcher
 */

const { desktopCapturer, clipboard, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

let moduleContext = null;
let captureWindow = null;
let settings = {};

/**
 * Initialize the screen clipper module
 */
async function init(context) {
  console.log('📸 Screen Clipper initializing...');
  moduleContext = context;
  settings = context.settings || {};

  // Register hotkey
  const hotkey = settings.hotkey?.default || 'Ctrl+Shift+S';
  context.registerHotkey(hotkey, triggerCapture);

  console.log('✅ Screen Clipper initialized');
  console.log(`📸 Capture hotkey: ${hotkey}`);
}

/**
 * Cleanup when module is disabled
 */
async function cleanup() {
  console.log('🧹 Screen Clipper cleaning up...');
  
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.close();
  }
  
  captureWindow = null;
  moduleContext = null;
}

/**
 * Trigger screen capture
 */
function triggerCapture() {
  console.log('📸 Triggering screen capture...');
  
  const mode = settings.captureMode?.default || 'region';
  
  switch (mode) {
    case 'fullscreen':
      captureFullscreen();
      break;
    case 'window':
      captureWindow();
      break;
    case 'region':
    default:
      captureRegion();
      break;
  }
}

/**
 * Capture entire screen
 */
async function captureFullscreen() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    });

    if (sources.length === 0) {
      console.error('No screens found');
      return;
    }

    // Capture primary screen
    const primaryScreen = sources[0];
    const image = primaryScreen.thumbnail;

    await handleCapturedImage(image, 'fullscreen');
  } catch (error) {
    console.error('Failed to capture fullscreen:', error);
  }
}

/**
 * Capture specific window
 */
async function captureWindowMode() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1920, height: 1080 }
    });

    if (sources.length === 0) {
      console.error('No windows found');
      return;
    }

    // TODO: Show window selector UI
    // For now, capture the first window
    const window = sources[0];
    const image = window.thumbnail;

    await handleCapturedImage(image, 'window');
  } catch (error) {
    console.error('Failed to capture window:', error);
  }
}

/**
 * Capture region with selection overlay
 */
function captureRegion() {
  if (!moduleContext) {
    console.error('Module context not available');
    return;
  }

  // Create selection overlay window
  captureWindow = moduleContext.createWindow({
    fullscreen: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    htmlFile: 'clipper.html',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  // Handle capture from overlay
  captureWindow.webContents.on('ipc-message', async (event, channel, data) => {
    if (channel === 'capture-region') {
      await captureSelectedRegion(data);
      if (captureWindow && !captureWindow.isDestroyed()) {
        captureWindow.close();
      }
    } else if (channel === 'cancel-capture') {
      if (captureWindow && !captureWindow.isDestroyed()) {
        captureWindow.close();
      }
    }
  });
}

/**
 * Capture selected region
 */
async function captureSelectedRegion(bounds) {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { 
        width: bounds.width * 2, 
        height: bounds.height * 2 
      }
    });

    if (sources.length === 0) {
      console.error('No screens found');
      return;
    }

    const screen = sources[0];
    const fullImage = screen.thumbnail;

    // Crop to selected region
    const croppedImage = fullImage.crop({
      x: Math.floor(bounds.x * 2),
      y: Math.floor(bounds.y * 2),
      width: Math.floor(bounds.width * 2),
      height: Math.floor(bounds.height * 2)
    });

    await handleCapturedImage(croppedImage, 'region');
  } catch (error) {
    console.error('Failed to capture region:', error);
  }
}

/**
 * Handle captured image
 */
async function handleCapturedImage(image, mode) {
  try {
    // Copy to clipboard if enabled
    if (settings.copyToClipboard?.default !== false) {
      clipboard.writeImage(image);
      console.log('📋 Image copied to clipboard');
    }

    // Auto-save if enabled
    if (settings.autoSave?.default !== false) {
      await saveImage(image);
    }

    // Show notification if enabled
    if (settings.showNotification?.default !== false) {
      showNotification('Screenshot captured!', `${mode} capture saved`);
    }
  } catch (error) {
    console.error('Failed to handle captured image:', error);
  }
}

/**
 * Save image to disk
 */
async function saveImage(image) {
  try {
    // Get save location
    let saveDir = settings.saveLocation?.default || 'Pictures/OTH Clips';
    
    // Expand home directory
    if (saveDir.startsWith('~')) {
      saveDir = saveDir.replace('~', os.homedir());
    } else if (!path.isAbsolute(saveDir)) {
      saveDir = path.join(os.homedir(), saveDir);
    }

    // Create directory if it doesn't exist
    await fs.mkdir(saveDir, { recursive: true });

    // Generate filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const format = settings.imageFormat?.default || 'png';
    const filename = `screenshot-${timestamp}.${format}`;
    const filepath = path.join(saveDir, filename);

    // Get image buffer based on format
    let buffer;
    if (format === 'jpg' || format === 'jpeg') {
      const quality = settings.jpegQuality?.default || 90;
      buffer = image.toJPEG(quality);
    } else if (format === 'webp') {
      buffer = image.toDataURL().replace(/^data:image\/webp;base64,/, '');
      buffer = Buffer.from(buffer, 'base64');
    } else {
      buffer = image.toPNG();
    }

    // Save file
    await fs.writeFile(filepath, buffer);
    
    console.log('💾 Screenshot saved:', filepath);
    return filepath;
  } catch (error) {
    console.error('Failed to save image:', error);
    throw error;
  }
}

/**
 * Show system notification
 */
function showNotification(title, body) {
  // This would be handled by the main process
  // Sending event to main process via IPC
  console.log('📢 Notification:', title, body);
}

module.exports = {
  init,
  cleanup,
  triggerCapture,
  captureFullscreen,
  captureWindow: captureWindowMode,
  captureRegion,
};

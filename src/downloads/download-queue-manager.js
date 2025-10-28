const path = require('path');
const fs = require('fs').promises;
const { app } = require('electron');
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');

/**
 * Download Queue Manager for OTH Launcher
 * Manages download queues similar to Steam's download system
 */
class DownloadQueueManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.activeDownloads = new Map(); // Currently downloading items
    this.pausedDownloads = new Set(); // Paused download IDs
    
    // Load queues from store
    this.loadQueues();
  }

  /**
   * Load queues from persistent storage
   */
  loadQueues() {
    const queues = this.store.get('download-queues', {
      scheduled: [],
      complete: [],
      upNext: []
    });
    
    this.scheduled = queues.scheduled || [];
    this.complete = queues.complete || [];
    this.upNext = queues.upNext || [];
  }

  /**
   * Save queues to persistent storage
   */
  saveQueues() {
    this.store.set('download-queues', {
      scheduled: this.scheduled,
      complete: this.complete,
      upNext: this.upNext
    });
    
    // Emit update event
    this.emit('queues-updated', this.getAllQueues());
  }

  /**
   * Generate unique download ID
   */
  generateDownloadId(moduleInfo) {
    return `${moduleInfo.id || moduleInfo.name}-${Date.now()}`;
  }

  /**
   * Add download to queue
   */
  addToQueue(downloadInfo) {
    const download = {
      id: this.generateDownloadId(downloadInfo),
      ...downloadInfo,
      status: 'queued',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      speed: 0,
      timeRemaining: null,
      addedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      error: null
    };

    // Add to scheduled queue
    this.scheduled.push(download);
    this.saveQueues();

    console.log('📥 Added to download queue:', download.displayName || download.name);
    return download;
  }

  /**
   * Move download to "Up Next"
   */
  moveToUpNext(downloadId) {
    // Find in scheduled
    const index = this.scheduled.findIndex(d => d.id === downloadId);
    if (index === -1) {
      throw new Error('Download not found in scheduled queue');
    }

    const download = this.scheduled.splice(index, 1)[0];
    this.upNext.push(download);
    this.saveQueues();

    console.log('⏭️ Moved to up next:', download.displayName || download.name);
    return download;
  }

  /**
   * Move download back to scheduled
   */
  moveToScheduled(downloadId) {
    // Find in upNext
    const index = this.upNext.findIndex(d => d.id === downloadId);
    if (index === -1) {
      throw new Error('Download not found in up next queue');
    }

    const download = this.upNext.splice(index, 1)[0];
    this.scheduled.push(download);
    this.saveQueues();

    console.log('📅 Moved to scheduled:', download.displayName || download.name);
    return download;
  }

  /**
   * Remove download from queue
   */
  removeFromQueue(downloadId) {
    // Try to find and remove from all queues
    let found = false;
    
    // Check scheduled
    let index = this.scheduled.findIndex(d => d.id === downloadId);
    if (index !== -1) {
      this.scheduled.splice(index, 1);
      found = true;
    }

    // Check upNext
    index = this.upNext.findIndex(d => d.id === downloadId);
    if (index !== -1) {
      this.upNext.splice(index, 1);
      found = true;
    }

    // Check if it's currently downloading - cancel it
    if (this.activeDownloads.has(downloadId)) {
      this.cancelDownload(downloadId);
      found = true;
    }

    if (found) {
      this.saveQueues();
      console.log('🗑️ Removed from queue:', downloadId);
      return true;
    }

    return false;
  }

  /**
   * Start downloading from "Up Next" queue
   */
  async startNextDownload() {
    if (this.upNext.length === 0) {
      console.log('📭 No downloads in up next queue');
      return null;
    }

    // Get the first item from up next
    const download = this.upNext[0];
    
    if (this.activeDownloads.has(download.id)) {
      console.log('⚠️ Download already active:', download.id);
      return null;
    }

    console.log('🚀 Starting download:', download.displayName || download.name);
    
    try {
      await this.startDownload(download);
      return download;
    } catch (error) {
      console.error('❌ Failed to start download:', error);
      download.status = 'error';
      download.error = error.message;
      this.saveQueues();
      this.emit('download-error', download);
      throw error;
    }
  }

  /**
   * Actually start the download process
   */
  async startDownload(download) {
    // Update status
    download.status = 'downloading';
    download.startedAt = new Date().toISOString();
    this.saveQueues();

    // Mark as active
    this.activeDownloads.set(download.id, {
      download,
      abortController: null
    });

    this.emit('download-started', download);

    try {
      // Get download settings
      const settings = this.store.get('launcher-settings', {});
      let downloadPath = settings.downloads?.location;
      
      if (!downloadPath) {
        try {
          downloadPath = app.getPath('downloads');
        } catch (e) {
          downloadPath = path.join(app.getPath('documents'), 'OTH Downloads', 'Modules');
        }
      }

      const fileName = `${(download.name || 'download').replace(/[^a-z0-9]/gi, '_')}-v${download.version || '1.0.0'}.zip`;
      const filePath = path.join(downloadPath, fileName);
      
      await fs.mkdir(downloadPath, { recursive: true });

      // Download the file
      const baseUrl = process.env.OTH_STORE_URL || 'http://localhost:3000';
      const fullUrl = download.downloadUrl.startsWith('/') 
        ? `${baseUrl}${download.downloadUrl}` 
        : download.downloadUrl;
      
      await this.downloadFile(fullUrl, filePath, download);

      // Download complete - move to complete queue
      download.status = 'complete';
      download.progress = 100;
      download.completedAt = new Date().toISOString();
      download.filePath = filePath;

      // Remove from upNext, add to complete
      const index = this.upNext.findIndex(d => d.id === download.id);
      if (index !== -1) {
        this.upNext.splice(index, 1);
      }
      this.complete.unshift(download); // Add to beginning

      this.activeDownloads.delete(download.id);
      this.saveQueues();

      this.emit('download-complete', download);
      console.log('✅ Download complete:', download.displayName || download.name);

      // Start next download if available
      setTimeout(() => {
        this.startNextDownload().catch(err => {
          console.error('Failed to start next download:', err);
        });
      }, 500);

      return download;
    } catch (error) {
      // Download failed
      download.status = 'error';
      download.error = error.message;
      this.activeDownloads.delete(download.id);
      this.saveQueues();
      this.emit('download-error', download);
      throw error;
    }
  }

  /**
   * Download file with progress tracking
   */
  downloadFile(url, filePath, download) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      const startTime = Date.now();
      let lastUpdate = Date.now();

      const request = protocol.get(url, (response) => {
        // Handle redirects
        if (response.statusCode === 302 || response.statusCode === 301) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            this.downloadFile(redirectUrl, filePath, download)
              .then(resolve)
              .catch(reject);
            return;
          } else {
            reject(new Error('Redirect location not found'));
            return;
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status ${response.statusCode}`));
          return;
        }

        const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
        let downloadedBytes = 0;

        download.totalBytes = totalBytes;

        const writeStream = require('fs').createWriteStream(filePath);

        response.on('data', (chunk) => {
          // Check if download is paused
          if (this.pausedDownloads.has(download.id)) {
            request.destroy();
            writeStream.close();
            reject(new Error('Download paused'));
            return;
          }

          downloadedBytes += chunk.length;
          download.downloadedBytes = downloadedBytes;

          // Calculate progress
          if (totalBytes > 0) {
            download.progress = Math.round((downloadedBytes / totalBytes) * 100);
          }

          // Calculate speed and time remaining (update every 500ms)
          const now = Date.now();
          if (now - lastUpdate >= 500) {
            const elapsed = (now - startTime) / 1000; // seconds
            download.speed = downloadedBytes / elapsed; // bytes per second
            
            if (totalBytes > 0 && download.speed > 0) {
              const remainingBytes = totalBytes - downloadedBytes;
              download.timeRemaining = remainingBytes / download.speed; // seconds
            }

            lastUpdate = now;
            this.saveQueues();
            this.emit('download-progress', download);
          }
        });

        response.pipe(writeStream);

        writeStream.on('finish', () => {
          writeStream.close();
          resolve();
        });

        writeStream.on('error', (error) => {
          require('fs').unlink(filePath, () => {}); // Delete partial file
          reject(error);
        });
      });

      request.on('error', (error) => {
        reject(error);
      });

      // Store request for potential cancellation
      const activeDownload = this.activeDownloads.get(download.id);
      if (activeDownload) {
        activeDownload.request = request;
      }
    });
  }

  /**
   * Pause a download
   */
  pauseDownload(downloadId) {
    if (!this.activeDownloads.has(downloadId)) {
      throw new Error('Download not active');
    }

    this.pausedDownloads.add(downloadId);
    const download = this.activeDownloads.get(downloadId).download;
    download.status = 'paused';
    this.saveQueues();
    this.emit('download-paused', download);

    console.log('⏸️ Download paused:', download.displayName || download.name);
    return download;
  }

  /**
   * Resume a download
   */
  async resumeDownload(downloadId) {
    if (!this.pausedDownloads.has(downloadId)) {
      throw new Error('Download not paused');
    }

    this.pausedDownloads.delete(downloadId);
    
    // Find the download in upNext
    const download = this.upNext.find(d => d.id === downloadId);
    if (!download) {
      throw new Error('Download not found');
    }

    console.log('▶️ Resuming download:', download.displayName || download.name);
    
    // Restart the download
    await this.startDownload(download);
    return download;
  }

  /**
   * Cancel a download
   */
  cancelDownload(downloadId) {
    const activeDownload = this.activeDownloads.get(downloadId);
    if (activeDownload) {
      // Abort the request if it exists
      if (activeDownload.request) {
        activeDownload.request.destroy();
      }
      this.activeDownloads.delete(downloadId);
    }

    this.pausedDownloads.delete(downloadId);

    // Remove from upNext
    const index = this.upNext.findIndex(d => d.id === downloadId);
    if (index !== -1) {
      const download = this.upNext[index];
      download.status = 'cancelled';
      this.emit('download-cancelled', download);
      console.log('❌ Download cancelled:', download.displayName || download.name);
    }
  }

  /**
   * Clear completed downloads
   */
  clearCompleted() {
    this.complete = [];
    this.saveQueues();
    console.log('🧹 Cleared completed downloads');
  }

  /**
   * Remove from completed
   */
  removeFromCompleted(downloadId) {
    const index = this.complete.findIndex(d => d.id === downloadId);
    if (index !== -1) {
      this.complete.splice(index, 1);
      this.saveQueues();
      return true;
    }
    return false;
  }

  /**
   * Get all queues
   */
  getAllQueues() {
    return {
      scheduled: this.scheduled,
      upNext: this.upNext,
      complete: this.complete,
      activeDownloads: Array.from(this.activeDownloads.values()).map(ad => ad.download)
    };
  }

  /**
   * Get download by ID
   */
  getDownload(downloadId) {
    // Check all queues
    let download = this.scheduled.find(d => d.id === downloadId);
    if (download) return download;

    download = this.upNext.find(d => d.id === downloadId);
    if (download) return download;

    download = this.complete.find(d => d.id === downloadId);
    if (download) return download;

    // Check active downloads
    const activeDownload = this.activeDownloads.get(downloadId);
    if (activeDownload) return activeDownload.download;

    return null;
  }

  /**
   * Get queue statistics
   */
  getStats() {
    return {
      scheduled: this.scheduled.length,
      upNext: this.upNext.length,
      complete: this.complete.length,
      active: this.activeDownloads.size,
      paused: this.pausedDownloads.size
    };
  }
}

module.exports = DownloadQueueManager;

/**
 * Module Dock Embedded Component
 * This creates an embedded dock in the launcher that can be detached
 */

class EmbeddedModuleDock {
  constructor() {
    this.container = null;
    this.modules = [];
    this.isDocked = true;
    this.dragThreshold = 50; // pixels to drag before detaching
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.isDragging = false;
  }

  /**
   * Initialize the embedded dock
   */
  async init() {
    this.createDockContainer();
    await this.loadModules();
    this.setupEventListeners();
    this.setupToggleButton();
    this.startAutoRefresh();
  }

  /**
   * Create the dock container HTML
   */
  createDockContainer() {
    const dockHTML = `
      <div class="embedded-dock" id="embeddedDock">
        <div class="dock-detach-indicator" id="dockIndicator" title="Drag or click to detach">
          <div class="indicator-line"></div>
          <div class="indicator-dots">
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
          </div>
        </div>
        <div class="dock-content" id="dockContent">
          <div class="dock-items" id="dockItems">
            <!-- Modules will be added here -->
          </div>
        </div>
      </div>
    `;

    const styles = `
      <style>
        .embedded-dock {
          position: fixed;
          right: 0;
          top: 32px;
          bottom: 0;
          width: 88px;
          background: rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          border-left: 1px solid rgba(255, 255, 255, 0.1);
          z-index: 999;
          display: flex;
          transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        .embedded-dock.hidden {
          transform: translateX(100%);
        }

        .dock-detach-indicator {
          position: absolute;
          left: -20px;
          top: 50%;
          transform: translateY(-50%);
          width: 20px;
          height: 80px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          cursor: grab;
          gap: 8px;
          transition: all 0.2s;
        }

        .dock-detach-indicator:hover {
          left: -25px;
        }

        .dock-detach-indicator:active {
          cursor: grabbing;
        }

        .indicator-line {
          width: 3px;
          height: 100%;
          background: linear-gradient(180deg, 
            transparent 0%, 
            #ef4444 20%, 
            #ef4444 80%, 
            transparent 100%);
          border-radius: 2px;
          box-shadow: 0 0 8px rgba(239, 68, 68, 0.5);
          animation: pulse-glow 2s ease-in-out infinite;
        }

        @keyframes pulse-glow {
          0%, 100% {
            opacity: 0.6;
            box-shadow: 0 0 8px rgba(239, 68, 68, 0.5);
          }
          50% {
            opacity: 1;
            box-shadow: 0 0 16px rgba(239, 68, 68, 0.8);
          }
        }

        .indicator-dots {
          position: absolute;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .indicator-dots .dot {
          width: 4px;
          height: 4px;
          background: rgba(255, 255, 255, 0.6);
          border-radius: 50%;
          transition: all 0.2s;
        }

        .dock-detach-indicator:hover .dot {
          background: #ffffff;
          box-shadow: 0 0 4px rgba(255, 255, 255, 0.8);
        }

        .dock-content {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
          padding: 16px 12px;
        }

        .dock-content::-webkit-scrollbar {
          width: 4px;
        }

        .dock-content::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.05);
        }

        .dock-content::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.2);
          border-radius: 4px;
        }

        .dock-items {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .dock-item {
          width: 64px;
          height: 64px;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
          position: relative;
          overflow: hidden;
        }

        .dock-item::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(135deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0));
          opacity: 0;
          transition: opacity 0.2s;
        }

        .dock-item:hover {
          transform: scale(1.1);
          background: rgba(255, 255, 255, 0.1);
          border-color: rgba(255, 255, 255, 0.2);
        }

        .dock-item:hover::before {
          opacity: 1;
        }

        .dock-item:active {
          transform: scale(0.95);
        }

        .dock-item.enabled {
          background: rgba(59, 130, 246, 0.2);
          border-color: rgba(59, 130, 246, 0.4);
        }

        .dock-item.enabled::after {
          content: '';
          position: absolute;
          bottom: 4px;
          left: 50%;
          transform: translateX(-50%);
          width: 4px;
          height: 4px;
          background: #3b82f6;
          border-radius: 50%;
        }

    .dock-item-icon {
      width: 44px;
      height: 44px;
      object-fit: contain;
      pointer-events: none;
      transition: all 0.2s;
    }

    .dock-item:hover .dock-item-icon {
      transform: scale(1.05);
      filter: brightness(1.1);
    }

    .dock-item-icon.error {
      display: none;
    }

    .dock-item-icon-svg {
      width: 44px;
      height: 44px;
      pointer-events: none;
      transition: all 0.2s;
    }

    .dock-item:hover .dock-item-icon-svg {
      transform: scale(1.05);
      filter: brightness(1.1);
    }

    .dock-item-emoji {
      font-size: 32px;
      pointer-events: none;
      display: none;
    }

    .dock-item-icon.error + .dock-item-emoji {
      display: block;
    }

        .dock-separator {
          width: 100%;
          height: 1px;
          background: rgba(255, 255, 255, 0.1);
          margin: 4px 0;
        }

        .dock-item-tooltip {
          position: fixed;
          background: rgba(0, 0, 0, 0.9);
          color: white;
          padding: 6px 10px;
          border-radius: 6px;
          font-size: 12px;
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.2s;
          z-index: 10000;
          white-space: nowrap;
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
        }

        .dock-item-tooltip.show {
          opacity: 1;
        }

        .dock-empty {
          padding: 20px 0;
          text-align: center;
          color: rgba(255, 255, 255, 0.4);
          font-size: 11px;
        }

        .module-loading {
          display: none;
          border: 2px solid rgba(255, 255, 255, 0.2);
          border-top: 2px solid #ffffff;
          border-radius: 50%;
          width: 16px;
          height: 16px;
          animation: spin 0.8s linear infinite;
        }

        .dock-item.loading .module-loading {
          display: block;
        }

        .dock-item.loading .dock-item-icon {
          display: none;
        }

        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      </style>
    `;

    // Insert styles
    const styleEl = document.createElement('div');
    styleEl.innerHTML = styles;
    document.head.appendChild(styleEl.firstElementChild);

    // Insert dock HTML
    const dockEl = document.createElement('div');
    dockEl.innerHTML = dockHTML;
    document.body.appendChild(dockEl.firstElementChild);

    this.container = document.getElementById('embeddedDock');
    this.indicator = document.getElementById('dockIndicator');
    this.content = document.getElementById('dockContent');
    this.itemsContainer = document.getElementById('dockItems');

    // Create tooltip
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'dock-item-tooltip';
    document.body.appendChild(this.tooltip);
  }

  /**
   * Load modules from Electron
   */
  async loadModules() {
    try {
      if (!window.electronAPI) return;

      const result = await window.electronAPI.getInstalledModules();
      if (result.success) {
        this.modules = result.modules || [];
        this.renderModules();
        this.updateBadge();
      }
    } catch (error) {
      console.error('Failed to load modules:', error);
    }
  }

  /**
   * Update the badge count
   */
  updateBadge() {
    const badge = document.getElementById('dockBadge');
    if (badge) {
      if (this.modules.length > 0) {
        badge.textContent = this.modules.length;
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    }
  }

  /**
   * Render modules in the dock
   */
  renderModules() {
    this.itemsContainer.innerHTML = '';

    if (this.modules.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dock-empty';
      empty.textContent = 'No modules installed';
      this.itemsContainer.appendChild(empty);
      return;
    }

    // Group by category
    const byCategory = {};
    this.modules.forEach(module => {
      if (!byCategory[module.category]) {
        byCategory[module.category] = [];
      }
      byCategory[module.category].push(module);
    });

    let isFirst = true;
    Object.keys(byCategory).forEach(category => {
      // Add separator between categories
      if (!isFirst) {
        const separator = document.createElement('div');
        separator.className = 'dock-separator';
        this.itemsContainer.appendChild(separator);
      }
      isFirst = false;

      // Add modules in this category
      byCategory[category].forEach(module => {
        const item = this.createModuleItem(module);
        this.itemsContainer.appendChild(item);
      });
    });
  }

  /**
   * Check if string is inline SVG
   */
  isSvgString(str) {
    return str && typeof str === 'string' && str.trim().startsWith('<svg');
  }

  /**
   * Get icon URL for a module
   */
  getModuleIconUrl(module) {
    if (!module.icon || !module.installPath) {
      return null;
    }

    // Construct the file:// URL to the icon
    const iconPath = `${module.installPath}/${module.icon}`.replace(/\\/g, '/');
    return `file:///${iconPath}`;
  }

  /**
   * Create a module item
   */
  createModuleItem(module) {
    const item = document.createElement('div');
    item.className = 'dock-item';
    if (module.enabled) {
      item.classList.add('enabled');
    }
    item.dataset.moduleId = module.id;

    // Check if icon is inline SVG or file path
    if (module.icon && this.isSvgString(module.icon)) {
      // Render inline SVG
      const svgContainer = document.createElement('div');
      svgContainer.className = 'dock-item-icon-svg';
      svgContainer.innerHTML = module.icon;
      item.appendChild(svgContainer);
    } else {
      // Try to load from file path
      const iconUrl = this.getModuleIconUrl(module);
      
      const icon = document.createElement('img');
      icon.className = 'dock-item-icon';
      icon.alt = module.displayName;
      
      if (iconUrl) {
        icon.src = iconUrl;
        icon.onerror = () => {
          // If icon fails to load, mark it as error and show emoji fallback
          icon.classList.add('error');
          console.warn(`Failed to load icon for ${module.displayName}`);
        };
      } else {
        // No icon specified, mark as error to show emoji
        icon.classList.add('error');
      }
      
      item.appendChild(icon);

      // Emoji fallback (only shown if icon fails)
      const emoji = document.createElement('div');
      emoji.className = 'dock-item-emoji';
      emoji.textContent = this.getCategoryEmoji(module.category);
      item.appendChild(emoji);
    }

    // Loading spinner
    const spinner = document.createElement('div');
    spinner.className = 'module-loading';
    item.appendChild(spinner);

    // Events
    item.addEventListener('mouseenter', (e) => this.showTooltip(module.displayName, e));
    item.addEventListener('mouseleave', () => this.hideTooltip());
    item.addEventListener('click', () => this.toggleModule(module));

    return item;
  }

  /**
   * Get emoji for category
   */
  getCategoryEmoji(category) {
    const emojis = {
      'themes': '🎨',
      'plugins': '🔌',
      'tools': '🛠️',
      'integrations': '🔗'
    };
    return emojis[category] || '📦';
  }

  /**
   * Toggle module enabled state
   */
  async toggleModule(module) {
    if (!window.electronAPI) return;

    const item = this.itemsContainer.querySelector(`[data-module-id="${module.id}"]`);
    if (!item) return;

    item.classList.add('loading');

    try {
      if (module.enabled) {
        await window.electronAPI.disableModule(module.id);
        module.enabled = false;
        item.classList.remove('enabled');
      } else {
        await window.electronAPI.enableModule(module.id);
        module.enabled = true;
        item.classList.add('enabled');
      }
    } catch (error) {
      console.error('Failed to toggle module:', error);
    } finally {
      item.classList.remove('loading');
    }
  }

  /**
   * Show tooltip
   */
  showTooltip(text, event) {
    this.tooltip.textContent = text;
    this.tooltip.classList.add('show');

    const rect = event.target.getBoundingClientRect();
    this.tooltip.style.left = (rect.left - this.tooltip.offsetWidth - 12) + 'px';
    this.tooltip.style.top = (rect.top + rect.height / 2 - this.tooltip.offsetHeight / 2) + 'px';
  }

  /**
   * Hide tooltip
   */
  hideTooltip() {
    this.tooltip.classList.remove('show');
  }

  /**
   * Setup the dock toggle button
   */
  setupToggleButton() {
    const toggleBtn = document.getElementById('dockToggleBtn');
    const badge = document.getElementById('dockBadge');
    
    if (toggleBtn) {
      // Show the button
      toggleBtn.style.display = 'flex';
      
      // Update badge with module count
      if (badge && this.modules.length > 0) {
        badge.textContent = this.modules.length;
        badge.style.display = 'flex';
      }
      
      // Handle clicks
      toggleBtn.addEventListener('click', async () => {
        await this.toggleDetachment();
      });
    }
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Drag to detach
    this.indicator.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;

      const deltaX = Math.abs(e.clientX - this.dragStartX);
      const deltaY = Math.abs(e.clientY - this.dragStartY);

      if (deltaX > this.dragThreshold || deltaY > this.dragThreshold) {
        this.detachDock();
        this.isDragging = false;
      }
    });

    document.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    // Click to detach/attach
    this.indicator.addEventListener('click', async () => {
      if (!this.isDragging) {
        await this.toggleDetachment();
      }
    });
  }

  /**
   * Detach the dock
   */
  async detachDock() {
    if (!window.electronAPI) return;

    try {
      const result = await window.electronAPI.toggleModuleDock();
      if (result.success && result.detached) {
        this.container.classList.add('hidden');
        this.isDocked = false;
      }
    } catch (error) {
      console.error('Failed to detach dock:', error);
    }
  }

  /**
   * Toggle dock detachment
   */
  async toggleDetachment() {
    if (!window.electronAPI) return;

    try {
      const result = await window.electronAPI.toggleModuleDock();
      if (result.success) {
        if (result.detached) {
          this.container.classList.add('hidden');
          this.isDocked = false;
        } else {
          this.container.classList.remove('hidden');
          this.isDocked = true;
          await this.loadModules(); // Refresh modules when re-attached
        }
      }
    } catch (error) {
      console.error('Failed to toggle dock:', error);
    }
  }

  /**
   * Check if dock should be hidden (detached)
   */
  async checkDockStatus() {
    if (!window.electronAPI) return;

    try {
      const result = await window.electronAPI.isDockDetached();
      if (result.success && result.detached) {
        this.container.classList.add('hidden');
        this.isDocked = false;
      } else {
        this.container.classList.remove('hidden');
        this.isDocked = true;
      }
    } catch (error) {
      console.error('Failed to check dock status:', error);
    }
  }

  /**
   * Show the dock
   */
  show() {
    if (this.container) {
      this.container.classList.remove('hidden');
    }
  }

  /**
   * Hide the dock
   */
  hide() {
    if (this.container) {
      this.container.classList.add('hidden');
    }
  }

  /**
   * Start auto-refresh
   */
  startAutoRefresh() {
    // Refresh modules every 5 seconds
    setInterval(async () => {
      if (this.isDocked) {
        await this.loadModules();
      }
      await this.checkDockStatus();
    }, 5000);
  }

  /**
   * Destroy the dock
   */
  destroy() {
    if (this.container) {
      this.container.remove();
    }
    if (this.tooltip) {
      this.tooltip.remove();
    }
  }
}

// Initialize embedded dock when DOM is ready
if (typeof window !== 'undefined') {
  let dockInitialized = false;
  
  const initDock = async () => {
    if (dockInitialized) return;
    if (!window.electronAPI) {
      console.log('⚠️ Electron API not available yet, will retry...');
      return;
    }
    
    dockInitialized = true;
    console.log('🎨 Initializing embedded module dock...');
    
    try {
      window.embeddedDock = new EmbeddedModuleDock();
      await window.embeddedDock.init();
      console.log('✅ Module dock initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize dock:', error);
      dockInitialized = false;
    }
  };
  
  // Try to initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(initDock, 500);
    });
  } else {
    setTimeout(initDock, 500);
  }
  
  // Also try on window load as backup
  window.addEventListener('load', () => {
    setTimeout(initDock, 1000);
  });
}

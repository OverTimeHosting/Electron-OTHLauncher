const path = require('path');
const fs = require('fs').promises;
const { app } = require('electron');
const AdmZip = require('adm-zip');
const crypto = require('crypto');

// Load module loaders for different categories
const ToolModuleLoader = require('./tool-module-loader');

/**
 * Module Manager for OTH Launcher
 * Handles installation, uninstallation, activation, and loading of modules
 */
class ModuleManager {
  constructor(store) {
    this.store = store;
    this.modulesDir = path.join(app.getPath('userData'), 'modules');
    this.installedModules = new Map();
    this.activeModules = new Map();
    
    // Initialize category loaders
    this.toolLoader = new ToolModuleLoader();
    
    // Ensure base directories exist
    this.initializeDirectories();
  }

  /**
   * Initialize module directories
   */
  async initializeDirectories() {
    const dirs = [
      this.modulesDir,
      path.join(this.modulesDir, 'themes'),
      path.join(this.modulesDir, 'plugins'),
      path.join(this.modulesDir, 'tools'),
      path.join(this.modulesDir, 'integrations'),
    ];

    for (const dir of dirs) {
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (error) {
        console.error(`Failed to create directory ${dir}:`, error);
      }
    }
  }

  /**
   * Generate unique module ID from name and version
   */
  generateModuleId(name, version) {
    return `${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${version}`;
  }

  /**
   * Validate module manifest structure
   */
  validateManifest(manifest) {
    const required = ['id', 'name', 'version', 'category', 'author'];
    const missing = required.filter(field => !manifest[field]);

    if (missing.length > 0) {
      throw new Error(`Invalid manifest: missing fields ${missing.join(', ')}`);
    }

    const validCategories = ['themes', 'plugins', 'tools', 'integrations'];
    if (!validCategories.includes(manifest.category)) {
      throw new Error(`Invalid category: ${manifest.category}`);
    }

    return true;
  }

  /**
   * Install module from downloaded file
   */
  async installModule(filePath, moduleInfo) {
    try {
      console.log('📦 Starting module installation:', moduleInfo.displayName);

      // 1. Extract ZIP file
      const zip = new AdmZip(filePath);
      const tempExtractPath = path.join(this.modulesDir, 'temp', `install-${Date.now()}`);
      
      await fs.mkdir(tempExtractPath, { recursive: true });
      zip.extractAllTo(tempExtractPath, true);

      // 2. Find and read manifest
      const manifestPath = path.join(tempExtractPath, 'module.json');
      let manifest;

      try {
        const manifestContent = await fs.readFile(manifestPath, 'utf-8');
        manifest = JSON.parse(manifestContent);
      } catch (error) {
        throw new Error('Module manifest (module.json) not found or invalid');
      }

      // 3. Validate manifest
      this.validateManifest(manifest);

      // 4. Check if module already installed
      const existingModule = this.getInstalledModule(manifest.id);
      if (existingModule) {
        // Compare versions
        if (existingModule.version === manifest.version) {
          throw new Error(`Module ${manifest.displayName} v${manifest.version} is already installed`);
        }

        // Uninstall old version first
        console.log('🔄 Updating existing module...');
        await this.uninstallModule(manifest.id);
      }

      // 5. Move to permanent location
      const moduleDir = path.join(this.modulesDir, manifest.category, manifest.id);
      await fs.mkdir(path.dirname(moduleDir), { recursive: true });
      await fs.rename(tempExtractPath, moduleDir);

      // 6. Register installation
      // Database values (moduleInfo) should override manifest values from ZIP
      const installation = {
        ...manifest,
        ...moduleInfo,  // Database values take priority
        installPath: moduleDir,
        installedAt: new Date().toISOString(),
        enabled: false, // Disabled by default
        size: await this.calculateDirSize(moduleDir),
      };

      // Save to store
      const installedModules = this.store.get('installed-modules', []);
      installedModules.push(installation);
      this.store.set('installed-modules', installedModules);

      // Update in-memory map
      this.installedModules.set(manifest.id, installation);

      // 7. Clean up
      try {
        await fs.unlink(filePath);
      } catch (err) {
        // Ignore cleanup errors
      }

      console.log('✅ Module installed successfully:', manifest.displayName);
      return {
        success: true,
        module: installation,
        message: `${manifest.displayName} installed successfully`,
      };
    } catch (error) {
      console.error('❌ Module installation failed:', error);
      
      // Clean up on failure
      try {
        const tempDir = path.join(this.modulesDir, 'temp');
        const tempDirs = await fs.readdir(tempDir);
        for (const dir of tempDirs) {
          if (dir.startsWith('install-')) {
            await fs.rm(path.join(tempDir, dir), { recursive: true, force: true });
          }
        }
      } catch (cleanupErr) {
        // Ignore cleanup errors
      }

      throw error;
    }
  }

  /**
   * Uninstall a module
   */
  async uninstallModule(moduleId) {
    try {
      const module = this.getInstalledModule(moduleId);
      if (!module) {
        throw new Error('Module not found');
      }

      console.log('🗑️ Uninstalling module:', module.displayName);

      // 1. Deactivate if active
      if (module.enabled) {
        await this.disableModule(moduleId);
      }

      // 2. Delete module directory
      if (module.installPath) {
        await fs.rm(module.installPath, { recursive: true, force: true });
      }

      // 3. Remove from store
      const installedModules = this.store.get('installed-modules', []);
      const updated = installedModules.filter(m => m.id !== moduleId);
      this.store.set('installed-modules', updated);

      // 4. Remove from in-memory map
      this.installedModules.delete(moduleId);

      console.log('✅ Module uninstalled successfully');
      return {
        success: true,
        message: `${module.displayName} uninstalled successfully`,
      };
    } catch (error) {
      console.error('❌ Module uninstall failed:', error);
      throw error;
    }
  }

  /**
   * Enable a module
   */
  async enableModule(moduleId) {
    try {
      const module = this.getInstalledModule(moduleId);
      if (!module) {
        throw new Error('Module not found');
      }

      if (module.enabled) {
        return {
          success: true,
          message: 'Module already enabled',
        };
      }

      console.log('🔌 Enabling module:', module.displayName);

      // Load module based on category
      await this.loadModule(module);

      // Update store
      const installedModules = this.store.get('installed-modules', []);
      const updated = installedModules.map(m =>
        m.id === moduleId ? { ...m, enabled: true } : m
      );
      this.store.set('installed-modules', updated);

      // Update in-memory
      module.enabled = true;
      this.installedModules.set(moduleId, module);
      this.activeModules.set(moduleId, module);

      return {
        success: true,
        message: `${module.displayName} enabled successfully`,
      };
    } catch (error) {
      console.error('❌ Failed to enable module:', error);
      throw error;
    }
  }

  /**
   * Disable a module
   */
  async disableModule(moduleId) {
    try {
      const module = this.getInstalledModule(moduleId);
      if (!module) {
        throw new Error('Module not found');
      }

      if (!module.enabled) {
        return {
          success: true,
          message: 'Module already disabled',
        };
      }

      console.log('🔌 Disabling module:', module.displayName);

      // Unload module based on category
      await this.unloadModule(module);

      // Update store
      const installedModules = this.store.get('installed-modules', []);
      const updated = installedModules.map(m =>
        m.id === moduleId ? { ...m, enabled: false } : m
      );
      this.store.set('installed-modules', updated);

      // Update in-memory
      module.enabled = false;
      this.installedModules.set(moduleId, module);
      this.activeModules.delete(moduleId);

      return {
        success: true,
        message: `${module.displayName} disabled successfully`,
      };
    } catch (error) {
      console.error('❌ Failed to disable module:', error);
      throw error;
    }
  }

  /**
   * Load a module based on its category
   */
  async loadModule(module) {
    const mainFile = path.join(module.installPath, module.main || 'index.js');

    switch (module.category) {
      case 'themes':
        // Themes are CSS files that get injected
        console.log('🎨 Loading theme module...');
        // TODO: Implement theme loading in renderer
        break;

      case 'plugins':
        // Plugins are JavaScript modules
        console.log('🔌 Loading plugin module...');
        // TODO: Implement plugin loading system
        break;

      case 'tools':
        // Tools can be separate windows or overlays
        console.log('🛠️ Loading tool module...');
        await this.toolLoader.loadTool(module);
        break;

      case 'integrations':
        // Integrations extend functionality
        console.log('🔗 Loading integration module...');
        // TODO: Implement integration loading system
        break;

      default:
        console.warn('Unknown module category:', module.category);
    }
  }

  /**
   * Unload a module
   */
  async unloadModule(module) {
    console.log('📤 Unloading module:', module.displayName);
    
    switch (module.category) {
      case 'tools':
        await this.toolLoader.unloadTool(module.id);
        break;
      case 'themes':
      case 'plugins':
      case 'integrations':
        // TODO: Implement unloading for other categories
        break;
    }
  }

  /**
   * Get a specific installed module
   */
  getInstalledModule(moduleId) {
    if (this.installedModules.has(moduleId)) {
      return this.installedModules.get(moduleId);
    }

    // Load from store if not in memory
    const installedModules = this.store.get('installed-modules', []);
    const module = installedModules.find(m => m.id === moduleId);

    if (module) {
      this.installedModules.set(moduleId, module);
    }

    return module;
  }

  /**
   * Get all installed modules (including dev modules for testing)
   */
  getInstalledModules() {
    const modules = this.store.get('installed-modules', []);
    
    // Update in-memory map
    modules.forEach(module => {
      this.installedModules.set(module.id, module);
    });

    return modules;
  }

  /**
   * Scan development modules folder for testing
   * This allows developers to test modules without installing them
   */
  async scanDevModules() {
    try {
      // Development modules folder (in project root)
      const devModulesPath = path.join(__dirname, '../../modules');
      
      console.log('🔍 Scanning dev modules folder:', devModulesPath);
      
      const devModules = [];
      
      // Check if dev modules folder exists
      try {
        await fs.access(devModulesPath);
      } catch (error) {
        console.log('📁 No dev modules folder found');
        return devModules;
      }
      
      // Read all directories in the modules folder
      const entries = await fs.readdir(devModulesPath, { withFileTypes: true });
      
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        
        const modulePath = path.join(devModulesPath, entry.name);
        const manifestPath = path.join(modulePath, 'module.json');
        
        try {
          // Try to read module.json
          const manifestContent = await fs.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(manifestContent);
          
          // Validate manifest
          this.validateManifest(manifest);
          
          // Create a dev module entry
          const devModule = {
            ...manifest,
            installPath: modulePath,
            installedAt: new Date().toISOString(),
            enabled: false,
            isDev: true, // Mark as dev module
            displayName: manifest.displayName || manifest.name,
            description: manifest.description || 'Development module',
            size: await this.calculateDirSize(modulePath),
          };
          
          devModules.push(devModule);
          console.log('✅ Found dev module:', devModule.displayName);
          
        } catch (error) {
          console.log(`⚠️ Skipping ${entry.name}: ${error.message}`);
        }
      }
      
      console.log(`📦 Found ${devModules.length} dev modules`);
      return devModules;
      
    } catch (error) {
      console.error('❌ Failed to scan dev modules:', error);
      return [];
    }
  }

  /**
   * Get all modules including dev modules for testing
   */
  async getAllModulesWithDev() {
    const installed = this.getInstalledModules();
    const devModules = await this.scanDevModules();
    
    // Combine installed and dev modules
    // Dev modules override installed if same ID
    const modulesMap = new Map();
    
    // Add installed modules
    installed.forEach(m => modulesMap.set(m.id, m));
    
    // Add/override with dev modules
    devModules.forEach(m => {
      modulesMap.set(m.id, m);
      // Also update in-memory map
      this.installedModules.set(m.id, m);
    });
    
    return Array.from(modulesMap.values());
  }

  /**
   * Get all active (enabled) modules
   */
  getActiveModules() {
    return Array.from(this.activeModules.values());
  }

  /**
   * Load all enabled modules on startup
   */
  async loadAllModules() {
    console.log('📦 Loading all enabled modules...');
    const modules = this.getInstalledModules();
    const enabled = modules.filter(m => m.enabled);

    for (const module of enabled) {
      try {
        await this.loadModule(module);
        this.activeModules.set(module.id, module);
        console.log('✅ Loaded module:', module.displayName);
      } catch (error) {
        console.error(`❌ Failed to load module ${module.displayName}:`, error);
      }
    }

    console.log(`📦 Loaded ${this.activeModules.size} modules`);
  }

  /**
   * Calculate directory size recursively
   */
  async calculateDirSize(dirPath) {
    try {
      const files = await fs.readdir(dirPath, { withFileTypes: true });
      let totalSize = 0;

      for (const file of files) {
        const filePath = path.join(dirPath, file.name);

        if (file.isDirectory()) {
          totalSize += await this.calculateDirSize(filePath);
        } else {
          const stats = await fs.stat(filePath);
          totalSize += stats.size;
        }
      }

      return totalSize;
    } catch (error) {
      console.error('Error calculating directory size:', error);
      return 0;
    }
  }

  /**
   * Get module settings
   */
  getModuleSettings(moduleId) {
    const settings = this.store.get('module-settings', {});
    return settings[moduleId] || {};
  }

  /**
   * Save module settings
   */
  saveModuleSettings(moduleId, settings) {
    const allSettings = this.store.get('module-settings', {});
    allSettings[moduleId] = settings;
    this.store.set('module-settings', allSettings);
  }

  /**
   * Check for module updates
   * @param {Array} moduleIds - Optional array of module IDs to check
   */
  async checkForUpdates(moduleIds = null) {
    const modules = moduleIds
      ? moduleIds.map(id => this.getInstalledModule(id)).filter(Boolean)
      : this.getInstalledModules();

    const updates = [];

    for (const module of modules) {
      try {
        // Query API for latest version
        const response = await fetch(`${process.env.OTH_STORE_URL || 'http://localhost:3000'}/api/launcher/modules?search=${encodeURIComponent(module.name)}`);
        const data = await response.json();

        if (data.success && data.modules.length > 0) {
          const latestModule = data.modules[0];

          // Compare versions
          if (this.compareVersions(latestModule.version, module.version) > 0) {
            updates.push({
              moduleId: module.id,
              currentVersion: module.version,
              latestVersion: latestModule.version,
              updateInfo: latestModule,
            });
          }
        }
      } catch (error) {
        console.error(`Failed to check updates for ${module.name}:`, error);
      }
    }

    return updates;
  }

  /**
   * Compare semantic versions
   * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
   */
  compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const part1 = parts1[i] || 0;
      const part2 = parts2[i] || 0;

      if (part1 > part2) return 1;
      if (part1 < part2) return -1;
    }

    return 0;
  }
}

module.exports = ModuleManager;

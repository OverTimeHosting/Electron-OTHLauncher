const DiscordRPC = require('discord-rpc');

class DiscordPresenceManager {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.currentActivity = null;
    this.clientId = null;
    this.reconnectTimeout = null;
    this.updateInterval = null;
    this.enabled = true;
    this.lastUpdateTime = 0;
    this.forceUpdateInterval = 2000; // Ultra-aggressive: Force update every 2 seconds
    this.updateCounter = 0; // Track number of updates
  }

  /**
   * Initialize Discord RPC with your application ID
   * Get this from: https://discord.com/developers/applications
   */
  async init(clientId, enabled = true) {
    this.clientId = clientId;
    this.enabled = enabled;

    if (!this.enabled || !this.clientId) {
      console.log('Discord presence disabled or no client ID provided');
      return false;
    }

    try {
      // Create new RPC client
      this.client = new DiscordRPC.Client({ transport: 'ipc' });

      // Set up event listeners
      this.client.on('ready', () => {
        console.log('✅ Discord RPC connected as', this.client.user.username);
        console.log('👤 Discord User ID:', this.client.user.id);
        console.log('🔑 Using Client ID:', this.clientId);
        this.isConnected = true;
        
        // Set initial presence (idle in launcher)
        this.setIdlePresence();
        
        // Start ultra-aggressive presence updates to fight other apps
        this.startPresenceUpdateLoop();
      });

      this.client.on('disconnected', () => {
        console.log('⚠️ Discord RPC disconnected');
        this.isConnected = false;
        
        // Stop aggressive updates
        this.stopPresenceUpdateLoop();
        
        // Try to reconnect after 15 seconds
        if (this.enabled) {
          console.log('🔄 Will attempt to reconnect in 15 seconds...');
          this.scheduleReconnect();
        }
      });

      // Login to Discord
      console.log('🔗 Attempting to connect to Discord...');
      await this.client.login({ clientId: this.clientId });
      console.log('✅ Discord RPC login successful!');
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize Discord RPC:', error.message);
      
      // Provide helpful error messages
      if (error.message.includes('Could not connect')) {
        console.log('👉 Make sure Discord is running!');
      } else if (error.message.includes('Invalid Client ID')) {
        console.log('👉 Check your Discord Application ID in main.js');
      }
      
      // Discord might not be running, try again later
      if (this.enabled) {
        console.log('🔄 Will retry connection in 15 seconds...');
        this.scheduleReconnect();
      }
      
      return false;
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  scheduleReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(() => {
      console.log('Attempting to reconnect to Discord...');
      this.init(this.clientId, this.enabled);
    }, 15000); // Try again in 15 seconds
  }

  /**
   * Start aggressive presence update loop
   * This keeps re-asserting our presence every 15 seconds
   * to prevent other apps from overriding it
   */
  startPresenceUpdateLoop() {
    // Clear any existing interval
    this.stopPresenceUpdateLoop();
    
    // Set up interval to re-assert presence
    this.updateInterval = setInterval(() => {
      if (this.isConnected && this.enabled && this.currentActivity) {
        this.updateCounter++;
        
        // Re-send the current activity to maintain presence
        this.client.setActivity(this.currentActivity).catch(err => {
          console.error('❌ Failed to update Discord presence:', err);
        });
        
        // Log less frequently to avoid spam
        if (this.updateCounter % 10 === 0) {
          console.log(`🔄 Discord presence maintained (${this.updateCounter} updates, every ${this.forceUpdateInterval}ms)`);
        }
      }
    }, this.forceUpdateInterval);
  }

  /**
   * Stop the presence update loop
   */
  stopPresenceUpdateLoop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * Set presence to show user is idle in launcher
   */
  async setIdlePresence() {
    if (!this.isConnected || !this.enabled) return;

    const activity = {
      details: 'OTH Launcher',
      state: 'Browsing Software',
      startTimestamp: Date.now(), // Add timestamp to show as active
      // Remove image keys to avoid errors if not uploaded
      instance: false,
    };

    try {
      await this.client.setActivity(activity);
      this.currentActivity = activity;
      console.log('✅ Discord presence set: OTH Launcher - Active');
    } catch (error) {
      console.error('❌ Failed to set Discord presence:', error.message);
      // Try again without any optional fields
      try {
        const simpleActivity = {
          details: 'OTH Launcher',
          state: 'Active',
          startTimestamp: Date.now(),
        };
        await this.client.setActivity(simpleActivity);
        this.currentActivity = simpleActivity;
        console.log('✅ Discord presence set (fallback mode)');
      } catch (fallbackError) {
        console.error('❌ Fallback also failed:', fallbackError.message);
      }
    }
  }

  /**
   * Set presence to show user is running an app
   */
  async setAppPresence(appName, appIcon = 'app_default') {
    if (!this.isConnected || !this.enabled) return;

    const activity = {
      details: `Running ${appName}`,
      state: 'via OTH Launcher',
      startTimestamp: Date.now(),
      largeImageKey: appIcon, // Upload app icons to Discord Developer Portal
      largeImageText: appName,
      smallImageKey: 'launcher_icon',
      smallImageText: 'OTH Launcher',
      instance: false,
      buttons: [
        {
          label: 'Get This App',
          url: 'http://localhost:3000/marketplace' // Change to your actual URL
        }
      ]
    };

    try {
      await this.client.setActivity(activity);
      this.currentActivity = activity;
    } catch (error) {
      console.error('Failed to set Discord presence:', error);
    }
  }

  /**
   * Clear presence (user went offline or disabled it)
   */
  async clearPresence() {
    if (!this.isConnected) return;

    try {
      await this.client.clearActivity();
      this.currentActivity = null;
    } catch (error) {
      console.error('Failed to clear Discord presence:', error);
    }
  }

  /**
   * Enable Discord presence
   */
  async enable() {
    this.enabled = true;
    
    if (!this.isConnected && this.clientId) {
      await this.init(this.clientId, true);
    } else if (this.isConnected) {
      await this.setIdlePresence();
    }
  }

  /**
   * Disable Discord presence
   */
  async disable() {
    this.enabled = false;
    await this.clearPresence();
    
    // Stop aggressive updates
    this.stopPresenceUpdateLoop();
    
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (error) {
        console.error('Error destroying Discord client:', error);
      }
      this.client = null;
      this.isConnected = false;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  /**
   * Destroy the Discord RPC connection
   */
  async destroy() {
    await this.disable();
  }

  /**
   * Check if currently connected
   */
  isActive() {
    return this.isConnected && this.enabled;
  }

  /**
   * Set how aggressively to update presence (in milliseconds)
   * Lower = more aggressive (fights other apps better)
   * Higher = less aggressive (uses less resources)
   */
  setUpdateFrequency(milliseconds) {
    this.forceUpdateInterval = Math.max(5000, milliseconds); // Minimum 5 seconds
    
    if (this.isConnected && this.enabled) {
      // Restart the loop with new frequency
      this.startPresenceUpdateLoop();
    }
    
    console.log(`Discord update frequency set to ${this.forceUpdateInterval}ms`);
  }

  /**
   * Enable "ultra-aggressive mode" - updates every 2 seconds
   * Use this when other apps (Steam, Epic, etc.) keep overriding your presence
   */
  enableUltraAggressiveMode() {
    this.setUpdateFrequency(2000);
    console.log('🔥 Discord ULTRA-AGGRESSIVE mode enabled (2s updates)');
  }

  /**
   * Enable "aggressive mode" - updates every 5 seconds
   * Use this if other apps keep overriding your presence
   */
  enableAggressiveMode() {
    this.setUpdateFrequency(5000);
    console.log('⚡ Discord aggressive mode enabled (5s updates)');
  }

  /**
   * Enable "balanced mode" - updates every 15 seconds (default)
   */
  enableBalancedMode() {
    this.setUpdateFrequency(15000);
    console.log('Discord balanced mode enabled');
  }

  /**
   * Enable "eco mode" - updates every 30 seconds
   * Use this to save resources if you're not worried about conflicts
   */
  enableEcoMode() {
    this.setUpdateFrequency(30000);
    console.log('Discord eco mode enabled');
  }
}

module.exports = DiscordPresenceManager;

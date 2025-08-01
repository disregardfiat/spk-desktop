/**
 * SPK Client Wrapper for Desktop
 * 
 * This wraps the spk-js library to provide desktop-specific functionality
 * while delegating all SPK network operations to the core library.
 */

const SPK = require('@spknetwork/spk-js').default;
const { ipcMain } = require('electron');
const { EventEmitter } = require('events');
const logger = require('../../utils/logger');
const AccountManager = require('./account-manager');

class SPKClientWrapper extends EventEmitter {
  constructor() {
    super();
    this.accountManager = new AccountManager();
    this.spkInstances = new Map(); // Map of username -> SPK instance
    this.currentUser = null;
  }

  async initialize() {
    logger.info('Initializing SPK Client Wrapper');
    
    // Initialize account manager
    await this.accountManager.init();
    
    // Set up IPC handlers
    this.setupIpcHandlers();
    
    // Forward account manager events
    this.accountManager.on('unlocked', (accounts) => {
      this.emit('accounts-unlocked', accounts);
    });
    
    this.accountManager.on('locked', () => {
      this.emit('accounts-locked');
    });
    
    this.accountManager.on('session-expired', () => {
      this.emit('session-expired');
    });
    
    // Check if there's an active account to restore (when unlocked)
    const activeAccount = this.accountManager.getActiveAccount();
    if (activeAccount && this.accountManager.isUnlocked()) {
      try {
        await this.setActiveAccount(activeAccount);
        logger.info(`Restored active account on initialization: ${activeAccount}`);
      } catch (error) {
        logger.error(`Failed to restore active account on initialization:`, error);
      }
    }
  }

  /**
   * Get or create SPK instance for a user
   */
  async getSpkInstance(username) {
    if (!username) {
      throw new Error('Username required');
    }

    // Return existing instance if available
    if (this.spkInstances.has(username)) {
      return this.spkInstances.get(username);
    }

    // Get account from desktop account manager
    const account = await this.accountManager.getAccount(username);
    if (!account) {
      throw new Error(`Account ${username} not found`);
    }

    // Create keychain adapter for this SPK instance
    const SPKKeychainAdapter = require('./keychain-adapter');
    const keychainAdapter = new SPKKeychainAdapter(this.accountManager);
    
    // Create SPK instance with desktop-specific configuration
    const spk = new SPK(username, {
      keychain: keychainAdapter, // Use our keychain adapter
      node: 'https://spktest.dlux.io', // TODO: Make configurable
      ipfsGateway: 'https://ipfs.dlux.io',
      timeout: 30000,
      maxRetries: 3
    });

    // Store instance
    this.spkInstances.set(username, spk);
    return spk;
  }

  /**
   * Set the current active user
   */
  async setCurrentUser(username) {
    this.currentUser = username;
    logger.info(`Current user set to: ${username}`);
  }

  /**
   * Upload files using spk-js
   */
  async uploadFiles(files, options = {}) {
    if (!this.currentUser) {
      throw new Error('No current user set');
    }

    const spk = await this.getSpkInstance(this.currentUser);
    
    // Convert file paths to File objects if needed
    const fileObjects = await this.prepareFilesForUpload(files);
    
    // Use spk-js file upload
    const results = [];
    for (const file of fileObjects) {
      try {
        const result = await spk.file.upload(file, {
          duration: options.duration || 30,
          autoRenew: options.autoRenew || false,
          folder: options.folder,
          tags: options.tags,
          license: options.license,
          encrypt: options.encrypt,
          onProgress: (percent) => {
            // Emit progress to renderer
            this.sendToRenderer('upload-progress', {
              file: file.name,
              progress: percent
            });
          }
        });
        results.push(result);
      } catch (error) {
        logger.error(`Failed to upload ${file.name}:`, error);
        results.push({ error: error.message, file: file.name });
      }
    }
    
    return results;
  }

  /**
   * Direct upload using spk-js
   */
  async directUpload(files, options = {}) {
    if (!this.currentUser) {
      throw new Error('No current user set');
    }

    const spk = await this.getSpkInstance(this.currentUser);
    const fileObjects = await this.prepareFilesForUpload(files);
    
    return spk.file.directUpload(fileObjects, options);
  }

  /**
   * Get network stats using spk-js
   */
  async getNetworkStats() {
    try {
      const spk = await this.getSpkInstance(this.currentUser || 'guest');
      return await spk.getNetworkStats();
    } catch (error) {
      logger.error('Failed to get network stats:', error);
      throw error;
    }
  }

  /**
   * Get storage providers using spk-js
   */
  async getStorageProviders() {
    try {
      const spk = await this.getSpkInstance(this.currentUser || 'guest');
      return await spk.getStorageProviders();
    } catch (error) {
      logger.error('Failed to get storage providers:', error);
      throw error;
    }
  }

  /**
   * Calculate BROCA cost using spk-js
   */
  async calculateBrocaCost(files, duration = 30) {
    try {
      const spk = await this.getSpkInstance(this.currentUser || 'guest');
      
      // Handle both single file and array of files
      const fileArray = Array.isArray(files) ? files : [files];
      
      // Calculate total size
      const totalSize = fileArray.reduce((sum, file) => {
        return sum + (file.size || file.fileSize || 0);
      }, 0);
      
      // Use BrocaCalculator from spk-js
      const { BrocaCalculator } = require('@spknetwork/spk-js');
      const cost = BrocaCalculator.cost(totalSize, duration);
      
      return {
        broca: cost,
        totalSize,
        duration
      };
    } catch (error) {
      logger.error('Failed to calculate BROCA cost:', error);
      // Return fallback calculation
      const totalSize = Array.isArray(files) ? 
        files.reduce((sum, file) => sum + (file.size || file.fileSize || 0), 0) : 
        (files.size || files.fileSize || 0);
      
      return {
        broca: Math.ceil(totalSize * duration * 0.001), // Fallback calculation
        totalSize,
        duration
      };
    }
  }

  /**
   * Register storage node using spk-js
   */
  async registerStorageNode(config) {
    if (!this.currentUser) {
      throw new Error('No current user set');
    }

    const spk = await this.getSpkInstance(this.currentUser);
    return spk.account.registerStorageNode(config);
  }

  /**
   * Desktop-specific helper methods
   */
  
  async prepareFilesForUpload(files) {
    const fs = require('fs').promises;
    const path = require('path');
    
    const fileObjects = [];
    
    for (const file of files) {
      if (typeof file === 'string') {
        // File path - read and convert to File object
        const buffer = await fs.readFile(file);
        const stat = await fs.stat(file);
        const blob = new Blob([buffer]);
        const fileObj = new File([blob], path.basename(file), {
          type: this.getMimeType(file),
          lastModified: stat.mtime.getTime()
        });
        fileObjects.push(fileObj);
      } else if (file instanceof File) {
        fileObjects.push(file);
      } else {
        // Assume it's a file-like object
        fileObjects.push(file);
      }
    }
    
    return fileObjects;
  }

  getMimeType(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    const mimeTypes = {
      'mp4': 'video/mp4',
      'webm': 'video/webm',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'pdf': 'application/pdf',
      'json': 'application/json',
      'txt': 'text/plain'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  signMessage(message, privateKey) {
    // Implement message signing with private key
    const hiveTx = require('hive-tx');
    const signature = hiveTx.signature.signBuffer(
      Buffer.from(message, 'utf8'),
      privateKey
    );
    return signature;
  }

  sendToRenderer(channel, data) {
    if (this.mainWindow) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Set the main window reference
   */
  setMainWindow(window) {
    this.mainWindow = window;
  }

  /**
   * Lock all accounts
   */
  lock() {
    this.spkInstances.clear();
    this.currentUser = null;
    this.emit('accounts-locked');
    logger.info('All accounts locked');
  }

  /**
   * Get active account
   */
  getActiveAccount() {
    // Get from account manager store for persistence
    const activeAccount = this.accountManager.getActiveAccount();
    if (activeAccount && !this.currentUser) {
      this.currentUser = activeAccount;
    }
    return activeAccount;
  }

  /**
   * List all accounts
   */
  async listAccounts() {
    return this.accountManager.listAccounts();
  }

  /**
   * Add account
   */
  async addAccount(username, keys) {
    return this.accountManager.addAccount(username, keys);
  }

  /**
   * Remove account
   */
  async removeAccount(username) {
    return this.accountManager.removeAccount(username);
  }

  /**
   * Set active account
   */
  async setActiveAccount(username) {
    this.currentUser = username;
    
    // Create SPK instance for this user immediately
    try {
      this.spkInstance = await this.getSpkInstance(username);
      logger.info(`SPK instance created for: ${username}`);
    } catch (error) {
      logger.error(`Failed to create SPK instance for ${username}:`, error);
    }
    
    // Also set in the account manager store
    this.accountManager.setActiveAccount(username);
    // Emit event so UI knows account was selected
    this.emit('active-account-changed', username);
    logger.info(`Active account changed to: ${username}`);
    // Return the account info
    return this.accountManager.getAccount(username);
  }

  /**
   * Export account
   */
  async exportAccount(username, exportPin) {
    return this.accountManager.exportAccount(username, exportPin);
  }

  /**
   * Import account
   */
  async importAccount(exportData, importPin) {
    return this.accountManager.importAccount(exportData, importPin);
  }

  /**
   * Unlock with PIN
   */
  async unlock(pin) {
    const result = await this.accountManager.unlock(pin);
    
    // After unlock, restore active account if there is one
    const activeAccount = this.accountManager.getActiveAccount();
    if (activeAccount) {
      try {
        await this.setActiveAccount(activeAccount);
        logger.info(`Restored active account after unlock: ${activeAccount}`);
      } catch (error) {
        logger.error(`Failed to restore active account after unlock:`, error);
      }
    }
    
    return result;
  }

  /**
   * Setup PIN
   */
  async setupPin(pin) {
    return this.accountManager.setupPin(pin);
  }

  /**
   * Check if account is registered on SPK Network
   */
  async checkAccountRegistration(username) {
    try {
      const spk = await this.getSpkInstance(username);
      await spk.account.init();
      
      // Check if account has public key registered
      return {
        registered: spk.account.pubKey !== 'NA',
        pubKey: spk.account.pubKey,
        balance: spk.account.balance,
        spk: spk.account.spk,
        poweredUp: spk.account.poweredUp
      };
    } catch (error) {
      logger.error(`Failed to check registration for ${username}:`, error);
      return {
        registered: false,
        error: error.message
      };
    }
  }

  /**
   * Check user services on SPK Network
   */
  async checkUserServices(username) {
    try {
      const spk = await this.getSpkInstance(username);
      const services = await spk.account.api.getServices(username);
      
      return {
        success: true,
        services: services || {}
      };
    } catch (error) {
      logger.error(`Failed to check services for ${username}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get token balances for current user
   */
  async getBalances(refresh = false) {
    if (!this.currentUser) {
      throw new Error('No current user set');
    }

    try {
      const spk = await this.getSpkInstance(this.currentUser);
      return await spk.getBalances(refresh);
    } catch (error) {
      logger.error(`Failed to get balances for ${this.currentUser}:`, error);
      throw error;
    }
  }

  /**
   * Register public key on SPK Network
   */
  async registerPublicKey(username) {
    try {
      const spk = await this.getSpkInstance(username);
      await spk.account.registerPublicKey();
      return { success: true };
    } catch (error) {
      logger.error(`Failed to register public key for ${username}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create storage contract
   */
  async createStorageContract(contractData, options = {}) {
    if (!this.currentUser) {
      throw new Error('No current user set');
    }

    try {
      const spk = await this.getSpkInstance(this.currentUser);
      
      // Create the contract using SPK API
      const result = await spk.api.post('/api/new_contract', contractData);
      return result;
    } catch (error) {
      logger.error(`Failed to create storage contract:`, error);
      throw error;
    }
  }

  /**
   * Upload to public node
   */
  async uploadToPublicNodeFromData(files, contract, options = {}) {
    if (!this.currentUser) {
      throw new Error('No current user set');
    }

    try {
      const spk = await this.getSpkInstance(this.currentUser);
      
      // Upload the files
      const results = [];
      for (const file of files) {
        const result = await spk.upload(file, {
          ...options,
          contract
        });
        results.push(result);
      }
      
      return results;
    } catch (error) {
      logger.error(`Failed to upload to public node:`, error);
      throw error;
    }
  }

  setupIpcHandlers() {
    // Account management
    ipcMain.handle('spk:set-user', async (event, username) => {
      return this.setCurrentUser(username);
    });

    // File operations
    // Handler moved to main index.js to avoid duplication

    ipcMain.handle('spk:direct-upload', async (event, files, options) => {
      return this.directUpload(files, options);
    });

    // Network operations
    ipcMain.handle('spk:get-network-stats', async () => {
      return this.getNetworkStats();
    });

    ipcMain.handle('spk:get-storage-providers', async () => {
      return this.getStorageProviders();
    });

    ipcMain.handle('spk:calculate-broca', async (event, files, duration) => {
      return this.calculateBrocaCost(files, duration);
    });

    // Node registration
    ipcMain.handle('spk:register-storage-node', async (event, config) => {
      return this.registerStorageNode(config);
    });
  }
}

module.exports = SPKClientWrapper;
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

/**
 * IPFS Manager
 * Handles IPFS node operations, daemon management, and file storage
 */
class IPFSManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      host: config.host || '127.0.0.1',
      port: config.port || 5001,
      protocol: config.protocol || 'http',
      dataPath: config.dataPath || path.join(os.homedir(), '.ipfs'),
      externalNode: config.externalNode || false,
      daemon: config.daemon || false,
      ...config
    };
    
    this.client = null;
    this.nodeInfo = null;
    this.running = false;
    this.daemonProcess = null;
    this.isExternalNode = this.config.externalNode;
    
    // Lazy load ES modules
    this.kuboModule = null;
    this.hashModule = null;
  }

  /**
   * Load ES modules dynamically
   */
  async loadModules() {
    if (!this.kuboModule) {
      this.kuboModule = await import('kubo-rpc-client');
    }
    if (!this.hashModule) {
      this.hashModule = await import('ipfs-only-hash');
    }
  }

  /**
   * Check if IPFS daemon is running
   */
  async isDaemonRunning() {
    try {
      await this.loadModules();
      const { create } = this.kuboModule;
      const testClient = create({
        host: this.config.host,
        port: this.config.port,
        protocol: this.config.protocol
      });
      await testClient.id();
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Initialize IPFS repository if needed
   */
  async initRepo() {
    try {
      // Check if repo exists
      const configPath = path.join(this.config.dataPath, 'config');
      await fs.access(configPath);
      return true; // Repo already exists
    } catch (error) {
      // Initialize new repo
      return new Promise((resolve, reject) => {
        const init = spawn('ipfs', ['init', '--profile', 'server'], {
          env: { ...process.env, IPFS_PATH: this.config.dataPath }
        });

        init.on('close', (code) => {
          if (code === 0) {
            this.configureCORS().then(() => resolve(true)).catch(reject);
          } else {
            reject(new Error(`IPFS init failed with code ${code}`));
          }
        });

        init.on('error', reject);
      });
    }
  }

  /**
   * Configure IPFS CORS settings
   */
  async configureCORS() {
    const commands = [
      ['config', '--json', 'API.HTTPHeaders.Access-Control-Allow-Origin', '["*"]'],
      ['config', '--json', 'API.HTTPHeaders.Access-Control-Allow-Methods', '["GET", "POST"]'],
      ['config', '--json', 'API.HTTPHeaders.Access-Control-Allow-Headers', '["Authorization"]'],
      ['config', '--json', 'API.HTTPHeaders.Access-Control-Expose-Headers', '["Location"]'],
      ['config', '--json', 'API.HTTPHeaders.Access-Control-Allow-Credentials', '["true"]']
    ];

    for (const cmd of commands) {
      await new Promise((resolve, reject) => {
        const proc = spawn('ipfs', cmd, {
          env: { ...process.env, IPFS_PATH: this.config.dataPath }
        });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`IPFS config failed: ${cmd.join(' ')}`));
        });
      });
    }
  }

  /**
   * Start IPFS daemon
   */
  async startDaemon() {
    if (this.daemonProcess) {
      throw new Error('IPFS daemon already running');
    }

    // Initialize repo if needed
    await this.initRepo();

    return new Promise((resolve, reject) => {
      this.daemonProcess = spawn('ipfs', ['daemon', '--enable-pubsub-experiment', '--enable-gc'], {
        env: { ...process.env, IPFS_PATH: this.config.dataPath },
        detached: this.config.daemon // Allow daemon to run independently
      });

      this.daemonProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log('IPFS:', output);
        
        if (output.includes('Daemon is ready')) {
          this.emit('daemon-ready');
          resolve();
        }
      });

      this.daemonProcess.stderr.on('data', (data) => {
        console.error('IPFS Error:', data.toString());
      });

      this.daemonProcess.on('error', (error) => {
        this.daemonProcess = null;
        reject(error);
      });

      this.daemonProcess.on('exit', (code) => {
        this.daemonProcess = null;
        this.emit('daemon-stopped', code);
      });

      // Give daemon time to start
      setTimeout(() => {
        if (this.daemonProcess) {
          resolve();
        }
      }, 5000);
    });
  }

  /**
   * Stop IPFS daemon
   */
  async stopDaemon() {
    if (!this.daemonProcess) {
      return;
    }

    return new Promise((resolve) => {
      this.daemonProcess.once('exit', () => {
        this.daemonProcess = null;
        resolve();
      });

      this.daemonProcess.kill('SIGTERM');

      // Force kill after timeout
      setTimeout(() => {
        if (this.daemonProcess) {
          this.daemonProcess.kill('SIGKILL');
        }
      }, 5000);
    });
  }

  /**
   * Start IPFS node
   */
  async start() {
    try {
      // Load modules
      await this.loadModules();
      const { create } = this.kuboModule;

      // Check if connecting to external node
      if (!this.isExternalNode) {
        // Check if daemon is already running
        const isRunning = await this.isDaemonRunning();
        
        if (!isRunning) {
          // Start our own daemon
          await this.startDaemon();
          // Wait a bit for daemon to be ready
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      // Initialize IPFS client
      this.client = create({
        host: this.config.host,
        port: this.config.port,
        protocol: this.config.protocol
      });

      // Test connection and get node info
      this.nodeInfo = await this.client.id();
      this.running = true;
      
      // Start monitoring peers
      this.startPeerMonitoring();
      
      this.emit('started', this.nodeInfo);
      return this.nodeInfo;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop IPFS node
   */
  async stop() {
    this.stopPeerMonitoring();
    
    if (!this.isExternalNode && this.daemonProcess) {
      await this.stopDaemon();
    }
    
    this.running = false;
    this.client = null;
    this.nodeInfo = null;
    this.emit('stopped');
  }

  /**
   * Start monitoring peers
   */
  startPeerMonitoring() {
    this.peerMonitorInterval = setInterval(async () => {
      if (!this.running || !this.client) return;
      
      try {
        const peers = await this.client.swarm.peers();
        this.emit('peer-count', peers.length);
      } catch (error) {
        // Ignore errors in monitoring
      }
    }, 5000);
  }

  /**
   * Stop monitoring peers
   */
  stopPeerMonitoring() {
    if (this.peerMonitorInterval) {
      clearInterval(this.peerMonitorInterval);
      this.peerMonitorInterval = null;
    }
  }

  /**
   * Get node information
   */
  async getNodeInfo() {
    if (!this.client) {
      throw new Error('IPFS not started');
    }

    try {
      const info = await this.client.id();
      // Convert multiaddr objects to strings
      const addresses = info.addresses ? info.addresses.map(addr => 
        typeof addr === 'string' ? addr : addr.toString()
      ) : [];
      
      // Convert PeerId object to string
      const id = typeof info.id === 'object' ? info.id.toString() : info.id;
      
      this.nodeInfo = {
        ...info,
        id,
        addresses
      };
      return this.nodeInfo;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get connected peers
   */
  async getConnectedPeers() {
    if (!this.client) {
      throw new Error('IPFS not started');
    }

    try {
      const peers = await this.client.swarm.peers();
      return peers;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Test connection to an IPFS node
   */
  async testConnection(host = '127.0.0.1', port = 5001) {
    try {
      // Load modules if not already loaded
      if (!this.kuboModule) {
        await this.loadModules();
      }
      
      const { create } = this.kuboModule;
      
      // Create temporary client to test connection
      const testClient = create({
        host: host,
        port: port,
        protocol: 'http',
        timeout: 5000
      });
      
      // Try to get node ID
      const info = await testClient.id();
      
      // If we get here, connection is successful
      return !!info;
    } catch (error) {
      console.log('IPFS connection test failed:', error.message);
      return false;
    }
  }

  /**
   * Add file to IPFS
   */
  async addFile(file, options = {}) {
    if (!this.client) {
      throw new Error('IPFS not started');
    }

    try {
      const result = await this.client.add(file, {
        pin: options.pin !== false,
        wrapWithDirectory: options.wrapWithDirectory || false,
        chunker: options.chunker || 'size-262144',
        rawLeaves: true,
        cidVersion: 0,
        ...options
      });
      
      this.emit('file-added', result);
      return result;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get file from IPFS
   */
  async getFile(cid) {
    if (!this.client) {
      throw new Error('IPFS not started');
    }

    try {
      const chunks = [];
      for await (const chunk of this.client.cat(cid)) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Pin file
   */
  async pinFile(cid) {
    if (!this.client) {
      throw new Error('IPFS not started');
    }

    try {
      await this.client.pin.add(cid);
      this.emit('file-pinned', cid);
      return true;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Unpin file
   */
  async unpinFile(cid) {
    if (!this.client) {
      throw new Error('IPFS not started');
    }

    try {
      await this.client.pin.rm(cid);
      this.emit('file-unpinned', cid);
      return true;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get pinned files
   */
  async getPinnedFiles() {
    if (!this.client) {
      throw new Error('IPFS not started');
    }

    try {
      const pins = [];
      for await (const pin of this.client.pin.ls()) {
        pins.push(pin);
      }
      return pins;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get repository stats
   */
  async getRepoStats() {
    if (!this.client) {
      throw new Error('IPFS not started');
    }

    try {
      const stats = await this.client.repo.stat();
      // Handle BigInt values from kubo client
      return {
        repoSize: Number(stats.repoSize || 0),
        storageMax: Number(stats.storageMax || 0),
        numObjects: Number(stats.numObjects || 0),
        repoPath: stats.repoPath || '',
        version: stats.version || ''
      };
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get storage configuration
   */
  async getConfig() {
    return {
      dataPath: this.config.dataPath,
      host: this.config.host,
      port: this.config.port,
      externalNode: this.isExternalNode,
      daemon: this.config.daemon,
      nodeId: this.nodeInfo?.id || null
    };
  }

  /**
   * Update configuration
   */
  async updateConfig(newConfig) {
    // Stop if running
    const wasRunning = this.running;
    if (wasRunning) {
      await this.stop();
    }

    // Update config
    Object.assign(this.config, newConfig);
    this.isExternalNode = this.config.externalNode;

    // Restart if was running
    if (wasRunning) {
      await this.start();
    }
  }

  /**
   * Generate IPFS hash without adding to node
   */
  async hashOnly(content, options = {}) {
    await this.loadModules();
    const Hash = this.hashModule.default || this.hashModule;
    
    const hashOptions = {
      chunker: options.chunker || 'size-262144',
      rawLeaves: true,
      cidVersion: 0
    };

    try {
      const hash = await Hash.of(content, hashOptions);
      return hash;
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Check if CID is valid
   */
  isValidCID(cid) {
    try {
      // Basic validation - starts with Qm and has correct length
      return /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid) ||
             /^bafy[a-z0-9]{50,}$/.test(cid); // CIDv1
    } catch {
      return false;
    }
  }

  /**
   * Run garbage collection
   */
  async runGarbageCollection() {
    if (!this.client) {
      throw new Error('IPFS not started');
    }

    try {
      const removed = [];
      for await (const result of this.client.repo.gc()) {
        removed.push(result);
      }
      
      this.emit('garbage-collected', { removed });
      return { removed };
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get bandwidth stats
   */
  async getBandwidthStats() {
    if (!this.client) {
      throw new Error('IPFS not started');
    }

    try {
      // The bandwidth stats method returns an async generator
      // We need to iterate once to get the current stats
      const statsGen = await this.client.stats.bw();
      const stats = await statsGen.next();
      
      if (stats.value) {
        // Handle BigInt values
        return {
          totalIn: Number(stats.value.totalIn || 0),
          totalOut: Number(stats.value.totalOut || 0),
          rateIn: Number(stats.value.rateIn || 0),
          rateOut: Number(stats.value.rateOut || 0)
        };
      }
      
      // Fallback if no stats available
      return {
        totalIn: 0,
        totalOut: 0,
        rateIn: 0,
        rateOut: 0
      };
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Enable PubSub in IPFS config
   */
  async enablePubSub() {
    try {
      // For external nodes
      if (this.mode === 'external' && this.client) {
        // Try to enable PubSub via API
        const url = `http://${this.config.host}:${this.config.port}/api/v0/config`;
        const response = await fetch(url, {
          method: 'POST',
          body: new URLSearchParams({
            arg: 'Pubsub.Enabled',
            arg: 'true',
            bool: 'true'
          })
        });
        
        if (response.ok) {
          this.emit('log', 'PubSub enabled successfully');
          return { success: true };
        } else {
          return { 
            success: false, 
            error: 'Failed to enable PubSub. You may need to manually run: ipfs config --json Pubsub.Enabled true' 
          };
        }
      }
      
      // For internal nodes
      if (this.mode === 'internal') {
        // Update config before starting
        this.config.pubsub = true;
        return { success: true };
      }
      
      return { success: false, error: 'No IPFS node configured' };
    } catch (error) {
      return { 
        success: false, 
        error: `Failed to enable PubSub: ${error.message}` 
      };
    }
  }

  /**
   * Check if PubSub is enabled
   */
  async checkPubSubEnabled() {
    try {
      if (!this.client) return false;
      
      // Try to get config
      const url = `http://${this.config.host}:${this.config.port}/api/v0/config/show`;
      const response = await fetch(url, { method: 'POST' });
      
      if (response.ok) {
        const config = await response.json();
        return config.Pubsub?.Enabled === true;
      }
      
      return false;
    } catch (error) {
      console.error('Failed to check PubSub status:', error);
      return false;
    }
  }
}

module.exports = IPFSManager;
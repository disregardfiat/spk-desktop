const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');

/**
 * Video Upload Service
 * Orchestrates the complete video upload workflow
 */
class VideoUploadService extends EventEmitter {
  constructor({ transcoder, playlistProcessor, ipfsManager, spkClient, integratedStorage, directUploadService }) {
    super();
    this.transcoder = transcoder;
    this.playlistProcessor = playlistProcessor;
    this.ipfsManager = ipfsManager;
    this.spkClient = spkClient;
    this.integratedStorage = integratedStorage;
    this.directUploadService = directUploadService;
    
    this.uploadQueue = [];
    this.activeUpload = null;
    this.tempFiles = new Set();
    this.isPaused = false;
    this.savedState = null;
  }

  /**
   * Upload video with complete workflow
   */
  async uploadVideo(videoPath, options = {}) {
    const uploadId = uuidv4();
    this.activeUpload = uploadId;
    
    const defaultOptions = {
      resolutions: ['1080p', '720p', '480p'],
      generateThumbnail: true,
      contract: {
        duration: 30 * 24 * 60 * 60,
        autoRenew: false,
        redundancy: 3
      }
    };
    
    const uploadOptions = { ...defaultOptions, ...options };
    
    try {
      // Stage 1: Analyze video
      this.emit('progress', { 
        uploadId, 
        stage: 'analyzing', 
        progress: 0, 
        message: 'Analyzing video...' 
      });
      
      const metadata = await this.transcoder.analyzeVideo(videoPath);
      
      // Determine optimal resolutions
      const availableResolutions = this.transcoder.determineOutputResolutions(metadata);
      uploadOptions.resolutions = uploadOptions.resolutions.filter(res => 
        availableResolutions.includes(res)
      );
      
      this.emit('progress', { 
        uploadId, 
        stage: 'analyzing', 
        progress: 100, 
        message: 'Analysis complete' 
      });
      
      // Stage 2: Generate thumbnail
      let thumbnail = null;
      if (uploadOptions.generateThumbnail) {
        this.emit('progress', { 
          uploadId, 
          stage: 'thumbnail', 
          progress: 0, 
          message: 'Generating thumbnail...' 
        });
        
        thumbnail = await this.transcoder.generateThumbnail(videoPath);
        const thumbnailHash = await this.ipfsManager.hashOnly(thumbnail.buffer);
        
        thumbnail.cid = thumbnailHash;
        
        this.emit('progress', { 
          uploadId, 
          stage: 'thumbnail', 
          progress: 100, 
          message: 'Thumbnail generated' 
        });
      }
      
      // Stage 3: Transcode video
      this.emit('progress', { 
        uploadId, 
        stage: 'transcoding', 
        progress: 0, 
        message: 'Transcoding video...' 
      });
      
      const tempDir = await this.transcoder.createTempDirectory();
      this.tempFiles.add(tempDir);
      
      // Setup transcoding progress handler
      this.transcoder.on('progress', (progress) => {
        this.emit('progress', {
          uploadId,
          stage: 'transcoding',
          progress: progress.percent,
          message: `Transcoding: ${progress.percent.toFixed(1)}%`
        });
      });
      
      const transcodingResults = await this.transcoder.transcodeToMultipleResolutions(
        videoPath,
        tempDir,
        uploadOptions.resolutions
      );
      
      // Stage 4: Hash all files
      this.emit('progress', { 
        uploadId, 
        stage: 'hashing', 
        progress: 0, 
        message: 'Generating IPFS hashes...' 
      });
      
      const allHashes = {};
      const resolutionData = {};
      
      // Hash segments for each resolution
      for (const [resolution, data] of Object.entries(transcodingResults)) {
        const segmentHashes = {};
        
        for (let i = 0; i < data.segments.length; i++) {
          const segment = data.segments[i];
          const content = await fs.readFile(segment.path);
          const hash = await this.ipfsManager.hashOnly(content);
          segmentHashes[segment.filename] = hash;
          allHashes[segment.filename] = { hash, content, path: segment.path };
          
          const progress = ((i + 1) / data.segments.length) * 100;
          this.emit('progress', {
            uploadId,
            stage: 'hashing',
            progress,
            message: `Hashing ${resolution} segments...`
          });
        }
        
        // Process playlist with segment hashes
        const playlistContent = await fs.readFile(data.playlistPath, 'utf-8');
        const rewrittenPlaylist = this.playlistProcessor.rewritePlaylistWithIPFS(
          playlistContent,
          segmentHashes
        );
        
        // Hash the rewritten playlist
        const playlistHash = await this.ipfsManager.hashOnly(Buffer.from(rewrittenPlaylist));
        allHashes[`${resolution}.m3u8`] = { 
          hash: playlistHash, 
          content: Buffer.from(rewrittenPlaylist),
          path: data.playlistPath
        };
        
        resolutionData[resolution] = {
          playlistCID: playlistHash,
          segments: Object.entries(segmentHashes).map(([filename, hash]) => ({
            filename,
            cid: hash
          })),
          bandwidth: this.calculateBandwidth(resolution),
          width: this.getResolutionWidth(resolution),
          height: this.getResolutionHeight(resolution)
        };
      }
      
      // Create master playlist
      const masterPlaylist = this.playlistProcessor.createMasterPlaylist(
        Object.entries(resolutionData).map(([res, data]) => ({
          resolution: res,
          filename: `${res}.m3u8`,
          hash: data.playlistCID,
          bandwidth: data.bandwidth,
          width: data.width,
          height: data.height
        }))
      );
      
      const masterHash = await this.ipfsManager.hashOnly(Buffer.from(masterPlaylist));
      
      // Stage 5: Upload to IPFS
      this.emit('progress', { 
        uploadId, 
        stage: 'uploading', 
        progress: 0, 
        message: 'Uploading to IPFS...' 
      });
      
      // Start IPFS if not running
      if (!this.ipfsManager.isRunning()) {
        await this.ipfsManager.start();
      }
      
      // Upload all files
      let uploadedCount = 0;
      const totalFiles = Object.keys(allHashes).length + 2; // +2 for master and thumbnail
      
      // Upload segments and playlists
      for (const [filename, fileData] of Object.entries(allHashes)) {
        await this.ipfsManager.addFile(fileData.content, filename);
        uploadedCount++;
        
        this.emit('progress', {
          uploadId,
          stage: 'uploading',
          progress: (uploadedCount / totalFiles) * 100,
          message: `Uploading files: ${uploadedCount}/${totalFiles}`
        });
        
        // Check if paused or cancelled
        if (this.isPaused) {
          await this.saveState({
            videoPath,
            uploadOptions,
            progress: uploadedCount,
            completedFiles: Object.keys(allHashes).slice(0, uploadedCount),
            resolutionData,
            uploadId
          });
          throw new Error('Upload paused');
        }
        
        if (this.activeUpload !== uploadId) {
          throw new Error('Upload cancelled');
        }
      }
      
      // Upload master playlist
      await this.ipfsManager.addFile(Buffer.from(masterPlaylist), 'master.m3u8');
      uploadedCount++;
      
      // Upload thumbnail
      if (thumbnail) {
        await this.ipfsManager.addFile(thumbnail.buffer, 'thumbnail.jpg');
        uploadedCount++;
      }
      
      // Stage 6: Create storage contract
      this.emit('progress', { 
        uploadId, 
        stage: 'finalizing', 
        progress: 50, 
        message: 'Creating storage contract...' 
      });
      
      // Calculate total size
      const totalSize = Object.values(allHashes).reduce((sum, file) => 
        sum + file.content.length, 0
      ) + masterPlaylist.length + (thumbnail?.buffer.length || 0);
      
      // Check BROCA balance using wrapper
      const brocaCost = await this.spkClient.calculateBrocaCost(
        [{ size: totalSize }],
        Math.floor(uploadOptions.contract.duration / (24 * 60 * 60)) // Convert to days
      );
      
      // For now, skip balance check as it needs to be implemented in wrapper
      // TODO: Add BROCA balance check to wrapper
      
      // Prepare all files for direct upload
      const filesToUpload = [];
      const fileInfo = [];
      
      // Add all segment and playlist files
      for (const [filename, fileData] of Object.entries(allHashes)) {
        filesToUpload.push({
          content: fileData.content,
          filename: filename,
          cid: fileData.hash,
          size: fileData.content.length
        });
        fileInfo.push({ cid: fileData.hash, size: fileData.content.length });
      }
      
      // Add master playlist
      filesToUpload.push({
        content: Buffer.from(masterPlaylist),
        filename: 'master.m3u8',
        cid: masterHash,
        size: masterPlaylist.length
      });
      fileInfo.push({ cid: masterHash, size: masterPlaylist.length });
      
      // Add thumbnail if available
      if (thumbnail) {
        filesToUpload.push({
          content: thumbnail.buffer,
          filename: 'thumbnail.jpg',
          cid: thumbnail.cid,
          size: thumbnail.buffer.length
        });
        fileInfo.push({ cid: thumbnail.cid, size: thumbnail.buffer.length });
      }
      
      // Create File-like objects for upload
      const files = filesToUpload.map(f => ({
        name: f.filename,
        size: f.size,
        type: 'application/octet-stream',
        arrayBuffer: async () => f.content
      }));
      
      // Create metadata for the upload
      const uploadMetadata = {
        type: 'video',
        resolutions: Object.keys(resolutionData),
        duration: metadata.duration,
        thumbnail: thumbnail?.cid,
        masterPlaylist: masterHash
      };
      
      // Determine upload method
      let uploadResult;
      
      if (uploadOptions.uploadMethod === 'direct' && this.directUploadService) {
        // Use direct upload service (pins to local IPFS and broadcasts to network)
        this.emit('progress', { 
          uploadId, 
          stage: 'finalizing', 
          progress: 60, 
          message: 'Using direct upload to SPK Network...' 
        });
        
        // Prepare files for direct upload
        const directUploadFiles = filesToUpload.map(f => ({
          name: f.filename,
          content: f.content,
          size: f.size,
          type: this.getMimeType(f.filename)
        }));
        
        uploadResult = await this.directUploadService.directUploadVideo({
          files: directUploadFiles,
          masterPlaylistCID: masterHash,
          thumbnail: thumbnail ? { cid: thumbnail.cid } : null,
          resolutions: resolutionData
        }, {
          metadata: uploadMetadata
        });
        
        // Convert to expected contract format
        contract = {
          contractId: uploadResult.directUploadId,
          transactionId: uploadResult.transactionId,
          brocaCost: uploadResult.totalSize, // Direct upload uses 1:1 BROCA
          totalSize: uploadResult.totalSize
        };
        
      } else if (this.integratedStorage) {
        // Use integrated storage for automatic IPFS pinning and PoA rewards
        contract = await this.integratedStorage.directUploadWithStorage(files, {
          duration: uploadOptions.contract.duration,
          metadata: uploadMetadata
        });
      } else {
        // Use wrapper's standard upload method (public nodes)
        contract = await this.spkClient.directUpload(files, {
          duration: Math.floor(uploadOptions.contract.duration / (24 * 60 * 60)), // Convert to days
          metadata: uploadMetadata
        });
      }
      
      this.emit('progress', { 
        uploadId, 
        stage: 'finalizing', 
        progress: 100, 
        message: 'Upload complete!' 
      });
      
      // Cleanup temp files
      await this.cleanup();
      
      return {
        masterPlaylistCID: masterHash,
        thumbnail: thumbnail ? {
          cid: thumbnail.cid,
          mimeType: thumbnail.mimeType
        } : null,
        resolutions: resolutionData,
        contract: {
          id: contract.contractId,
          transactionId: contract.transactionId,
          status: 'complete',
          cost: contract.brocaCost,
          totalSize: contract.totalSize
        },
        uploadStats: {
          totalSize,
          filesUploaded: totalFiles,
          duration: Date.now() - parseInt(uploadId.split('-')[0], 16)
        }
      };
      
    } catch (error) {
      this.emit('error', { uploadId, error });
      await this.cleanup();
      throw error;
    } finally {
      if (this.activeUpload === uploadId) {
        this.activeUpload = null;
      }
    }
  }

  /**
   * Cancel active upload
   */
  cancel() {
    this.activeUpload = null;
    this.transcoder.cancelAll();
  }

  /**
   * Pause upload
   */
  pause() {
    this.isPaused = true;
  }

  /**
   * Resume upload
   */
  async resume() {
    if (!this.savedState) {
      throw new Error('No saved state to resume from');
    }
    
    this.isPaused = false;
    const state = this.savedState;
    
    // Continue from where we left off
    return this.uploadVideo(state.videoPath, state.uploadOptions);
  }

  /**
   * Save upload state
   */
  async saveState(state) {
    this.savedState = state;
    
    // Also save to disk for persistence
    const statePath = path.join(
      process.env.HOME || process.env.USERPROFILE,
      '.spk-desktop',
      'upload-state.json'
    );
    
    await fs.writeFile(statePath, JSON.stringify(state));
  }

  /**
   * Load saved state
   */
  async loadState(state) {
    this.savedState = state;
  }

  /**
   * Get saved state
   */
  async getSavedState() {
    return this.savedState;
  }

  /**
   * Get temp files
   */
  async getTempFiles() {
    return Array.from(this.tempFiles);
  }

  /**
   * Cleanup temporary files
   */
  async cleanup() {
    for (const tempPath of this.tempFiles) {
      try {
        await fs.rmdir(tempPath, { recursive: true });
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    this.tempFiles.clear();
  }

  /**
   * Calculate bandwidth for resolution
   */
  calculateBandwidth(resolution) {
    const bandwidths = {
      '2160p': 15000000,
      '1080p': 5000000,
      '720p': 2500000,
      '480p': 1000000,
      '360p': 500000
    };
    return bandwidths[resolution] || 2500000;
  }

  /**
   * Get resolution width
   */
  getResolutionWidth(resolution) {
    const widths = {
      '2160p': 3840,
      '1080p': 1920,
      '720p': 1280,
      '480p': 854,
      '360p': 640
    };
    return widths[resolution] || 1280;
  }

  /**
   * Get resolution height
   */
  getResolutionHeight(resolution) {
    const heights = {
      '2160p': 2160,
      '1080p': 1080,
      '720p': 720,
      '480p': 480,
      '360p': 360
    };
    return heights[resolution] || 720;
  }

  /**
   * Get MIME type from filename
   */
  getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.mp4': 'video/mp4',
      '.m3u8': 'application/x-mpegURL',
      '.ts': 'video/MP2T',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp'
    };
    
    return mimeTypes[ext] || 'application/octet-stream';
  }
}

module.exports = VideoUploadService;
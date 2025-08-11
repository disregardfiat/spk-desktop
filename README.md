This Project has become Oratr

You can find it at [spknetwork/oratr](https://github.com/spknetwork/oratr/)

This Fork is no longer maintained.

# SPK Desktop

A native desktop application for the SPK Network providing video transcoding, IPFS file management, and ProofOfAccess storage node capabilities.

## Features

- **Native FFmpeg Integration**: 10-100x faster video transcoding than WebAssembly
- **IPFS Node**: Built-in IPFS node for direct file pinning and retrieval
- **ProofOfAccess Storage**: Run a storage node to earn rewards
- **Multi-Resolution Transcoding**: Automatic HLS encoding at multiple bitrates
- **Batch Processing**: Queue and process multiple videos
- **Cross-Platform**: Windows, macOS, and Linux support

## Architecture

### Test-Driven Development

This project follows strict TDD principles:
1. Write tests first
2. Implement minimal code to pass tests
3. Refactor with confidence

### Project Structure

```
spk-desktop/
├── src/
│   ├── main/              # Electron main process
│   │   ├── index.js       # Entry point
│   │   ├── ipc/           # IPC handlers
│   │   └── services/      # Core services
│   ├── renderer/          # Electron renderer process
│   │   ├── index.html     # Main window
│   │   └── js/            # Frontend code
│   ├── core/              # Business logic
│   │   ├── ffmpeg/        # Video transcoding
│   │   ├── ipfs/          # IPFS integration
│   │   ├── storage/       # ProofOfAccess storage
│   │   └── spk/           # SPK Network integration
│   └── shared/            # Shared utilities
├── test/
│   ├── unit/              # Unit tests
│   ├── integration/       # Integration tests
│   └── e2e/               # End-to-end tests
└── package.json
```

## Development

### Prerequisites

- Node.js 18+
- FFmpeg (installed system-wide)
- Git

### Setup

```bash
# Clone the repository
git clone [repository-url]
cd spk-desktop

# Install dependencies
npm install

# Run tests in watch mode
npm run dev

# Start the application
npm start
```

### Testing

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests
npm run test:integration

# Run e2e tests
npm run test:e2e

# Generate coverage report
npm run test:coverage
```

### Building

```bash
# Build for current platform
npm run build

# Build for specific platforms
npm run build:win
npm run build:mac
npm run build:linux
```

## Core Modules

### Video Transcoder
- Wraps native FFmpeg for high-performance encoding
- Supports multiple input formats
- Generates HLS output with configurable quality levels
- Progress tracking and cancellation

### IPFS Manager
- Manages local IPFS node lifecycle
- Handles file pinning and unpinning
- Generates CIDs using ipfs-only-hash
- Monitors storage usage

### Storage Node
- Implements ProofOfAccess protocol
- Responds to validation challenges
- Manages stored content
- Tracks earnings and statistics

### SPK Integration
- Interfaces with SPK Network APIs
- Handles authentication
- Manages storage contracts
- Monitors BROCA balance

## Configuration

Configuration is stored in:
- Windows: `%APPDATA%/spk-desktop`
- macOS: `~/Library/Application Support/spk-desktop`
- Linux: `~/.config/spk-desktop`

## API Integration

The app integrates with:
- SPK Network APIs for contracts and authentication
- IPFS HTTP API for file operations
- ProofOfAccess network for storage validation
- Hive blockchain for account management

## Contributing

1. Fork the repository
2. Create a feature branch
3. Write tests for new functionality
4. Implement the feature
5. Ensure all tests pass
6. Submit a pull request

## License

MIT License - see LICENSE file for details

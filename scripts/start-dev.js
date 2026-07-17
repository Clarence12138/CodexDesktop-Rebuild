#!/usr/bin/env node
/**
 * Smart development startup script
 * Automatically detects system architecture and sets correct CLI path
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Detect platform and architecture
const platform = process.platform;
const arch = os.arch();

const binDir = { arm64: 'darwin-arm64', x64: 'darwin-x64' }[arch];
if (platform !== 'darwin') {
  console.error(`Unsupported platform: ${platform}; macOS is required`);
  process.exit(1);
}
if (!binDir) {
  console.error(`Unsupported macOS architecture: ${arch}`);
  process.exit(1);
}

const cliName = 'codex';

// Priority: upstream CLI from src/ > @cometix/codex vendor > resources/bin/
const srcPlatform = arch === 'arm64' ? 'mac-arm64' : 'mac-x64';

const candidates = [
  // 1. Upstream CLI (from sync-upstream, matches app version)
  path.join(__dirname, '..', 'src', srcPlatform, cliName),
  // 2. @cometix/codex platform package (0.128+ uses separate packages)
  (() => {
    const pkgMap = {
      'darwin-arm64': 'codex-darwin-arm64',
      'darwin-x64': 'codex-darwin-x64',
    };
    const tripleMap = {
      'darwin-arm64': 'aarch64-apple-darwin',
      'darwin-x64': 'x86_64-apple-darwin',
    };
    const pkg = pkgMap[binDir], triple = tripleMap[binDir];
    if (!pkg || !triple) return null;
    // New structure: @cometix/codex-{platform}/vendor/{triple}/codex/codex
    const newPath = path.join(__dirname, '..', 'node_modules', '@cometix', pkg, 'vendor', triple, 'codex', cliName);
    if (fs.existsSync(newPath)) return newPath;
    // Old structure: @cometix/codex/vendor/{triple}/codex/codex
    const oldPath = path.join(__dirname, '..', 'node_modules', '@cometix', 'codex', 'vendor', triple, 'codex', cliName);
    return fs.existsSync(oldPath) ? oldPath : null;
  })(),
  // 3. Local resources/bin/
  path.join(__dirname, '..', 'resources', 'bin', binDir, cliName),
].filter(Boolean);

const cliPath = candidates.find(p => fs.existsSync(p));

// Verify CLI exists
if (!fs.existsSync(cliPath)) {
  console.error(`CLI not found at: ${cliPath}`);
  console.error('Tried: resources/bin/ and node_modules/@cometix/codex/vendor/');
  process.exit(1);
}

// Resolve app entry: prefer platform-specific _asar/ (has its own package.json)
const appRoot = path.join(__dirname, '..', 'src', srcPlatform, '_asar');
const appEntry = fs.existsSync(appRoot) ? appRoot : path.join(__dirname, '..');

console.log(`[start-dev] Platform: ${platform}, Arch: ${arch}`);
console.log(`[start-dev] CLI Path: ${cliPath}`);
console.log(`[start-dev] App Root: ${appEntry}`);

// Launch Electron with CLI path
const electronBin = require('electron');
const child = spawn(electronBin, [appEntry], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: {
    ...process.env,
    CODEX_CLI_PATH: cliPath,
    BUILD_FLAVOR: process.env.BUILD_FLAVOR || 'dev',
    ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL || 'app://-/index.html',
    CODEX_ELECTRON_RESOURCES_PATH: path.join(__dirname, '..', 'src', srcPlatform),
    CODEX_ELECTRON_BUNDLED_PLUGINS_RESOURCES_PATH: path.join(__dirname, '..', 'src', srcPlatform),
    CODEX_NODE_REPL_PATH: path.join(__dirname, '..', 'src', srcPlatform, 'node_repl'),
    CODEX_BROWSER_USE_NODE_PATH: path.join(__dirname, '..', 'src', srcPlatform, 'node'),
  },
});

child.on('close', (code) => {
  process.exit(code);
});

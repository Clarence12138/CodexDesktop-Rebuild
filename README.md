# Codex Desktop Rebuild

macOS rebuild pipeline for the OpenAI Codex Desktop App.

## Supported Platforms

| Platform | Architecture | Status |
|----------|--------------|--------|
| macOS    | arm64, x64   | ✅     |

## Build

```bash
# Install locked dependencies
npm ci

# Rebuild an installed single-architecture app
npm run rebuild:mac-arm64 -- --local-mac-app /Applications/Codex.app

# Or download and rebuild both architectures from the official appcasts
npm run rebuild:mac

# Validate patch compatibility without changing extracted sources
node scripts/patch-all.js mac-arm64 --check

# Strictly verify that every patch is already applied
node scripts/patch-all.js mac-arm64 --verify
```

Generated images are written to `out/Codex-<platform>-<version>.dmg`.
The rebuild fails explicitly on upstream download, extraction, patch verification,
ASAR integrity, code-signing, or DMG verification errors.

### Individual stages

```bash
# Download and extract both upstream macOS variants
npm run sync

# Restrict synchronization to one architecture
npm run sync -- --mac-platform mac-x64

# Apply patches
npm run patch:mac

# Build one or both architectures
npm run build:mac-arm64
npm run build:mac-x64
npm run build:mac
```

## Development

Development is supported on macOS arm64 and x64:

```bash
npm run dev
```

## Project Structure

```text
├── src/                     # Extracted upstream app resources (generated)
├── resources/               # macOS icons and bundled resources
├── scripts/                 # Sync, patch, build, and verification tools
├── tests/                   # Build-pipeline and patch tests
└── package.json
```

## CI/CD

- `Build macOS (Manual)` verifies the code and builds arm64/x64 DMGs.
- `Sync Upstream & Release macOS` synchronizes both official appcasts, applies
  and strictly verifies patches, builds exactly two DMGs, then creates a draft
  GitHub Release.

## Credits

**© OpenAI · Cometix Space**

- [OpenAI Codex](https://github.com/openai/codex) — original Codex CLI (Apache-2.0)
- [Cometix Space](https://github.com/Haleclipse) — original rebuild project

## License

This project rebuilds the Codex Desktop app for macOS distribution.
Original Codex CLI by OpenAI is licensed under Apache-2.0.

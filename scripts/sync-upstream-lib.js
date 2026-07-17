const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const asar = require("@electron/asar");

const MAC_VARIANTS = Object.freeze({ arm64: "mac-arm64", x86_64: "mac-x64" });

function parseArgs(argv) {
  const options = {
    force: false,
    checkOnly: false,
    skipMac: false,
    skipWin: false,
    localMacApp: null,
    macPlatform: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") options.force = true;
    else if (arg === "--check-only") options.checkOnly = true;
    else if (arg === "--skip-mac") options.skipMac = true;
    else if (arg === "--skip-win") options.skipWin = true;
    else if (arg === "--local-mac-app") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--local-mac-app requires a path");
      options.localMacApp = path.resolve(value);
      index += 1;
    } else if (arg === "--mac-platform") {
      const value = argv[index + 1];
      if (!value || !["mac-arm64", "mac-x64"].includes(value)) {
        throw new Error("--mac-platform must be mac-arm64 or mac-x64");
      }
      options.macPlatform = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.skipMac && options.localMacApp) {
    throw new Error("--local-mac-app cannot be combined with --skip-mac");
  }
  if (options.skipMac && options.macPlatform) {
    throw new Error("--mac-platform cannot be combined with --skip-mac");
  }
  return Object.freeze(options);
}

function clearDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function removeCacheEntries(paths, force) {
  if (!force) return;
  for (const entry of paths) fs.rmSync(entry, { recursive: true, force: true });
}

function getZipExtractor(archive, destination, platform = process.platform) {
  if (!archive.endsWith(".zip")) return null;
  if (platform === "darwin") {
    return { binary: "ditto", args: ["-xk", archive, destination] };
  }
  if (platform === "linux") {
    return { binary: "unzip", args: ["-q", archive, "-d", destination] };
  }
  return null;
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return fullPath;
    if (!entry.isDirectory()) continue;
    const found = findFile(fullPath, name);
    if (found) return found;
  }
  return null;
}

function findMacApp(rootDir) {
  const root = path.resolve(rootDir);
  const candidates = [];
  if (path.extname(root).toLowerCase() === ".app") candidates.push(root);

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.name.toLowerCase().endsWith(".app")) candidates.push(fullPath);
      else visit(fullPath);
    }
  }

  if (fs.existsSync(root) && fs.statSync(root).isDirectory() && candidates.length === 0) visit(root);
  const valid = candidates.filter((appPath) =>
    fs.existsSync(path.join(appPath, "Contents", "Resources", "app.asar")),
  );
  if (valid.length === 0) throw new Error(`No macOS app bundle containing app.asar found in ${root}`);
  if (valid.length > 1) throw new Error(`Multiple macOS app bundles containing app.asar found in ${root}`);
  return valid[0];
}

function readPlistValue(plistPath, key) {
  return execFileSync("plutil", ["-extract", key, "raw", plistPath], { encoding: "utf8" }).trim();
}

function parseArchitectures(output) {
  const architectures = output.trim().split(/\s+/).filter(Boolean);
  const unsupported = architectures.filter((arch) => !MAC_VARIANTS[arch]);
  if (unsupported.length > 0) throw new Error(`Unsupported macOS architecture: ${unsupported.join(", ")}`);
  if (architectures.length === 0) throw new Error("No architecture found in macOS executable");
  return [...new Set(architectures)];
}

function validateMacMetadata(metadata, expected = {}) {
  if (metadata.bundleIdentifier !== "com.openai.codex") {
    throw new Error(`Unexpected bundle identifier: ${metadata.bundleIdentifier || "(missing)"}`);
  }
  if (!metadata.version) throw new Error("macOS app has no CFBundleShortVersionString");
  if (!metadata.build) throw new Error("macOS app has no CFBundleVersion");
  if (!metadata.executable) throw new Error("macOS app has no CFBundleExecutable");
  if (metadata.asarVersion !== metadata.version) {
    throw new Error(`Version mismatch: Info.plist=${metadata.version}, app.asar=${metadata.asarVersion}`);
  }
  if (expected.version && metadata.version !== expected.version) {
    throw new Error(`Version mismatch: expected ${expected.version}, found ${metadata.version}`);
  }
  if (expected.build && metadata.build !== String(expected.build)) {
    throw new Error(`Build mismatch: expected ${expected.build}, found ${metadata.build}`);
  }
  if (expected.variant && !metadata.variants.includes(expected.variant)) {
    throw new Error(`Architecture mismatch: expected ${expected.variant}, found ${metadata.variants.join(", ")}`);
  }
  return metadata;
}

function inspectMacApp(appPath, expected = {}) {
  if (process.platform !== "darwin") throw new Error("macOS app validation requires macOS");
  const resolvedApp = findMacApp(appPath);
  const contentsDir = path.join(resolvedApp, "Contents");
  const plistPath = path.join(contentsDir, "Info.plist");
  const asarPath = path.join(contentsDir, "Resources", "app.asar");
  if (!fs.existsSync(plistPath)) throw new Error(`${resolvedApp}: Info.plist not found`);

  const executable = readPlistValue(plistPath, "CFBundleExecutable");
  const executablePath = path.join(contentsDir, "MacOS", executable);
  if (!fs.existsSync(executablePath)) throw new Error(`${resolvedApp}: executable not found: ${executable}`);
  const architectures = parseArchitectures(
    execFileSync("lipo", ["-archs", executablePath], { encoding: "utf8" }),
  );
  const packageJson = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
  const metadata = {
    appPath: resolvedApp,
    resourcesDir: path.dirname(asarPath),
    executable,
    bundleIdentifier: readPlistValue(plistPath, "CFBundleIdentifier"),
    version: readPlistValue(plistPath, "CFBundleShortVersionString"),
    build: readPlistValue(plistPath, "CFBundleVersion"),
    asarVersion: packageJson.version,
    variants: architectures.map((arch) => MAC_VARIANTS[arch]),
  };
  return validateMacMetadata(metadata, expected);
}

module.exports = {
  clearDir,
  findFile,
  findMacApp,
  getZipExtractor,
  inspectMacApp,
  parseArchitectures,
  parseArgs,
  removeCacheEntries,
  validateMacMetadata,
};

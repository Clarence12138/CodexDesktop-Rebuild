#!/usr/bin/env node
/**
 * Synchronize complete upstream resources into src/<platform>.
 *
 * Usage:
 *   node scripts/sync-upstream.js [--force] [--check-only]
 *     [--skip-mac] [--skip-win] [--mac-platform mac-arm64|mac-x64]
 *     [--local-mac-app /path/to/App.app]
 */

const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const tls = require("tls");
const { execFileSync } = require("child_process");
const asar = require("@electron/asar");
const {
  clearDir,
  findFile,
  inspectMacApp,
  parseArgs,
  removeCacheEntries,
} = require("./sync-upstream-lib");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const TEMP_DIR = path.join(os.tmpdir(), "codex-sync");
const VERSION_FILE = path.join(__dirname, ".versions.json");
const APPCASTS = Object.freeze({
  "mac-arm64": "https://persistent.oaistatic.com/codex-app-prod/appcast.xml",
  "mac-x64": "https://persistent.oaistatic.com/codex-app-prod/appcast-x64.xml",
});
const VERSION_KEYS = Object.freeze({
  "mac-arm64": "macOS-arm64",
  "mac-x64": "macOS-x64",
  win: "Windows",
});

function configureTls() {
  const certsDir = path.join(__dirname, "certs");
  const extraCAs = [...tls.rootCertificates];
  for (const filename of ["ms-root-ca.pem", "ms-update-ca.pem"]) {
    const certPath = path.join(certsDir, filename);
    if (fs.existsSync(certPath)) extraCAs.push(fs.readFileSync(certPath, "utf8"));
  }
  https.globalAgent.options.ca = extraCAs;
}

function httpGet(url) {
  const transport = url.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    transport.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const redirected = new URL(response.headers.location, url).toString();
        return httpGet(redirected).then(resolve, reject);
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

function download(url, destination, label) {
  if (!url) throw new Error(`${label}: download URL is missing`);
  const partial = `${destination}.part`;
  fs.rmSync(partial, { force: true });
  console.log(`   [download] ${label}`);
  try {
    execFileSync("curl", ["-fL", "--retry", "3", "--retry-delay", "2", "-o", partial, url], {
      stdio: "inherit",
    });
    fs.renameSync(partial, destination);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
}

function extractArchive(archive, destination) {
  clearDir(destination);
  if (process.platform === "darwin" && archive.endsWith(".zip")) {
    execFileSync("ditto", ["-xk", archive, destination], { stdio: "inherit" });
    return;
  }
  for (const binary of ["7zz", "7z"]) {
    try {
      execFileSync(binary, ["x", "-y", `-o${destination}`, archive], { stdio: "pipe" });
      return;
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw new Error(`Failed to extract ${archive} with ${binary}: ${error.message}`);
    }
  }
  throw new Error("Neither 7zz nor 7z is installed");
}

async function getAppcastVersion(url) {
  const { XMLParser } = require("fast-xml-parser");
  const response = await httpGet(url);
  if (response.status !== 200) throw new Error(`Appcast fetch failed: HTTP ${response.status}`);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });
  const parsed = parser.parse(response.body.toString("utf8"));
  const rawItems = parsed.rss?.channel?.item;
  const latest = Array.isArray(rawItems) ? rawItems[0] : rawItems;
  const rawEnclosure = latest?.enclosure;
  const enclosure = Array.isArray(rawEnclosure) ? rawEnclosure[0] : rawEnclosure;
  const info = {
    version: latest?.shortVersionString || latest?.title || "",
    build: String(latest?.version || ""),
    url: enclosure?.["@_url"] || "",
  };
  if (!info.version || !info.build || !info.url) throw new Error("Appcast is missing version, build, or URL");
  return info;
}

async function getWindowsVersion() {
  const msstore = require("./fetch-msstore");
  const cookie = await msstore.getCookie();
  const appInfo = await msstore.getAppInfo("9plm9xgg6vks", "US");
  if (!appInfo.categoryId) throw new Error("Windows Store response has no CategoryID");
  const packages = await msstore.getFileList(cookie, appInfo.categoryId, "Retail");
  if (packages.length === 0) throw new Error("Windows Store returned no packages");
  const pkg = msstore.selectPackageForArchitecture(packages, "x64");
  const version = pkg.name.match(/_(\d+\.\d+\.\d+(?:\.\d+)?)_/)?.[1];
  if (!version) throw new Error(`Cannot determine Windows version from ${pkg.name}`);
  const url = await msstore.getDownloadUrl(pkg.updateID, pkg.revisionNumber, "Retail", pkg.digest);
  if (!url) throw new Error("Windows Store returned no download URL");
  return { version, url, packageName: pkg.name };
}

function copyRecursive(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) count += copyRecursive(sourcePath, destinationPath);
    else if (!entry.isSymbolicLink()) {
      fs.copyFileSync(sourcePath, destinationPath);
      count += 1;
    }
  }
  return count;
}

function countFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    if (entry.isDirectory()) return total + countFiles(path.join(dir, entry.name));
    return total + 1;
  }, 0);
}

function assembleOutput(resourcesDir, destination, label) {
  const asarPath = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(asarPath)) throw new Error(`${label}: app.asar not found`);
  console.log(`   [assemble] -> ${path.relative(PROJECT_ROOT, destination)}/`);
  clearDir(destination);
  asar.extractAll(asarPath, path.join(destination, "_asar"));

  const unpackedSource = path.join(resourcesDir, "app.asar.unpacked");
  if (fs.existsSync(unpackedSource)) copyRecursive(unpackedSource, path.join(destination, "app.asar.unpacked"));
  for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    if (["app.asar", "app.asar.unpacked"].includes(entry.name) || entry.name.endsWith(".lproj")) continue;
    const sourcePath = path.join(resourcesDir, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyRecursive(sourcePath, destinationPath);
    else if (!entry.isSymbolicLink()) fs.copyFileSync(sourcePath, destinationPath);
  }
  console.log(`   [ok] ${countFiles(destination)} files total`);
}

async function syncRemoteMac(variant, info, options) {
  const shortVariant = variant.replace("mac-", "");
  const archive = path.join(TEMP_DIR, `Codex-${shortVariant}-${info.version}.zip`);
  const extractDir = path.join(TEMP_DIR, `${shortVariant}-extract`);
  removeCacheEntries([archive, extractDir], options.force);
  if (!fs.existsSync(archive)) download(info.url, archive, variant);
  else console.log(`   [cache] ${archive}`);
  extractArchive(archive, extractDir);
  const metadata = inspectMacApp(extractDir, { variant, version: info.version, build: info.build });
  assembleOutput(metadata.resourcesDir, path.join(SRC_DIR, variant), variant);
  return info;
}

function cacheLocalMacApp(metadata, options) {
  for (const variant of metadata.variants) {
    const shortVariant = variant.replace("mac-", "");
    const extractDir = path.join(TEMP_DIR, `${shortVariant}-extract`);
    removeCacheEntries([extractDir], options.force);
    clearDir(extractDir);
    execFileSync("ditto", [metadata.appPath, path.join(extractDir, path.basename(metadata.appPath))], {
      stdio: "inherit",
    });
    const cached = inspectMacApp(extractDir, { variant, version: metadata.version, build: metadata.build });
    assembleOutput(cached.resourcesDir, path.join(SRC_DIR, variant), variant);
  }
}

async function syncWindows(info, options) {
  const archive = path.join(TEMP_DIR, info.packageName);
  const extractDir = path.join(TEMP_DIR, "win-extract");
  removeCacheEntries([archive, extractDir], options.force);
  if (!fs.existsSync(archive)) download(info.url, archive, "Windows MSIX");
  else console.log(`   [cache] ${archive}`);
  extractArchive(archive, extractDir);
  const resourcesDir = path.join(extractDir, "app", "resources");
  if (!fs.existsSync(resourcesDir)) {
    const asarPath = findFile(extractDir, "app.asar");
    throw new Error(`Windows resources directory not found${asarPath ? `; app.asar is at ${asarPath}` : ""}`);
  }
  assembleOutput(resourcesDir, path.join(SRC_DIR, "win"), "Windows");
  return info;
}

function loadVersions() {
  try {
    return JSON.parse(fs.readFileSync(VERSION_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Cannot read ${VERSION_FILE}: ${error.message}`);
  }
}

function saveVersions(results) {
  const saved = loadVersions();
  const checkedAt = new Date().toISOString();
  for (const [platform, info] of Object.entries(results)) {
    const versionKey = VERSION_KEYS[platform] || platform;
    saved[versionKey] = { version: info.version, build: info.build || "", checkedAt };
    if (versionKey !== platform) delete saved[platform];
  }
  fs.writeFileSync(VERSION_FILE, `${JSON.stringify(saved, null, 2)}\n`);
}

async function main(argv = process.argv.slice(2)) {
  configureTls();
  const options = parseArgs(argv);
  console.log("== Codex upstream sync ==");
  const detected = {};
  let localMetadata = null;

  if (!options.skipMac && options.localMacApp) {
    localMetadata = inspectMacApp(options.localMacApp);
    const variants = options.macPlatform ? [options.macPlatform] : localMetadata.variants;
    for (const variant of variants) {
      if (!localMetadata.variants.includes(variant)) {
        throw new Error(`Local App does not contain ${variant}`);
      }
      detected[variant] = { version: localMetadata.version, build: localMetadata.build, local: true };
    }
  } else if (!options.skipMac) {
    for (const [variant, appcast] of Object.entries(APPCASTS)) {
      if (options.macPlatform && variant !== options.macPlatform) continue;
      detected[variant] = await getAppcastVersion(appcast);
    }
  }
  if (!options.skipWin) detected.win = await getWindowsVersion();

  for (const [platform, info] of Object.entries(detected)) {
    console.log(`   ${platform}: ${info.version}${info.build ? ` (build ${info.build})` : ""}`);
  }
  if (options.checkOnly) return detected;

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const completed = {};
  if (localMetadata) {
    const selectedMetadata = {
      ...localMetadata,
      variants: Object.keys(detected),
    };
    cacheLocalMacApp(selectedMetadata, options);
    for (const variant of selectedMetadata.variants) completed[variant] = detected[variant];
  } else {
    for (const variant of Object.keys(APPCASTS)) {
      if (detected[variant]) completed[variant] = await syncRemoteMac(variant, detected[variant], options);
    }
  }
  if (detected.win) completed.win = await syncWindows(detected.win, options);
  saveVersions(completed);
  console.log("== Done ==");
  return completed;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n[x] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };

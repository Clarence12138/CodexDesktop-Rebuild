const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const asar = require("@electron/asar");

const {
  clearDir,
  computeAsarHeaderHash,
  findAppBundle,
  getVersion,
  packAsar,
} = require("./build-common");

const INTEGRITY_HASH_KEY = "ElectronAsarIntegrity.Resources/app\\.asar.hash";
const INTEGRITY_ALGORITHM_KEY = "ElectronAsarIntegrity.Resources/app\\.asar.algorithm";
const DEVICE_KIT_MODULES = "node_modules/@worklouder/device-kit-oai/node_modules/@worklouder/wl-device-kit/node_modules";
const MAC_NATIVE_UNPACK_DIRECTORIES = Object.freeze([
  `${DEVICE_KIT_MODULES}/node-hid`,
  `${DEVICE_KIT_MODULES}/serialport`,
  "node_modules/better-sqlite3",
  "node_modules/node-pty",
  "node_modules/objc-js",
]);

function exec(command, args, options = {}) {
  return execFileSync(command, args, { stdio: "pipe", ...options });
}

function readPlist(infoPlist, key) {
  return exec("plutil", ["-extract", key, "raw", infoPlist], {
    encoding: "utf-8",
  }).trim();
}

function updateBundleMetadata(infoPlist, asarPath) {
  const hash = computeAsarHeaderHash(asarPath);
  const replacements = [
    [INTEGRITY_HASH_KEY, hash],
    [INTEGRITY_ALGORITHM_KEY, "SHA256"],
    ["CFBundleDisplayName", "Codex"],
    ["CFBundleName", "Codex"],
  ];
  for (const [key, value] of replacements) {
    exec("plutil", ["-replace", key, "-string", value, infoPlist]);
  }
  if (readPlist(infoPlist, INTEGRITY_HASH_KEY) !== hash) {
    throw new Error("Info.plist ASAR integrity hash verification failed");
  }
  console.log(`   [integrity] hash updated: ${hash.slice(0, 16)}...`);
}

function expectedArchitecture(platform) {
  return platform === "mac-arm64" ? "arm64" : "x86_64";
}

function verifyBinaryArchitecture(binaryPath, platform) {
  const output = exec("file", [binaryPath], { encoding: "utf-8" });
  const architecture = expectedArchitecture(platform);
  if (!output.includes(architecture)) {
    throw new Error(`${binaryPath} is not ${architecture}: ${output.trim()}`);
  }
}

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function verifyUnpackedNativeModules({ asarPath, sourceDir }) {
  const nativeFiles = listFiles(sourceDir).filter((file) => file.endsWith(".node"));
  if (nativeFiles.length === 0) throw new Error("ASAR source contains no native modules");
  for (const file of nativeFiles) {
    const relativePath = path.relative(sourceDir, file).split(path.sep).join("/");
    const stat = asar.statFile(asarPath, relativePath);
    if (!stat.unpacked) throw new Error(`Native module is packed inside ASAR: ${relativePath}`);
    const physicalPath = path.join(`${asarPath}.unpacked`, relativePath);
    if (!fs.existsSync(physicalPath)) {
      throw new Error(`Unpacked native module is missing: ${physicalPath}`);
    }
  }
  const spawnHelper = "node_modules/node-pty/build/Release/spawn-helper";
  if (!asar.statFile(asarPath, spawnHelper).unpacked) {
    throw new Error(`node-pty helper is packed inside ASAR: ${spawnHelper}`);
  }
  if (!fs.existsSync(path.join(`${asarPath}.unpacked`, spawnHelper))) {
    throw new Error(`Unpacked node-pty helper is missing: ${spawnHelper}`);
  }
  console.log(`   [verify] ${nativeFiles.length} native modules and node-pty helper are unpacked`);
}

function verifyApp({ appPath, asarPath, platform }) {
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  const expectedHash = computeAsarHeaderHash(asarPath);
  const executableName = readPlist(infoPlist, "CFBundleExecutable");
  const executablePath = path.join(appPath, "Contents", "MacOS", executableName);
  const codexPath = path.join(appPath, "Contents", "Resources", "codex");

  if (readPlist(infoPlist, "CFBundleIdentifier") !== "com.openai.codex") {
    throw new Error("Unexpected bundle identifier");
  }
  if (readPlist(infoPlist, "CFBundleDisplayName") !== "Codex") {
    throw new Error("Bundle display name was not updated to Codex");
  }
  if (readPlist(infoPlist, INTEGRITY_HASH_KEY) !== expectedHash) {
    throw new Error("Packaged ASAR hash does not match Info.plist");
  }
  verifyBinaryArchitecture(executablePath, platform);
  verifyBinaryArchitecture(codexPath, platform);
  exec("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
  console.log("   [verify] bundle identity, architectures, ASAR hash, and signature verified");
}

function locateSourceApp(platform) {
  const variant = platform === "mac-arm64" ? "arm64" : "x64";
  const extractDir = path.join(os.tmpdir(), "codex-sync", `${variant}-extract`);
  const appPath = findAppBundle(extractDir);
  if (!appPath) {
    throw new Error(`No upstream .app with app.asar found in ${extractDir}; run sync first`);
  }
  return appPath;
}

function buildMac({ outDir, platform, projectRoot, srcDir }) {
  const platformDir = path.join(srcDir, platform);
  const asarDir = path.join(platformDir, "_asar");
  if (!fs.existsSync(asarDir)) throw new Error(`${platform}/_asar is missing; run sync first`);

  const sourceApp = locateSourceApp(platform);
  const outputDir = path.join(outDir, platform);
  const outputApp = path.join(outputDir, "Codex.app");
  clearDir(outputDir);
  console.log(`   [source] ${sourceApp}`);
  exec("ditto", [sourceApp, outputApp], { stdio: "inherit" });

  const resourcesDir = path.join(outputApp, "Contents", "Resources");
  const asarPath = path.join(resourcesDir, "app.asar");
  packAsar({
    source: asarDir,
    destination: asarPath,
    cwd: projectRoot,
    unpackDirectories: MAC_NATIVE_UNPACK_DIRECTORIES,
  });
  verifyUnpackedNativeModules({ asarPath, sourceDir: asarDir });
  const infoPlist = path.join(outputApp, "Contents", "Info.plist");
  updateBundleMetadata(infoPlist, asarPath);

  exec("codesign", ["--remove-signature", outputApp]);
  exec("xattr", ["-rd", "com.apple.quarantine", outputApp]);
  console.log("   [codex] preserved upstream binary");
  exec("codesign", ["--sign", "-", "--force", "--deep", outputApp], {
    stdio: "inherit",
  });
  verifyApp({ appPath: outputApp, asarPath, platform });

  const version = getVersion(asarDir);
  const dmgPath = path.join(outDir, `Codex-${platform}-${version}.dmg`);
  fs.rmSync(dmgPath, { force: true });
  exec(
    "hdiutil",
    ["create", "-volname", "Codex", "-srcfolder", outputDir, "-ov", "-format", "UDZO", dmgPath],
    { stdio: "inherit" },
  );
  exec("hdiutil", ["verify", dmgPath], { stdio: "inherit" });
  console.log(`   [ok] ${dmgPath} (${(fs.statSync(dmgPath).size / 1048576).toFixed(1)} MB)`);
  return dmgPath;
}

module.exports = {
  buildMac,
  expectedArchitecture,
  locateSourceApp,
  verifyUnpackedNativeModules,
  updateBundleMetadata,
  verifyApp,
};

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function packAsar({ source, destination, cwd }) {
  const asarLibrary = require.resolve("@electron/asar");
  const asarCli = path.resolve(path.dirname(asarLibrary), "..", "bin", "asar.mjs");
  if (!fs.existsSync(asarCli)) throw new Error(`ASAR CLI not found: ${asarCli}`);
  execFileSync(process.execPath, [asarCli, "pack", source, destination], {
    cwd,
    stdio: "inherit",
  });
}

function clearDir(dir) {
  fs.rmSync(dir, { force: true, recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      count += copyRecursive(sourcePath, destinationPath);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(sourcePath), destinationPath);
      count += 1;
    } else {
      fs.copyFileSync(sourcePath, destinationPath);
      count += 1;
    }
  }
  return count;
}

function computeAsarHeaderHash(asarPath) {
  const buffer = fs.readFileSync(asarPath);
  const headerSize = buffer.readUInt32LE(12);
  const header = buffer.subarray(16, 16 + headerSize);
  return crypto.createHash("sha256").update(header).digest("hex");
}

function findAppBundle(root) {
  if (!fs.existsSync(root)) return null;
  const rootAsar = path.join(root, "Contents", "Resources", "app.asar");
  if (root.endsWith(".app") && fs.existsSync(rootAsar)) return root;
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(current, entry.name);
      const asarPath = path.join(candidate, "Contents", "Resources", "app.asar");
      if (entry.name.endsWith(".app") && fs.existsSync(asarPath)) return candidate;
      queue.push(candidate);
    }
  }
  return null;
}

function getVersion(asarDir) {
  const packagePath = path.join(asarDir, "package.json");
  const appPackage = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
  if (!appPackage.version) throw new Error(`No version in ${packagePath}`);
  return appPackage.version;
}

function patchExeHash(exePath, oldHash, newHash) {
  const buffer = fs.readFileSync(exePath);
  const index = buffer.indexOf(Buffer.from(oldHash, "ascii"));
  if (index < 0) throw new Error(`Original ASAR hash not found in ${exePath}`);
  Buffer.from(newHash, "ascii").copy(buffer, index);
  fs.writeFileSync(exePath, buffer);
  if (!fs.readFileSync(exePath).includes(Buffer.from(newHash, "ascii"))) {
    throw new Error(`Updated ASAR hash not found in ${exePath}`);
  }
  console.log(`   [integrity] executable hash patched at offset ${index}`);
}

const PE_MACHINE_X64 = 0x8664;
const DOS_HEADER_SIZE = 64;
const PE_POINTER_OFFSET = 0x3c;
const PE_HEADER_PREFIX_SIZE = 6;

function readPeMachine(binaryPath) {
  const handle = fs.openSync(binaryPath, "r");
  try {
    const dosHeader = Buffer.alloc(DOS_HEADER_SIZE);
    if (fs.readSync(handle, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) {
      throw new Error(`${binaryPath} is not a PE executable`);
    }
    if (dosHeader.toString("ascii", 0, 2) !== "MZ") {
      throw new Error(`${binaryPath} is not a PE executable`);
    }
    const peOffset = dosHeader.readUInt32LE(PE_POINTER_OFFSET);
    const peHeader = Buffer.alloc(PE_HEADER_PREFIX_SIZE);
    if (fs.readSync(handle, peHeader, 0, peHeader.length, peOffset) !== peHeader.length) {
      throw new Error(`${binaryPath} has an invalid PE header`);
    }
    if (peHeader.toString("ascii", 0, 4) !== "PE\0\0") {
      throw new Error(`${binaryPath} has an invalid PE header`);
    }
    return peHeader.readUInt16LE(4);
  } finally {
    fs.closeSync(handle);
  }
}

function verifyPeX64(binaryPath) {
  const machine = readPeMachine(binaryPath);
  if (machine !== PE_MACHINE_X64) {
    throw new Error(`${binaryPath} is not x64 PE (machine 0x${machine.toString(16)})`);
  }
}

module.exports = {
  clearDir,
  computeAsarHeaderHash,
  copyRecursive,
  findAppBundle,
  getVersion,
  packAsar,
  patchExeHash,
  readPeMachine,
  verifyPeX64,
};

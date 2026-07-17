const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function createUnpackDirectoryExpression(unpackDirectories) {
  if (!unpackDirectories || unpackDirectories.length === 0) return null;
  for (const directory of unpackDirectories) {
    if (!directory || /[{},]/.test(directory) || path.isAbsolute(directory)) {
      throw new Error(`Invalid ASAR unpack directory: ${directory}`);
    }
  }
  return unpackDirectories.length === 1
    ? unpackDirectories[0]
    : `{${unpackDirectories.join(",")}}`;
}

function packAsar({ source, destination, cwd, unpackDirectories = [] }) {
  const asarLibrary = require.resolve("@electron/asar");
  const asarCli = path.resolve(path.dirname(asarLibrary), "..", "bin", "asar.mjs");
  if (!fs.existsSync(asarCli)) throw new Error(`ASAR CLI not found: ${asarCli}`);
  const args = [asarCli, "pack"];
  const unpackExpression = createUnpackDirectoryExpression(unpackDirectories);
  if (unpackExpression) args.push("--unpack-dir", unpackExpression);
  args.push(source, destination);
  execFileSync(process.execPath, args, {
    cwd,
    stdio: "inherit",
  });
}

function clearDir(dir) {
  fs.rmSync(dir, { force: true, recursive: true });
  fs.mkdirSync(dir, { recursive: true });
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

module.exports = {
  clearDir,
  computeAsarHeaderHash,
  createUnpackDirectoryExpression,
  findAppBundle,
  getVersion,
  packAsar,
};

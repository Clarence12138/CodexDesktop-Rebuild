const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const TARGETS = Object.freeze({
  "mac-arm64": {
    packageName: "codex-darwin-arm64",
    suffix: "darwin-arm64",
    triple: "aarch64-apple-darwin",
  },
  "mac-x64": {
    packageName: "codex-darwin-x64",
    suffix: "darwin-x64",
    triple: "x86_64-apple-darwin",
  },
  win: {
    packageName: "codex-win32-x64",
    suffix: "win32-x64",
    triple: "x86_64-pc-windows-msvc",
  },
});

function localCandidates(projectRoot, platform) {
  const target = TARGETS[platform];
  if (!target) throw new Error(`Unsupported Codex vendor platform: ${platform}`);
  const binaryName = platform === "win" ? "codex.exe" : "codex";
  return [
    path.join(
      projectRoot,
      "node_modules",
      "@cometix",
      target.packageName,
      "vendor",
      target.triple,
      "codex",
      binaryName,
    ),
    path.join(
      projectRoot,
      "node_modules",
      "@cometix",
      "codex",
      "vendor",
      target.triple,
      "codex",
      binaryName,
    ),
  ];
}

function fetchVendor(projectRoot, platform) {
  const target = TARGETS[platform];
  const baseVersion = execFileSync("npm", ["view", "@cometix/codex", "version"], {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!baseVersion) throw new Error("npm returned an empty @cometix/codex version");

  const packageSpec = `@cometix/codex@${baseVersion}-${target.suffix}`;
  const tempDir = path.join(os.tmpdir(), `cometix-codex-${platform}`);
  const extractDir = path.join(tempDir, "extracted");
  fs.rmSync(tempDir, { force: true, recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
  console.log(`   [codex] fetching ${packageSpec}`);

  const output = execFileSync(
    "npm",
    ["pack", packageSpec, "--pack-destination", tempDir],
    { cwd: tempDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const archiveName = output.trim().split("\n").pop();
  if (!archiveName) throw new Error(`npm pack produced no archive for ${packageSpec}`);
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["xzf", path.join(tempDir, archiveName), "-C", extractDir], {
    stdio: "pipe",
  });

  const binaryName = platform === "win" ? "codex.exe" : "codex";
  const vendorPath = path.join(
    extractDir,
    "package",
    "vendor",
    target.triple,
    "codex",
    binaryName,
  );
  if (!fs.existsSync(vendorPath)) {
    throw new Error(`${packageSpec} does not contain ${target.triple}/codex/${binaryName}`);
  }
  return vendorPath;
}

function resolveCodexVendor(projectRoot, platform) {
  const local = localCandidates(projectRoot, platform).find(fs.existsSync);
  return local || fetchVendor(projectRoot, platform);
}

function replaceCodex({ destination, platform, projectRoot }) {
  const vendorPath = resolveCodexVendor(projectRoot, platform);
  fs.copyFileSync(vendorPath, destination);
  if (platform !== "win") fs.chmodSync(destination, 0o755);
  console.log(`   [codex] replaced with ${vendorPath}`);
  return vendorPath;
}

module.exports = { TARGETS, localCandidates, replaceCodex, resolveCodexVendor };

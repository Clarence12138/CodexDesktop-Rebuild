const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const {
  clearDir,
  computeAsarHeaderHash,
  copyRecursive,
  getVersion,
  patchExeHash,
  verifyPeX64,
} = require("./build-common");

function buildWin({ outDir, projectRoot, srcDir }) {
  const asarDir = path.join(srcDir, "win", "_asar");
  if (!fs.existsSync(asarDir)) throw new Error("win/_asar is missing; run sync first");

  const sourceDir = path.join(os.tmpdir(), "codex-sync", "win-extract", "app");
  if (!fs.existsSync(sourceDir)) throw new Error(`Windows source is missing: ${sourceDir}`);

  const outputRoot = path.join(outDir, "win");
  const outputApp = path.join(outputRoot, "Codex-win32-x64");
  clearDir(outputRoot);
  copyRecursive(sourceDir, outputApp);

  const resourcesDir = path.join(outputApp, "resources");
  const asarPath = path.join(resourcesDir, "app.asar");
  const oldHash = computeAsarHeaderHash(asarPath);
  execFileSync("npx", ["asar", "pack", asarDir, asarPath], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  const newHash = computeAsarHeaderHash(asarPath);
  const executablePath = path.join(outputApp, "Codex.exe");
  if (!fs.existsSync(executablePath)) throw new Error(`Missing ${executablePath}`);
  verifyPeX64(executablePath);
  if (oldHash !== newHash) patchExeHash(executablePath, oldHash, newHash);

  const codexPath = path.join(resourcesDir, "codex.exe");
  if (!fs.existsSync(codexPath)) throw new Error(`Missing ${codexPath}`);
  verifyPeX64(codexPath);
  console.log("   [verify] Codex.exe and codex.exe are x64 PE binaries");
  console.log("   [codex] preserved upstream binary");

  const version = getVersion(asarDir);
  const archivePath = path.join(outDir, `Codex-win-x64-${version}.zip`);
  fs.rmSync(archivePath, { force: true });
  execFileSync("7zz", ["a", "-tzip", "-mx=5", archivePath, "."], {
    cwd: outputApp,
    stdio: "inherit",
  });
  if (!fs.existsSync(archivePath)) throw new Error(`ZIP was not created: ${archivePath}`);
  execFileSync("7zz", ["t", archivePath], { stdio: "inherit" });
  console.log(`   [ok] ${archivePath} (${(fs.statSync(archivePath).size / 1048576).toFixed(1)} MB)`);
  return archivePath;
}

module.exports = { buildWin };

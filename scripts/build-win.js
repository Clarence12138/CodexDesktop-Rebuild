const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const {
  clearDir,
  getVersion,
  verifyPeX64,
} = require("./build-common");

function packageWithElectronForge({ outDir, projectRoot }) {
  const forgeCli = require.resolve("@electron-forge/cli/dist/electron-forge.js");
  clearDir(outDir);
  execFileSync(process.execPath, [forgeCli, "package", "--platform=win32", "--arch=x64"], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  return path.join(outDir, "Codex-win32-x64");
}

function buildWin({ outDir, projectRoot, srcDir }) {
  const asarDir = path.join(srcDir, "win", "_asar");
  if (!fs.existsSync(asarDir)) throw new Error("win/_asar is missing; run sync first");

  const outputApp = packageWithElectronForge({ outDir, projectRoot });
  const resourcesDir = path.join(outputApp, "resources");
  const executablePath = path.join(outputApp, "Codex.exe");
  const asarPath = path.join(resourcesDir, "app.asar");
  for (const requiredPath of [executablePath, asarPath]) {
    if (!fs.existsSync(requiredPath)) throw new Error(`Missing ${requiredPath}`);
  }
  verifyPeX64(executablePath);
  if (fs.existsSync(path.join(resourcesDir, "owl-electron-app.json"))) {
    throw new Error("Standard Electron package still contains Owl runtime metadata");
  }

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

#!/usr/bin/env node
/**
 * Validate the upstream archived-conversation deletion feature.
 *
 * Current Codex builds provide the complete feature natively. This script is
 * intentionally read-only in both normal and --check modes: it verifies the
 * renderer routes, single/bulk UI, main-process IPC handlers, and underlying
 * thread/delete protocol support instead of injecting a duplicate route/UI.
 */
const fs = require("fs");
const path = require("path");
const { parsePatchArgs, SRC_DIR, relPath } = require("./patch-util");

const ASSET_REQUIREMENTS = Object.freeze({
  route: [
    "delete-archived-conversation",
    "delete-all-archived-conversations",
  ],
  ui: [
    "settings.dataControls.archivedChats.delete",
    "settings.dataControls.archivedChats.deleteAll",
    "onDelete",
  ],
});

const MAIN_REQUIREMENTS = Object.freeze({
  ipc: ["delete-archived-thread", "delete-all-archived-threads"],
  protocol: ["delete-archived-thread", "thread/delete"],
});

function listJavaScriptFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".js"))
    .map((file) => path.join(directory, file));
}

function findRequirements(files, requirements) {
  const matches = {};
  for (const [group, markers] of Object.entries(requirements)) {
    const matchedFile = files.find((file) => {
      const source = fs.readFileSync(file, "utf8");
      return markers.every((marker) => source.includes(marker));
    });
    matches[group] = Object.fromEntries(
      markers.map((marker) => [marker, matchedFile ?? null]),
    );
  }
  return matches;
}

function validatePlatform(platform, sourceRoot = SRC_DIR) {
  const asarDir = path.join(sourceRoot, platform, "_asar");
  const assetFiles = listJavaScriptFiles(path.join(asarDir, "webview", "assets"));
  const mainFiles = listJavaScriptFiles(path.join(asarDir, ".vite", "build"));
  if (assetFiles.length === 0 || mainFiles.length === 0) {
    throw new Error(`${platform}: renderer assets or main-process bundles are missing`);
  }

  const matches = {
    ...findRequirements(assetFiles, ASSET_REQUIREMENTS),
    ...findRequirements(mainFiles, MAIN_REQUIREMENTS),
  };
  const missing = [];
  for (const [group, markers] of Object.entries(matches)) {
    for (const [marker, file] of Object.entries(markers)) {
      if (file === null) missing.push(`${group}:${marker}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`${platform}: native archive delete incomplete: ${missing.join(", ")}`);
  }
  return matches;
}

function main() {
  const { platform: requested } = parsePatchArgs(process.argv.slice(2));
  const platforms = requested
    ? [requested]
    : ["mac-arm64", "mac-x64"].filter((platform) =>
        fs.existsSync(path.join(SRC_DIR, platform, "_asar")),
      );

  if (platforms.length === 0) {
    console.error("[x] No extracted platform source found");
    process.exit(1);
  }

  for (const platform of platforms) {
    try {
      const matches = validatePlatform(platform);
      console.log(`  [${platform}] native archive deletion verified`);
      for (const [group, markers] of Object.entries(matches)) {
        const files = [...new Set(Object.values(markers))];
        console.log(`    [ok] ${group}: ${files.map(relPath).join(", ")}`);
      }
    } catch (error) {
      console.error(`  [x] ${error.message}`);
      process.exitCode = 1;
    }
  }
}

if (require.main === module) main();

module.exports = { findRequirements, validatePlatform };

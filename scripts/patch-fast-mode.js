#!/usr/bin/env node
/** Force-enable Fast mode for API-key/custom-model configurations. */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { relPath, SRC_DIR } = require("./patch-util");
const {
  REQUIRED_PATCH_IDS,
  collectFastModePatches,
} = require("./patch-fast-mode-rules");

const PLATFORMS = Object.freeze(["mac-arm64", "mac-x64", "win"]);
const TARGET_MARKERS = Object.freeze([
  "fast_mode",
  "serviceTierForRequest",
  "composer.toggleFastMode",
  "fast_mode_renderer_availability",
  "fast_mode_request_availability",
  "fast_mode_composer_",
  "fast_mode_trigger_indicator",
]);

function findTargets(platforms) {
  const targets = [];
  for (const platform of platforms) {
    const assetsDir = path.join(SRC_DIR, platform, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const file of fs.readdirSync(assetsDir)) {
      if (!file.endsWith(".js")) continue;
      const filePath = path.join(assetsDir, file);
      const source = fs.readFileSync(filePath, "utf8");
      if (TARGET_MARKERS.some((marker) => source.includes(marker))) {
        targets.push({ platform, path: filePath });
      }
    }
  }
  return targets;
}

function applyPatches(source, patches) {
  let code = source;
  for (const patch of [...patches].sort((left, right) => right.start - left.start)) {
    console.log(`    * [${patch.id}] ${patch.original} -> ${patch.replacement}`);
    code = code.slice(0, patch.start) + patch.replacement + code.slice(patch.end);
  }
  return code;
}

function processTarget(target, options) {
  const source = fs.readFileSync(target.path, "utf8");
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const result = collectFastModePatches(ast, source);
  for (const id of result.verified) options.satisfied.add(id);
  if (!options.isVerify) {
    for (const patch of result.patches) options.satisfied.add(patch.id);
  }
  if (result.patches.length === 0) return;

  if (options.isVerify) {
    throw new Error(
      `${relPath(target.path)} still has ${result.patches.length} patchable Fast mode capabilities`,
    );
  }

  console.log(`  [${target.platform}] ${relPath(target.path)}`);
  if (options.isCheck) {
    for (const patch of result.patches) {
      console.log(`    [?] [${patch.id}] ${patch.original} -> ${patch.replacement}`);
    }
    return;
  }
  fs.writeFileSync(target.path, applyPatches(source, result.patches), "utf8");
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) => PLATFORMS.includes(arg));
  const platforms = platform
    ? [platform]
    : PLATFORMS.filter((name) => fs.existsSync(path.join(SRC_DIR, name, "_asar")));
  const targets = findTargets(platforms);
  if (targets.length === 0) throw new Error("No Fast mode targets found");

  const options = {
    isCheck: args.includes("--check"),
    isVerify: args.includes("--verify"),
    satisfied: new Set(),
  };
  for (const target of targets) processTarget(target, options);
  const missing = [...REQUIRED_PATCH_IDS].filter((id) => !options.satisfied.has(id));
  if (missing.length > 0) {
    throw new Error(`Required Fast mode capabilities not satisfied: ${missing.join(", ")}`);
  }
  console.log(`  [ok] Fast mode capabilities: ${[...REQUIRED_PATCH_IDS].join(", ")}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[x] ${error.message}`);
    process.exit(1);
  }
}

module.exports = { findTargets, processTarget };

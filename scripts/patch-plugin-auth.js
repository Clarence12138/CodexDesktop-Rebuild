#!/usr/bin/env node
/** Force-enable bundled plugin and browser/computer-use capabilities. */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");
const {
  REQUIRED_FEATURE_PATCH_IDS,
  findFeatureDefaultPatches,
  findVerifiedFeaturePatchIds,
} = require("./patch-plugin-auth-features");
const {
  findBrowserAvailPatches,
  findGoalGatePatches,
  findPluginAuthPatches,
  findStatsigGatePatches,
} = require("./patch-plugin-auth-renderer");

const PLATFORMS = Object.freeze(["mac-arm64", "mac-x64", "win"]);

function findRendererTargets(platform, assetsDir) {
  const targets = [];
  for (const file of fs.readdirSync(assetsDir)) {
    if (!file.endsWith(".js")) continue;
    const filePath = path.join(assetsDir, file);
    const source = fs.readFileSync(filePath, "utf8");
    const rules = [];
    const smallChatGptCandidate =
      source.length < 5000 && source.includes("chatgpt") && source.includes("!==");

    if (smallChatGptCandidate) rules.push("auth");
    if (
      file.startsWith("use-in-app-browser-use-availability-") ||
      file.startsWith("use-browser-agent-availability-")
    ) {
      rules.push("avail", "gate");
    }
    if (file.startsWith("composer-") && source.includes("goalSlashCommand")) {
      rules.push("goal");
    }
    if (
      !smallChatGptCandidate &&
      source.length < 10000 &&
      source.includes("chatgpt") &&
      (source.includes("authMethod") || source.includes("!=="))
    ) {
      rules.push("auth");
    }
    if (rules.length > 0) targets.push({ platform, path: filePath, rules });
  }
  return targets;
}

function findMainTargets(platform, buildDir) {
  if (!fs.existsSync(buildDir)) return [];
  const targets = [];
  for (const file of fs.readdirSync(buildDir)) {
    if (!file.startsWith("main-") || !file.endsWith(".js")) continue;
    const filePath = path.join(buildDir, file);
    const source = fs.readFileSync(filePath, "utf8");
    if (source.includes("externalBrowserUseAllowed") && source.includes("computerUse")) {
      targets.push({ platform, path: filePath, rules: ["features"] });
    }
  }
  return targets;
}

function locateTargets(platform) {
  const platforms = platform
    ? [platform]
    : PLATFORMS.filter((name) =>
        fs.existsSync(path.join(SRC_DIR, name, "_asar", "webview", "assets")),
      );
  const targets = [];
  for (const name of platforms) {
    const asarDir = path.join(SRC_DIR, name, "_asar");
    const assetsDir = path.join(asarDir, "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    targets.push(...findRendererTargets(name, assetsDir));
    targets.push(...findMainTargets(name, path.join(asarDir, ".vite", "build")));
  }
  return targets;
}

function collectTargetPatches(target, ast, source) {
  const patches = [];
  if (target.rules.includes("auth")) patches.push(...findPluginAuthPatches(ast, source));
  if (target.rules.includes("avail")) patches.push(...findBrowserAvailPatches(ast, source));
  if (target.rules.includes("gate")) patches.push(...findStatsigGatePatches(ast, source));
  if (target.rules.includes("features")) patches.push(...findFeatureDefaultPatches(ast, source));
  if (target.rules.includes("goal")) patches.push(...findGoalGatePatches(ast, source));
  return patches;
}

function applyPatches(source, patches) {
  let result = source;
  for (const patch of [...patches].sort((left, right) => right.start - left.start)) {
    console.log(
      `   * [${patch.id}] offset ${patch.start}: ${patch.original} -> ${patch.replacement}`,
    );
    result = result.slice(0, patch.start) + patch.replacement + result.slice(patch.end);
  }
  return result;
}

function processTarget(target, options) {
  console.log(`\n-- [${target.platform}] ${relPath(target.path)}`);
  const source = fs.readFileSync(target.path, "utf8");
  console.log(`   size: ${(source.length / 1024).toFixed(1)} KB`);
  const start = Date.now();
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  console.log(`   parse: ${Date.now() - start}ms`);
  const patches = collectTargetPatches(target, ast, source);

  for (const id of findVerifiedFeaturePatchIds(ast, source)) options.satisfied.add(id);
  for (const patch of patches) {
    if (REQUIRED_FEATURE_PATCH_IDS.has(patch.id)) options.satisfied.add(patch.id);
  }
  if (patches.length === 0) {
    console.log("   [-] No applicable gate in this heuristic candidate");
    return;
  }
  if (options.isCheck) {
    for (const patch of patches) {
      console.log(
        `   [?] [${patch.id}] offset ${patch.start}: ${patch.original} -> ${patch.replacement}`,
      );
    }
    return;
  }
  fs.writeFileSync(target.path, applyPatches(source, patches), "utf8");
  console.log(`   [ok] ${patches.length} gates patched`);
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) => PLATFORMS.includes(arg));
  const targets = locateTargets(platform);
  if (targets.length === 0) {
    console.error("[x] No plugin auth or browser-use targets found");
    process.exit(1);
  }
  const seen = new Set();
  const uniqueTargets = targets.filter((target) => {
    if (seen.has(target.path)) return false;
    seen.add(target.path);
    return true;
  });
  const options = { isCheck: args.includes("--check"), satisfied: new Set() };
  for (const target of uniqueTargets) processTarget(target, options);

  const missing = [...REQUIRED_FEATURE_PATCH_IDS].filter(
    (id) => !options.satisfied.has(id),
  );
  if (missing.length > 0) {
    console.error(`[x] Required plugin/browser capabilities not satisfied: ${missing.join(", ")}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  REQUIRED_FEATURE_PATCH_IDS,
  findVerifiedFeaturePatchIds,
};

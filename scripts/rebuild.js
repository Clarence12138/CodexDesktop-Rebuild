#!/usr/bin/env node
const path = require("path");
const { execFileSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SUPPORTED = new Set(["mac", "mac-arm64", "mac-x64"]);

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  if (!argv[index + 1]) throw new Error(`${name} requires a value`);
  return argv[index + 1];
}

function parseArgs(argv) {
  const platform = optionValue(argv, "--platform");
  const localMacApp = optionValue(argv, "--local-mac-app");
  if (!SUPPORTED.has(platform)) {
    throw new Error("--platform must be mac, mac-arm64, or mac-x64");
  }
  if (localMacApp && platform === "mac") {
    throw new Error("--local-mac-app requires a single-architecture mac platform");
  }
  return { force: argv.includes("--force"), localMacApp, platform };
}

function runNode(script, args = []) {
  execFileSync(process.execPath, [path.join(__dirname, script), ...args], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });
}

function selectedPlatforms(platform) {
  return platform === "mac" ? ["mac-arm64", "mac-x64"] : [platform];
}

function syncArgs(options) {
  const args = ["--skip-win"];
  if (options.platform && options.platform !== "mac") {
    args.push("--mac-platform", options.platform);
  }
  if (options.force) args.push("--force");
  if (options.localMacApp) args.push("--local-mac-app", options.localMacApp);
  return args;
}

function rebuild(options) {
  const platforms = selectedPlatforms(options.platform);
  runNode("sync-upstream.js", syncArgs(options));

  for (const platform of platforms) {
    runNode("patch-all.js", [platform]);
    runNode("patch-all.js", [platform, "--check"]);
    runNode("build-from-upstream.js", ["--platform", platform]);
  }
  runNode("bump-version.js", ["--platform", platforms[0]]);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(`== Rebuild ${options.platform} ==`);
  rebuild(options);
  console.log("== Rebuild complete ==");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[x] ${error.message}`);
    process.exit(1);
  }
}

module.exports = { optionValue, parseArgs, rebuild, selectedPlatforms, syncArgs };

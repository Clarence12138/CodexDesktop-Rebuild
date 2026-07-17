#!/usr/bin/env node
/**
 * Read upstream version from extracted ASAR and update root package.json.
 *
 * Upstream package.json contains:
 *   "version": "26.325.21211"
 *   "codexBuildNumber": "1255"
 *
 * This script copies those into the root package.json and prints the version
 * to stdout for CI capture.
 *
 * Usage:
 *   node scripts/bump-version.js           # Update package.json and print version
 *   node scripts/bump-version.js --dry-run # Print version without modifying
 *   node scripts/bump-version.js --platform mac-x64
 */
const fs = require("fs");
const path = require("path");

const ROOT_PKG = path.join(__dirname, "..", "package.json");
const ROOT_LOCK = path.join(__dirname, "..", "package-lock.json");
const SRC_DIR = path.join(__dirname, "..", "src");
const PLATFORM_PRIORITY = Object.freeze([
  "mac-arm64",
  "mac-x64",
]);

function parseArgs(argv) {
  const platformIndex = argv.indexOf("--platform");
  if (platformIndex !== -1 && !argv[platformIndex + 1]) {
    throw new Error("--platform requires a value");
  }

  return {
    dryRun: argv.includes("--dry-run"),
    platform: platformIndex === -1 ? null : argv[platformIndex + 1],
  };
}

function findUpstreamPkg({ srcDir = SRC_DIR, platform = null } = {}) {
  const platforms = platform ? [platform] : PLATFORM_PRIORITY;
  for (const candidate of platforms) {
    const packagePath = path.join(srcDir, candidate, "_asar", "package.json");
    if (fs.existsSync(packagePath)) return packagePath;
  }
  return null;
}

function updateVersionFiles({
  packagePath = ROOT_PKG,
  lockPath = ROOT_LOCK,
  version,
  buildNumber = "",
}) {
  const rootPkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
  if (!lock.packages || !lock.packages[""]) {
    throw new Error("package-lock.json is missing packages['']");
  }

  const oldVersion = rootPkg.version;
  rootPkg.version = version;
  if (buildNumber) rootPkg.codexBuildNumber = buildNumber;
  lock.version = version;
  lock.packages[""].version = version;

  fs.writeFileSync(packagePath, `${JSON.stringify(rootPkg, null, 2)}\n`);
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return oldVersion;
}

function main() {
  const { dryRun, platform } = parseArgs(process.argv.slice(2));

  const upstreamPath = findUpstreamPkg({ platform });
  if (!upstreamPath) {
    const expected = platform
      ? `src/${platform}/_asar/package.json`
      : "src/<platform>/_asar/package.json";
    console.error(`[x] No upstream package.json found at ${expected}`);
    process.exit(1);
  }

  const upstream = JSON.parse(fs.readFileSync(upstreamPath, "utf-8"));
  const version = upstream.version;
  const buildNumber = upstream.codexBuildNumber || "";

  if (!version) {
    console.error("[x] No version field in upstream package.json");
    process.exit(1);
  }

  console.log(`   upstream: ${path.relative(path.join(__dirname, ".."), upstreamPath)}`);
  console.log(`   version:  ${version}`);
  console.log(`   build:    ${buildNumber}`);

  if (dryRun) {
    // Print just the version for CI capture
    process.stdout.write(version);
    return;
  }

  const oldVersion = updateVersionFiles({ version, buildNumber });

  console.log(`   ${oldVersion} -> ${version}`);
  console.log("   [ok] package.json and package-lock.json updated");

  // Print version to stdout (last line) for CI
  process.stdout.write(version);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[x] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  PLATFORM_PRIORITY,
  findUpstreamPkg,
  parseArgs,
  updateVersionFiles,
};

#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const { buildMac } = require("./build-mac");
const { buildWin } = require("./build-win");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const BUILD_CONTEXT = Object.freeze({
  outDir: path.join(PROJECT_ROOT, "out"),
  projectRoot: PROJECT_ROOT,
  srcDir: path.join(PROJECT_ROOT, "src"),
});

function parsePlatform(argv) {
  const index = argv.indexOf("--platform");
  const platform = index === -1 ? null : argv[index + 1];
  if (!platform || !["mac-arm64", "mac-x64", "win"].includes(platform)) {
    throw new Error("Usage: build-from-upstream.js --platform <mac-arm64|mac-x64|win>");
  }
  return platform;
}

function main() {
  const platform = parsePlatform(process.argv.slice(2));
  console.log(`\n== Build from upstream: ${platform} ==\n`);
  fs.mkdirSync(BUILD_CONTEXT.outDir, { recursive: true });
  return platform.startsWith("mac")
    ? buildMac({ ...BUILD_CONTEXT, platform })
    : buildWin(BUILD_CONTEXT);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[x] ${error.message}`);
    process.exit(1);
  }
}

module.exports = { BUILD_CONTEXT, main, parsePlatform };

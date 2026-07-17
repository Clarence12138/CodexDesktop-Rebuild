#!/usr/bin/env node
/**
 * Run all patch scripts in sequence.
 *
 * Usage:
 *   node scripts/patch-all.js              # Patch both macOS architectures
 *   node scripts/patch-all.js mac-arm64    # Patch one architecture
 *   node scripts/patch-all.js --check      # Dry-run all
 *   node scripts/patch-all.js --verify     # Require all patches to be applied
 */
const { execFileSync } = require("child_process");
const path = require("path");
const { parsePatchArgs } = require("./patch-util");

const PATCHES = [
  "patch-i18n.js",
  "patch-copyright.js",
  "patch-devtools.js",
  "patch-fast-mode.js",
  "patch-plugin-auth.js",
  "patch-updater.js",
  "patch-sunset.js",
  "patch-archive-delete.js",
];

function main() {
  const { isCheck, isVerify, platform } = parsePatchArgs(process.argv.slice(2));
  const extra = [
    ...(isCheck ? ["--check"] : []),
    ...(isVerify ? ["--verify"] : []),
  ];
  const passArgs = [...(platform ? [platform] : []), ...extra];

  let failed = 0;

  for (const script of PATCHES) {
    const scriptPath = path.join(__dirname, script);
    const label = script.replace(".js", "");
    console.log(`\n== ${label} ==`);

    try {
      execFileSync("node", [scriptPath, ...passArgs], { stdio: "inherit" });
    } catch (e) {
      console.error(`[x] ${label} failed (exit ${e.status})`);
      failed++;
    }
  }

  console.log(`\n== Summary: ${PATCHES.length - failed}/${PATCHES.length} succeeded ==`);
  if (failed > 0) process.exit(1);
}

main();

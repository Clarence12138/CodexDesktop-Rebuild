#!/usr/bin/env node
/**
 * patch-updater.js — Disable every updater bundled in the macOS application
 *
 * AST match: in the file containing shouldIncludeSparkle / shouldIncludeUpdater,
 * find these method definitions and replace their bodies to return false.
 *
 * Specifically targets:
 *   shouldIncludeSparkle(e,t,n){return ...}  → return !1
 *   shouldIncludeWindowsUpdater(e,t,n){return ...}  → return !1
 *   shouldIncludeUpdater(e,t,n){return ...}  → return !1
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, parsePatchArgs, relPath, SRC_DIR } = require("./patch-util");

const UPDATER_METHODS = new Set([
  "shouldIncludeSparkle",
  "shouldIncludeWindowsUpdater",
  "shouldIncludeWindowsMsixUpdater",
  "shouldIncludeUpdater",
]);

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child)
        if (item && typeof item === "object" && item.type) walk(item, visitor);
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

function collectPatches(ast, source) {
  const patches = [];
  const verifiedIds = new Set();

  walk(ast, (node) => {
    // Match: Property with key being an updater method name and value being a FunctionExpression
    if (node.type !== "Property") return;
    const keyName = node.key?.name || node.key?.value;
    if (!UPDATER_METHODS.has(keyName)) return;

    const fn = node.value;
    if (fn?.type !== "FunctionExpression") return;
    const body = fn.body;
    if (!body || body.type !== "BlockStatement") return;
    if (body.body.length !== 1) return;
    const ret = body.body[0];
    if (ret.type !== "ReturnStatement" || !ret.argument) return;

    const retSrc = source.slice(ret.argument.start, ret.argument.end);
    if (retSrc === "!1") {
      verifiedIds.add(keyName);
      return;
    }

    patches.push({
      id: keyName,
      start: ret.argument.start,
      end: ret.argument.end,
      replacement: "!1",
      original: retSrc.length > 50 ? retSrc.slice(0, 47) + "..." : retSrc,
    });
  });

  return { patches, verified: verifiedIds.size, verifiedIds };
}

function locateTargets(platform) {
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", ".vite", "build")),
      );

  const targets = [];
  for (const plat of platforms) {
    const buildDir = path.join(SRC_DIR, plat, "_asar", ".vite", "build");
    if (!fs.existsSync(buildDir)) continue;
    for (const f of fs.readdirSync(buildDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(buildDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      if (
        src.includes("shouldIncludeSparkle") &&
        src.includes("shouldIncludeUpdater")
      ) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }
  return targets;
}

function main() {
  const { isCheck, isVerify, platform } = parsePatchArgs(process.argv.slice(2));

  const targets = locateTargets(platform);
  if (targets.length === 0) {
    console.error("[x] No updater targets found");
    process.exit(1);
  }

  let totalPatched = 0;
  let totalVerified = 0;
  const verifiedIds = new Set();
  for (const bundle of targets) {
    console.log(`  [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const result = collectPatches(ast, source);
    const { patches, verified } = result;
    totalVerified += verified;
    for (const id of result.verifiedIds) verifiedIds.add(id);

    if (isVerify && patches.length > 0) {
      console.error(`    [x] ${patches.length} updater methods are still patchable`);
      process.exitCode = 1;
      continue;
    }

    if (patches.length === 0) {
      if (verified > 0) {
        console.log(`    [ok] ${verified} updater methods already disabled`);
      } else {
        console.log("    [-] Contains updater references but no method definitions");
      }
      continue;
    }

    if (isCheck) {
      for (const p of patches) {
        console.log(`    [?] [${p.id}] ${p.original} -> !1`);
      }
      totalPatched += patches.length;
      continue;
    }

    patches.sort((a, b) => b.start - a.start);
    let code = source;
    for (const p of patches) {
      console.log(`    * [${p.id}] ${p.original} -> !1`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    totalPatched += patches.length;
    console.log(`    [ok] ${patches.length} updater methods disabled`);
  }

  if (isVerify) {
    const missing = [...UPDATER_METHODS].filter((id) => !verifiedIds.has(id));
    if (missing.length > 0) {
      console.error(`[x] Updater methods are not verified: ${missing.join(", ")}`);
      process.exitCode = 1;
    }
  }
  if (totalPatched === 0 && totalVerified === 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { collectPatches };

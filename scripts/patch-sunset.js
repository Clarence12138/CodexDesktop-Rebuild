/**
 * Post-build patch: Disable appSunset forced-update gate
 *
 * Codex uses a Statsig gate to control version sunsetting.
 * When the gate returns true, a full-screen "Update Required" overlay blocks the UI.
 *
 * AST match: find functions containing the sunset i18n key "appSunset",
 * then locate gate checker calls identifier(`numericString`) within them,
 * and replace with !1 (false).
 *
 * Usage:
 *   node scripts/patch-sunset.js [platform]   # Apply patch (unix/win/omit=both)
 *   node scripts/patch-sunset.js --check      # Dry-run: report matches
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { relPath, SRC_DIR } = require("./patch-util");

// ──────────────────────────────────────────────
//  AST walker
// ──────────────────────────────────────────────

function walk(node, visitor, parent) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) {
          walk(item, visitor, node);
        }
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor, node);
    }
  }
}

// ──────────────────────────────────────────────
//  Patch rule
// ──────────────────────────────────────────────

// Structural markers for sunset functions (i18n keys present in the sunset UI)
const SUNSET_MARKERS = ["appSunset", "app.sunset", "sunset"];

function getLiteralValue(node) {
  if (!node) return null;
  if (node.type === "Literal") return node.value;
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  )
    return node.quasis[0].value.cooked;
  return null;
}

function isFunction(node) {
  return [
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
  ].includes(node.type);
}

function collectNumericGateCalls(node, source, patches) {
  walk(node, (child) => {
    if (child.type !== "CallExpression") return;
    if (child.callee?.type !== "Identifier") return;
    if (child.arguments?.length !== 1) return;

    const argVal = getLiteralValue(child.arguments[0]);
    if (!argVal || !/^\d{6,}$/.test(argVal)) return;
    if (patches.some((item) => item.start === child.start)) return;
    patches.push({
      start: child.start,
      end: child.end,
      replacement: "!1/* app_sunset_gate */",
      original: source.slice(child.start, child.end),
    });
  });
}

function collectPatches(ast, source) {
  const allPatches = [];
  const rendererNames = new Set();
  let verified = source.includes("app_sunset_gate") ? 1 : 0;

  walk(ast, (node) => {
    if (!isFunction(node)) return;

    const funcSrc = source.slice(node.start, node.end);
    if (!SUNSET_MARKERS.some((m) => funcSrc.includes(m))) return;
    if (node.type === "FunctionDeclaration" && node.id?.name) {
      rendererNames.add(node.id.name);
    }
    collectNumericGateCalls(node, source, allPatches);
  });

  // 26.707 split the gate and UI renderer into adjacent functions. Locate a
  // function that references the sunset renderer, then disable its numeric
  // Statsig gate.
  if (rendererNames.size > 0) {
    walk(ast, (node) => {
      if (!isFunction(node)) return;
      const funcSrc = source.slice(node.start, node.end);
      if (![...rendererNames].some((name) => funcSrc.includes(name))) return;
      collectNumericGateCalls(node, source, allPatches);
    });
  }

  return { patches: allPatches, verified };
}

function locateTargets(platform) {
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((name) =>
        fs.existsSync(path.join(SRC_DIR, name, "_asar", "webview", "assets")),
      );
  const targets = [];
  for (const name of platforms) {
    const assetsDir = path.join(SRC_DIR, name, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const file of fs.readdirSync(assetsDir)) {
      if (!file.endsWith(".js")) continue;
      const filePath = path.join(assetsDir, file);
      const source = fs.readFileSync(filePath, "utf8");
      if (source.includes("appSunset.title") && source.includes("defaultMessage")) {
        targets.push({ platform: name, path: filePath });
      }
    }
  }
  return targets;
}

// ──────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const bundles = locateTargets(platform);

  if (bundles.length === 0) {
    console.error("[x] No bundle containing the app sunset UI found");
    process.exit(1);
  }

  let succeeded = 0;
  for (const bundle of bundles) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    console.log(`   size: ${(source.length / 1024 / 1024).toFixed(1)} MB`);

    const t0 = Date.now();
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    console.log(`   parse: ${Date.now() - t0}ms`);

    const { patches, verified } = collectPatches(ast, source);

    if (patches.length === 0) {
      if (verified > 0) {
        console.log(`   [ok] Sunset gate already disabled (${verified} verified)`);
        succeeded++;
      } else {
        console.error("   [x] Sunset UI found, but its gate was not located");
        process.exitCode = 1;
      }
      continue;
    }

    if (isCheck) {
      console.log(`   [?] Matches: ${patches.length}`);
      for (const p of patches) {
        console.log(`     > offset ${p.start}: ${p.original} -> ${p.replacement}`);
      }
      succeeded++;
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    let code = source;
    for (const p of patches) {
      console.log(`   * offset ${p.start}: ${p.original} -> ${p.replacement}`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`   [ok] Sunset gate disabled: ${patches.length} gate calls -> !1`);
    succeeded++;
  }

  if (succeeded !== bundles.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { collectPatches };

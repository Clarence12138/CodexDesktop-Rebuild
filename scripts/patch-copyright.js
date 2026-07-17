/**
 * Post-build patch: Update copyright text
 *
 * Uses AST to locate `setAboutPanelOptions({ copyright: "(c) OpenAI" })`
 * and replace the copyright string with a custom value.
 *
 * Usage:
 *   node scripts/patch-copyright.js [platform]   # Apply to one or both macOS architectures
 *   node scripts/patch-copyright.js --check       # Dry-run: report matches
 *   node scripts/patch-copyright.js --verify      # Require applied state
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, parsePatchArgs, relPath } = require("./patch-util");

// ──────────────────────────────────────────────
//  Config
// ──────────────────────────────────────────────

const OLD_COPYRIGHT = "\u00A9 OpenAI"; // (c) OpenAI
const NEW_COPYRIGHT = "\u00A9 OpenAI \u00B7 Cometix Space"; // (c) OpenAI . Cometix Space

// ──────────────────────────────────────────────
//  AST walker
// ──────────────────────────────────────────────

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === "string") walk(item, visitor);
      }
    } else if (child && typeof child.type === "string") {
      walk(child, visitor);
    }
  }
}

// ──────────────────────────────────────────────
//  Patch rule
// ──────────────────────────────────────────────

function collectPatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    if (node.type !== "Property") return;
    const keyName =
      node.key.type === "Identifier"
        ? node.key.name
        : node.key.type === "Literal"
          ? node.key.value
          : null;
    if (keyName !== "copyright") return;

    const val = node.value;

    // Case 1: Literal string  copyright: "..."
    if (val.type === "Literal" && val.value === OLD_COPYRIGHT) {
      patches.push({
        start: val.start,
        end: val.end,
        replacement: JSON.stringify(NEW_COPYRIGHT),
        original: source.slice(val.start, val.end),
      });
      return;
    }

    // Case 2: Template literal  copyright: `...`  (no expressions, single quasi)
    if (
      val.type === "TemplateLiteral" &&
      val.expressions.length === 0 &&
      val.quasis.length === 1 &&
      val.quasis[0].value.cooked === OLD_COPYRIGHT
    ) {
      patches.push({
        start: val.start,
        end: val.end,
        replacement: "`" + NEW_COPYRIGHT + "`",
        original: source.slice(val.start, val.end),
      });
      return;
    }
  });

  // Current builds render a custom About dialog from an HTML template instead
  // of using setAboutPanelOptions(). Match the complete element to avoid
  // changing unrelated copyright strings embedded in syntax grammars.
  const oldHtml = `<div class="copyright">${OLD_COPYRIGHT}</div>`;
  const newHtml = `<div class="copyright">${NEW_COPYRIGHT}</div>`;
  let offset = source.indexOf(oldHtml);
  while (offset !== -1) {
    patches.push({
      start: offset,
      end: offset + oldHtml.length,
      replacement: newHtml,
      original: oldHtml,
    });
    offset = source.indexOf(oldHtml, offset + oldHtml.length);
  }
  return patches;
}

// ──────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────

function main() {
  const { isCheck, isVerify, platform } = parsePatchArgs(process.argv.slice(2));

  const bundles = locateBundles({
    dir: "build",
    pattern: /^main(-[^.]+)?\.js$/,
    platform,
  });

  if (bundles.length === 0) {
    console.error("[x] No main bundle found");
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

    const patches = collectPatches(ast, source);

    if (isVerify && patches.length > 0) {
      console.error(`   [x] ${patches.length} copyright targets are still patchable`);
      process.exitCode = 1;
      continue;
    }

    if (patches.length === 0) {
      // Check if already patched
      if (source.includes(NEW_COPYRIGHT)) {
        console.log("   [ok] Already patched");
        succeeded++;
      } else {
        console.error("   [x] About copyright target not found");
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
    console.log(`   [ok] Copyright updated: ${patches.length} replacements`);
    succeeded++;
  }

  if (succeeded !== bundles.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { collectPatches };

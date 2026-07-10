const { walk } = require("./patch-plugin-auth-ast");

const FEATURE_KEYS = Object.freeze([
  "browserPane",
  "inAppBrowserUse",
  "inAppBrowserUseAllowed",
  "externalBrowserUse",
  "externalBrowserUseAllowed",
  "computerUse",
  "computerUseNodeRepl",
  "control",
  "multiWindow",
]);

const REQUIRED_FEATURE_PATCH_IDS = new Set([
  ...FEATURE_KEYS.map((key) => `feature_default_${key}`),
  "feature_js_repl",
  "bundled_plugins_filter_bypass",
  "peer_auth_bypass",
]);

function propertyName(property) {
  return property.key?.name || property.key?.value;
}

function findVerifiedFeaturePatchIds(ast, source) {
  const verified = new Set();
  walk(ast, (node) => {
    if (node.type === "Property") {
      const key = propertyName(node);
      const value = source.slice(node.value.start, node.value.end);
      if (FEATURE_KEYS.includes(key) && value === "!0") {
        verified.add(`feature_default_${key}`);
      }
      if (key === "features.js_repl" && value === "!0") {
        verified.add("feature_js_repl");
      }
    }
    if (node.type === "CallExpression" && node.callee?.type === "MemberExpression") {
      if (node.callee.property?.name !== "filter" || node.arguments?.length !== 1) return;
      const callback = source.slice(node.arguments[0].start, node.arguments[0].end);
      if (callback === "()=>!0") verified.add("bundled_plugins_filter_bypass");
    }
    if (!["FunctionDeclaration", "FunctionExpression"].includes(node.type)) return;
    const functionSource = source.slice(node.start, node.end);
    if (!functionSource.includes("shouldIncludeBrowserUsePeerAuthorization")) return;
    walk(node, (inner) => {
      if (
        inner.type === "IfStatement" &&
        source.slice(inner.test.start, inner.test.end) === "!0"
      ) {
        verified.add("peer_auth_bypass");
      }
    });
  });
  return verified;
}

function findDefaultValuePatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    if (node.type !== "ObjectExpression") return;
    const properties = node.properties ?? [];
    const keys = properties.map(propertyName);
    if (FEATURE_KEYS.filter((key) => keys.includes(key)).length < 3) return;
    for (const property of properties) {
      const name = propertyName(property);
      const value = source.slice(property.value.start, property.value.end);
      if (!FEATURE_KEYS.includes(name) || value !== "!1") continue;
      patches.push({
        id: `feature_default_${name}`,
        start: property.value.start,
        end: property.value.end,
        replacement: "!0",
        original: value,
      });
    }
  });
  return patches;
}

function findJavaScriptReplPatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    if (node.type !== "ObjectExpression" || node.properties?.length !== 1) return;
    const property = node.properties[0];
    if (propertyName(property) !== "features.js_repl") return;
    const value = source.slice(property.value.start, property.value.end);
    if (value !== "!1") return;
    patches.push({
      id: "feature_js_repl",
      start: property.value.start,
      end: property.value.end,
      replacement: "!0",
      original: value,
    });
  });
  return patches;
}

function findBundledPluginFilterPatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    if (node.type !== "CallExpression" || node.callee?.type !== "MemberExpression") return;
    if (node.callee.property?.name !== "filter" || node.arguments?.length !== 1) return;
    const callback = node.arguments[0];
    if (callback.type !== "ArrowFunctionExpression") return;
    const callbackSource = source.slice(callback.start, callback.end);
    if (!callbackSource.includes("isAvailable") || !callbackSource.includes("features")) return;
    patches.push({
      id: "bundled_plugins_filter_bypass",
      start: callback.start,
      end: callback.end,
      replacement: "()=>!0",
      original: `${callbackSource.slice(0, 40)}...`,
    });
  });
  return patches;
}

function findPeerAuthorizationPatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    if (!["FunctionDeclaration", "FunctionExpression"].includes(node.type)) return;
    if (!source.slice(node.start, node.end).includes("shouldIncludeBrowserUsePeerAuthorization")) {
      return;
    }
    walk(node, (inner) => {
      if (inner.type !== "IfStatement") return;
      const returned = inner.consequent?.type === "ReturnStatement"
        ? inner.consequent.argument
        : null;
      if (returned?.type !== "ArrowFunctionExpression") return;
      const properties = returned.body?.type === "ObjectExpression"
        ? returned.body.properties
        : [];
      const authorized = properties.find((property) => propertyName(property) === "authorized");
      const hasReason = properties.some((property) => propertyName(property) === "reason");
      if (!authorized || hasReason) return;
      if (source.slice(authorized.value.start, authorized.value.end) !== "!0") return;
      const testSource = source.slice(inner.test.start, inner.test.end);
      if (testSource === "!0" || testSource.includes("platform")) return;
      patches.push({
        id: "peer_auth_bypass",
        start: inner.test.start,
        end: inner.test.end,
        replacement: "!0",
        original: testSource,
      });
    });
  });
  return patches;
}

function findFeatureDefaultPatches(ast, source) {
  return [
    ...findDefaultValuePatches(ast, source),
    ...findJavaScriptReplPatches(ast, source),
    ...findBundledPluginFilterPatches(ast, source),
    ...findPeerAuthorizationPatches(ast, source),
  ];
}

module.exports = {
  FEATURE_KEYS,
  REQUIRED_FEATURE_PATCH_IDS,
  findFeatureDefaultPatches,
  findVerifiedFeaturePatchIds,
};

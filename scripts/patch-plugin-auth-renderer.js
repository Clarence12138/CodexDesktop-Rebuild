const { getLiteralValue, walk } = require("./patch-plugin-auth-ast");

const FEATURE_CONTEXTS = new Set([
  "browser_use",
  "computer_use",
  "browser_use_external",
]);

function isFunction(node) {
  return ["FunctionDeclaration", "FunctionExpression"].includes(node.type);
}

function findPluginAuthPatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    if (!isFunction(node)) return;
    const statements = node.body?.type === "BlockStatement" ? node.body.body : [];
    if (statements.length !== 1) return;
    const argument = statements[0].type === "ReturnStatement"
      ? statements[0].argument
      : null;
    if (argument?.type !== "BinaryExpression" || argument.operator !== "!==") return;
    if (
      getLiteralValue(argument.left) !== "chatgpt" &&
      getLiteralValue(argument.right) !== "chatgpt"
    ) return;
    patches.push({
      id: "plugin_auth_gate",
      start: argument.start,
      end: argument.end,
      replacement: "!1",
      original: source.slice(argument.start, argument.end),
    });
  });
  return patches;
}

function findGoalGatePatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    if (node.type !== "LogicalExpression" || node.operator !== "&&") return;
    const fullSource = source.slice(node.start, node.end);
    if (!/[`"]goals[`"]/.test(fullSource)) return;
    if (!/[`"]cloud[`"]/.test(fullSource)) return;
    let hasGateCall = false;
    walk(node, (inner) => {
      if (inner.type !== "CallExpression") return;
      if (inner.callee?.type !== "Identifier" || inner.arguments?.length !== 1) return;
      const value = getLiteralValue(inner.arguments[0]);
      if (value && /^\d{6,}$/.test(value)) hasGateCall = true;
    });
    if (!hasGateCall) return;
    const rightSource = source.slice(node.right.start, node.right.end);
    if (!rightSource.includes("cloud") || fullSource === rightSource) return;
    patches.push({
      id: "goal_gate_bypass",
      start: node.start,
      end: node.end,
      replacement: rightSource,
      original: `${fullSource.slice(0, 50)}...`,
    });
  });
  return patches;
}

function findBrowserAvailPatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    if (!isFunction(node)) return;
    const functionSource = source.slice(node.start, node.end);
    if (![...FEATURE_CONTEXTS].some((name) => functionSource.includes(`\`${name}\``))) {
      return;
    }
    walk(node, (inner) => {
      if (inner.type !== "ObjectExpression") return;
      const properties = inner.properties ?? [];
      const keys = properties.map((property) => property.key?.name || property.key?.value);
      if (!keys.includes("available") || !keys.includes("isLoading")) return;
      for (const property of properties) {
        const name = property.key?.name || property.key?.value;
        if (!["allowed", "available"].includes(name)) continue;
        const value = source.slice(property.value.start, property.value.end);
        if (value === "!0") continue;
        patches.push({
          id: `browser_use_${name}`,
          start: property.value.start,
          end: property.value.end,
          replacement: "!0",
          original: value,
        });
      }
    });
  });
  return patches;
}

function findStatsigGatePatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    if (!isFunction(node)) return;
    const functionSource = source.slice(node.start, node.end);
    const hasFeature = [...FEATURE_CONTEXTS].some((name) =>
      functionSource.includes(`\`${name}\``) || functionSource.includes(`"${name}"`),
    );
    if (!hasFeature) return;
    walk(node, (inner) => {
      if (inner.type !== "CallExpression") return;
      if (inner.callee?.type !== "Identifier" || inner.arguments?.length !== 1) return;
      const value = getLiteralValue(inner.arguments[0]);
      if (!value || !/^\d{6,}$/.test(value)) return;
      patches.push({
        id: `statsig_gate_${value}`,
        start: inner.start,
        end: inner.end,
        replacement: "!0",
        original: source.slice(inner.start, inner.end),
      });
    });
  });
  return patches;
}

module.exports = {
  findBrowserAvailPatches,
  findGoalGatePatches,
  findPluginAuthPatches,
  findStatsigGatePatches,
};

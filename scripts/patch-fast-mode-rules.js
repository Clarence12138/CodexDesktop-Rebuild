const REQUIRED_PATCH_IDS = new Set([
  "fast_mode_renderer_availability",
  "fast_mode_request_availability",
  "fast_mode_composer_selection",
  "fast_mode_composer_fast_value",
  "fast_mode_composer_icon",
  "fast_mode_composer_visibility",
  "fast_mode_composer_options",
  "fast_mode_trigger_indicator",
]);

const API_KEY = "apikey";
const CHATGPT = "chatgpt";
const FAST_TIER = "priority";

function walk(node, visitor, parent = null) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent);
  for (const key of Object.keys(node)) {
    if (["type", "start", "end"].includes(key)) continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) if (item?.type) walk(item, visitor, node);
    } else if (child?.type) {
      walk(child, visitor, node);
    }
  }
}

function isFunction(node) {
  return ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
    node.type,
  );
}

function sourceFor(source, node) {
  return source.slice(node.start, node.end);
}

function literalValue(node) {
  if (node?.type === "Literal") return node.value;
  if (node?.type !== "TemplateLiteral" || node.expressions.length > 0) return null;
  return node.quasis.length === 1 ? node.quasis[0].value.cooked : null;
}

function propertyName(node) {
  return node?.property?.name ?? node?.property?.value ?? null;
}

function addPatch(result, patch) {
  if (!result.patches.some((candidate) => candidate.start === patch.start)) {
    result.patches.push(patch);
  }
}

function findAuthExpression(node, source) {
  let result = null;
  walk(node, (child) => {
    if (result || child.type !== "MemberExpression") return;
    if (propertyName(child) === "authMethod") result = sourceFor(source, child);
  });
  return result;
}

function collectRendererAvailability(fn, source, result) {
  const functionSource = sourceFor(source, fn);
  const id = "fast_mode_renderer_availability";
  if (!functionSource.includes("isServiceTierAllowed") || !functionSource.includes("fast_mode")) return;
  if (functionSource.includes(id)) return void result.verified.add(id);
  const auth = findAuthExpression(fn, source);
  if (!auth) return;
  walk(fn, (node) => {
    if (node.type !== "VariableDeclarator" || !node.init) return;
    const original = sourceFor(source, node.init);
    if (!original.includes("featureRequirements") || !original.includes("fast_mode")) return;
    addPatch(result, {
      id,
      start: node.init.start,
      end: node.init.end,
      original,
      replacement: `(${auth}===\`${API_KEY}\`||(${original}))/* ${id} */`,
    });
  });
}

function chatGptOperand(node, source) {
  if (node?.type !== "BinaryExpression" || node.operator !== "!==") return null;
  if (literalValue(node.left) === CHATGPT) return sourceFor(source, node.right);
  if (literalValue(node.right) === CHATGPT) return sourceFor(source, node.left);
  return null;
}

function returnsFalse(node, source) {
  return node?.type === "ReturnStatement" &&
    (sourceFor(source, node.argument) === "!1" || literalValue(node.argument) === false);
}

function collectRequestAvailability(fn, source, result) {
  const functionSource = sourceFor(source, fn);
  const id = "fast_mode_request_availability";
  if (
    functionSource.includes("isServiceTierAllowed") ||
    !functionSource.includes("authMethod") ||
    !functionSource.includes("fast_mode")
  ) return;
  if (functionSource.includes(id)) return void result.verified.add(id);
  walk(fn, (node) => {
    if (node.type !== "IfStatement" || !returnsFalse(node.consequent, source)) return;
    const operand = chatGptOperand(node.test, source);
    if (!operand) return;
    addPatch(result, {
      id,
      start: node.start,
      end: node.end,
      original: sourceFor(source, node),
      replacement:
        `if(${operand}===\`${API_KEY}\`)return!0;/* ${id} */` +
        `if(${sourceFor(source, node.test)})return!1;`,
    });
  });
}

function findVariable(fn, source, predicate) {
  let result = null;
  walk(fn, (node) => {
    if (result || node.type !== "VariableDeclarator" || !node.init) return;
    const initSource = sourceFor(source, node.init);
    if (predicate(node.init, initSource)) {
      result = { id: sourceFor(source, node.id), init: node.init, source: initSource };
    }
  });
  return result;
}

function findProperty(fn, keyName) {
  let result = null;
  walk(fn, (node) => {
    if (result || node.type !== "Property") return;
    const key = node.key?.name ?? node.key?.value;
    if (key === keyName) result = node;
  });
  return result;
}

function patchVariable(result, variable, id, replacement) {
  if (!variable) return;
  addPatch(result, {
    id,
    start: variable.init.start,
    end: variable.init.end,
    original: variable.source,
    replacement: `${replacement}/* ${id} */`,
  });
}

function fastOptionSource() {
  return [
    `{description:\`1.5x speed, increased usage\`,iconKind:\`fast\`,`,
    `label:\`Fast\`,tier:{id:\`${FAST_TIER}\`,name:\`Fast\`},value:\`${FAST_TIER}\`}`,
  ].join("");
}

function collectComposerFallbacks(fn, source, result) {
  const functionSource = sourceFor(source, fn);
  if (
    !functionSource.includes("composer.toggleFastMode") ||
    !functionSource.includes("showFastServiceTierIndicator")
  ) return;
  for (const id of REQUIRED_PATCH_IDS) {
    if (functionSource.includes(id)) result.verified.add(id);
  }
  const auth = findAuthExpression(fn, source);
  if (!auth) return;
  const selected = findVariable(fn, source, (node) =>
    node.type === "MemberExpression" && propertyName(node) === "selectedServiceTier",
  );
  const settings = selected?.init?.object ? sourceFor(source, selected.init.object) : null;
  const fastValue = findVariable(fn, source, (_node, text) =>
    text.includes("availableOptions.find") && text.includes("iconKind") && text.includes("fast"),
  );
  const icon = findVariable(fn, source, (_node, text) =>
    text.includes("?.iconKind") && text.includes("??null"),
  );
  const visible = findVariable(fn, source, (_node, text) =>
    text.includes("availableOptions.length>1"),
  );

  if (!functionSource.includes("fast_mode_composer_selection") && selected && settings) {
    patchVariable(
      result,
      selected,
      "fast_mode_composer_selection",
      `(${selected.source}??(${auth}===\`${API_KEY}\`?${settings}.serviceTierForRequest:null))`,
    );
  }
  if (!functionSource.includes("fast_mode_composer_fast_value") && fastValue) {
    patchVariable(
      result,
      fastValue,
      "fast_mode_composer_fast_value",
      `(${fastValue.source}??(${auth}===\`${API_KEY}\`?\`${FAST_TIER}\`:void 0))`,
    );
  }
  if (!functionSource.includes("fast_mode_composer_icon") && icon && selected && fastValue) {
    patchVariable(
      result,
      icon,
      "fast_mode_composer_icon",
      `(${icon.source}??(${auth}===\`${API_KEY}\`&&${selected.id}===${fastValue.id}?\`fast\`:null))`,
    );
  }
  if (!functionSource.includes("fast_mode_composer_visibility") && visible) {
    patchVariable(
      result,
      visible,
      "fast_mode_composer_visibility",
      `(${visible.source}||${auth}===\`${API_KEY}\`)`,
    );
  }
  collectComposerOptions(fn, source, result, auth, settings);
  collectTriggerIndicator(fn, source, result, auth, selected, fastValue);
}

function collectComposerOptions(fn, source, result, auth, settings) {
  const id = "fast_mode_composer_options";
  if (!settings || sourceFor(source, fn).includes(id)) return;
  const property = findProperty(fn, "serviceTierOptions");
  if (property?.value?.type !== "ConditionalExpression") return;
  const condition = sourceFor(source, property.value.test);
  const options = `${settings}.availableOptions`;
  const replacement = [
    `${condition}?(${options}.length>1?${options}:`,
    `${auth}===\`${API_KEY}\`?[...${options},${fastOptionSource()}]:${options}):[]`,
    `/* ${id} */`,
  ].join("");
  addPatch(result, {
    id,
    start: property.value.start,
    end: property.value.end,
    original: sourceFor(source, property.value),
    replacement,
  });
}

function findIndicatorExpression(fn, selectedTier, source) {
  let result = null;
  walk(fn, (node) => {
    if (result || node.type !== "LogicalExpression" || node.operator !== "&&") return;
    if (node.right?.type !== "CallExpression" || node.right.arguments?.length !== 2) return;
    if (sourceFor(source, node.right.arguments[1]) !== selectedTier) return;
    if (sourceFor(source, node.left).includes("!=null")) result = node;
  });
  return result;
}

function collectTriggerIndicator(fn, source, result, auth, selected, fastValue) {
  const id = "fast_mode_trigger_indicator";
  if (sourceFor(source, fn).includes(id) || !selected || !fastValue) return;
  const indicator = findIndicatorExpression(fn, selected.id, source);
  if (!indicator) return;
  const original = sourceFor(source, indicator);
  addPatch(result, {
    id,
    start: indicator.start,
    end: indicator.end,
    original,
    replacement:
      `(${original}||${auth}===\`${API_KEY}\`&&${selected.id}===${fastValue.id})/* ${id} */`,
  });
}

function collectFastModePatches(ast, source) {
  const result = { patches: [], verified: new Set() };
  walk(ast, (node) => {
    if (!isFunction(node)) return;
    collectRendererAvailability(node, source, result);
    collectRequestAvailability(node, source, result);
    collectComposerFallbacks(node, source, result);
  });
  return result;
}

module.exports = { REQUIRED_PATCH_IDS, collectFastModePatches };

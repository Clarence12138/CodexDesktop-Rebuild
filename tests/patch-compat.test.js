const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { parse } = require("acorn");

const fastMode = require("../scripts/patch-fast-mode-rules");
const copyright = require("../scripts/patch-copyright");
const sunset = require("../scripts/patch-sunset");
const updater = require("../scripts/patch-updater");
const archiveDelete = require("../scripts/patch-archive-delete");
const pluginAuth = require("../scripts/patch-plugin-auth");
const pluginRenderer = require("../scripts/patch-plugin-auth-renderer");

function parseModule(source) {
  return parse(source, { ecmaVersion: "latest", sourceType: "module" });
}

function applyPatches(source, patches) {
  let result = source;
  for (const patch of [...patches].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, patch.start) + patch.replacement + result.slice(patch.end);
  }
  return result;
}

test("fast mode requires renderer, request, model-tier, and indicator capabilities", () => {
  const source = [
    "function renderer(host){let info=host.info,a=info?.authMethod===`chatgpt`,data=load(),allowed=a&&data!=null&&data.requirements.featureRequirements.fast_mode!==!1;return{isServiceTierAllowed:allowed}}",
    "async function request(auth){if(auth!==`chatgpt`)return!1;let data=await load();cache.setData(key,{authMethod:auth});return data.requirements.featureRequirements.fast_mode!==!1}",
    "function settings(data,opts,host,tier){let selected=choose(data?.models,opts.model),auth=get(host)?.authMethod??null,options=build(selected),selectedTier=tier==null?null:normalize(selected,tier),requestTier=tier;return{availableOptions:options,selectedServiceTier:selectedTier,serviceTierForRequest:requestTier,serviceTierSettings:{}}}",
    "function composer(settings,host,model,kind,allowed){let auth=get(host),isCopilot=auth?.authMethod===`copilot`,selected=settings.selectedServiceTier,selectedOption=settings.availableOptions.find(e=>e.value===selected),fastTier=settings.availableOptions.find(e=>e.iconKind===`fast`)?.value,icon=selectedOption?.iconKind??null,indicator=kind!=null&&supports(model,selected),visible=allowed&&settings.availableOptions.length>1;command(`composer.toggleFastMode`);return Menu({selectedServiceTier:selected,selectedServiceTierIconKind:icon,serviceTierOptions:visible?settings.availableOptions:[],onSelectServiceTier:visible?setTier:void 0,showFastServiceTierIndicator:indicator,isCopilot})}",
  ].join(";");
  const first = fastMode.collectFastModePatches(parseModule(source), source);

  assert.deepEqual(new Set(first.patches.map((patch) => patch.id)), fastMode.REQUIRED_PATCH_IDS);
  const patched = applyPatches(source, first.patches);
  const second = fastMode.collectFastModePatches(parseModule(patched), patched);
  assert.equal(second.patches.length, 0);
  assert.deepEqual(second.verified, fastMode.REQUIRED_PATCH_IDS);
});

test("fast mode composer fallback is API-key-only and keeps shared settings unchanged", () => {
  const source = "function composer(settings,host,model,kind,allowed){let auth=get(host),isCopilot=auth?.authMethod===`copilot`,selected=settings.selectedServiceTier,selectedOption=settings.availableOptions.find(e=>e.value===selected),fastTier=settings.availableOptions.find(e=>e.iconKind===`fast`)?.value,icon=selectedOption?.iconKind??null,indicator=kind!=null&&supports(model,selected),visible=allowed&&settings.availableOptions.length>1;command(`composer.toggleFastMode`);return Menu({selectedServiceTier:selected,selectedServiceTierIconKind:icon,serviceTierOptions:visible?settings.availableOptions:[],onSelectServiceTier:visible?setTier:void 0,showFastServiceTierIndicator:indicator,isCopilot})}";
  const result = fastMode.collectFastModePatches(parseModule(source), source);
  const patched = applyPatches(source, result.patches);
  const create = new Function(
    "get", "supports", "command", "Menu", "setTier", `${patched};return composer`,
  );
  const Menu = (props) => props;
  const standardOnly = {
    availableOptions: [{ value: null, iconKind: null }],
    selectedServiceTier: null,
    serviceTierForRequest: "priority",
  };
  const apiKeyComposer = create(
    () => ({ authMethod: "apikey" }), () => false, () => {}, Menu, () => {},
  );
  const apiKey = apiKeyComposer(standardOnly, "local", null, null, true);
  assert.deepEqual(apiKey.serviceTierOptions.map((option) => option.value), [null, "priority"]);
  assert.equal(apiKey.selectedServiceTier, "priority");
  assert.equal(apiKey.selectedServiceTierIconKind, "fast");
  assert.equal(apiKey.showFastServiceTierIndicator, true);
  assert.deepEqual(standardOnly.availableOptions.map((option) => option.value), [null]);

  const chatGptComposer = create(
    () => ({ authMethod: "chatgpt" }), () => false, () => {}, Menu, () => {},
  );
  const chatGpt = chatGptComposer(standardOnly, "local", null, null, false);
  assert.deepEqual(chatGpt.serviceTierOptions, []);
  assert.equal(chatGpt.selectedServiceTier, null);
});

test("fast mode API key bypasses missing requirements while ChatGPT preserves them", async () => {
  const source = [
    "function renderer(host){let info=host.info,a=info?.authMethod===`chatgpt`,data=load(),allowed=a&&data!=null&&data.requirements.featureRequirements.fast_mode!==!1;return{isServiceTierAllowed:allowed}}",
    "async function request(auth){if(auth!==`chatgpt`)return!1;let data=await load();cache.setData(key,{authMethod:auth});return data.requirements.featureRequirements.fast_mode!==!1}",
  ].join(";");
  const result = fastMode.collectFastModePatches(parseModule(source), source);
  const patched = applyPatches(source, result.patches);
  const create = new Function("load", "cache", "key", `${patched};return{renderer,request}`);
  const cache = { setData() {} };

  const apiKey = create(() => null, cache, "key");
  assert.equal(apiKey.renderer({ info: { authMethod: "apikey" } }).isServiceTierAllowed, true);
  assert.equal(await apiKey.request("apikey"), true);

  const chatGpt = create(
    () => ({ requirements: { featureRequirements: { fast_mode: false } } }),
    cache,
    "key",
  );
  assert.equal(chatGpt.renderer({ info: { authMethod: "chatgpt" } }).isServiceTierAllowed, false);
  assert.equal(await chatGpt.request("chatgpt"), false);
});

test("copyright patches only the About dialog HTML element", () => {
  const source = "const html=`<div class=\"copyright\">© OpenAI</div>`; const other='© OpenAI'";
  const patches = copyright.collectPatches(parseModule(source), source);

  assert.equal(patches.length, 1);
  assert.match(applyPatches(source, patches), /© OpenAI · Cometix Space/);
});

test("sunset locates a gate separated from its renderer", () => {
  const source = [
    "function Sunset(){return {id:`appSunset.title`,defaultMessage:`Update required`}}",
    "function Boundary(){if(gate(`2929582856`))return jsx(Sunset,{})}",
  ].join(";");
  const first = sunset.collectPatches(parseModule(source), source);

  assert.equal(first.patches.length, 1);
  const patched = applyPatches(source, first.patches);
  const second = sunset.collectPatches(parseModule(patched), patched);
  assert.equal(second.patches.length, 0);
  assert.equal(second.verified, 1);
});

test("updater reports patchable and already-disabled methods", () => {
  const source = [
    "const methods={",
    "shouldIncludeSparkle:function(){return true},",
    "shouldIncludeUpdater:function(){return !1}",
    "}",
  ].join("");
  const result = updater.collectPatches(parseModule(source), source);

  assert.equal(result.patches.length, 1);
  assert.equal(result.verified, 1);
  assert.deepEqual(result.verifiedIds, new Set(["shouldIncludeUpdater"]));
});

test("archive delete validation requires each capability group in one bundle", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-delete-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const asar = path.join(root, "mac-arm64", "_asar");
  const assets = path.join(asar, "webview", "assets");
  const build = path.join(asar, ".vite", "build");
  fs.mkdirSync(assets, { recursive: true });
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(
    path.join(assets, "route.js"),
    "delete-archived-conversation delete-all-archived-conversations",
  );
  fs.writeFileSync(
    path.join(assets, "data-controls.js"),
    "settings.dataControls.archivedChats.delete settings.dataControls.archivedChats.deleteAll onDelete",
  );
  fs.writeFileSync(
    path.join(build, "main.js"),
    "delete-archived-thread delete-all-archived-threads thread/delete",
  );

  const result = archiveDelete.validatePlatform("mac-arm64", root);
  assert.ok(result.route["delete-archived-conversation"]);
  assert.ok(result.ui["settings.dataControls.archivedChats.deleteAll"]);

  fs.writeFileSync(path.join(assets, "data-controls.js"), "onDelete");
  assert.throws(
    () => archiveDelete.validatePlatform("mac-arm64", root),
    /native archive delete incomplete/,
  );
});

test("plugin verification reports each required capability explicitly", () => {
  const featureProperties = [
    "browserPane", "inAppBrowserUse", "inAppBrowserUseAllowed",
    "externalBrowserUse", "externalBrowserUseAllowed", "computerUse",
    "computerUseNodeRepl", "control", "multiWindow",
  ].map((key) => `${key}:!0`).join(",");
  const source = [
    `const defaults={${featureProperties},\"features.js_repl\":!0}`,
    "const plugins=list.filter(()=>!0)",
    "function peer(){if(!0)return()=>({authorized:!0});shouldIncludeBrowserUsePeerAuthorization()}",
  ].join(";");
  const verified = pluginAuth.findVerifiedFeaturePatchIds(parseModule(source), source);

  assert.deepEqual(
    [...pluginAuth.REQUIRED_FEATURE_PATCH_IDS].filter((id) => !verified.has(id)),
    [],
  );
});

test("plugin renderer replacements remain explicitly verifiable", () => {
  const source = [
    "function availability(){const context=`browser_use`;return{allowed:gate(),available:gate(),isLoading:false}}",
    "function statsig(){const context=`computer_use`;return check(`1506311413`)}",
  ].join(";");
  const ast = parseModule(source);
  const patches = [
    ...pluginRenderer.findBrowserAvailPatches(ast, source),
    ...pluginRenderer.findStatsigGatePatches(ast, source),
  ];
  const patched = applyPatches(source, patches);
  const verified = pluginRenderer.findVerifiedRendererPatchIds(patched);

  assert.deepEqual(
    [...pluginRenderer.REQUIRED_RENDERER_PATCH_IDS].filter((id) => !verified.has(id)),
    [],
  );
  assert.ok([...verified].some((id) => id.startsWith("statsig_gate_")));
});

test("plugin renderer target discovery scans feature context regardless of chunk size", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-renderer-target-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "large-hashed-chunk.js");
  fs.writeFileSync(file, `const context=\`browser_use\`;${" ".repeat(12000)}`);

  const targets = pluginAuth.findRendererTargets("mac-arm64", root);

  assert.deepEqual(targets, [
    { platform: "mac-arm64", path: file, rules: ["avail", "gate"] },
  ]);
});

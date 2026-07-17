const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const asar = require("@electron/asar");

const { findAppBundle, packAsar } = require("../scripts/build-common");
const { parsePlatform } = require("../scripts/build-from-upstream");
const { parsePatchArgs } = require("../scripts/patch-util");
const { parseArgs, selectedPlatforms, syncArgs } = require("../scripts/rebuild");

const projectRoot = path.join(__dirname, "..");
const buildMacSource = fs.readFileSync(path.join(projectRoot, "scripts/build-mac.js"), "utf8");
const buildCommonSource = fs.readFileSync(path.join(projectRoot, "scripts/build-common.js"), "utf8");
const rebuildSource = fs.readFileSync(path.join(projectRoot, "scripts/rebuild.js"), "utf8");
const manualWorkflowSource = fs.readFileSync(path.join(projectRoot, ".github/workflows/build.yml"), "utf8");
const releaseWorkflowSource = fs.readFileSync(path.join(projectRoot, ".github/workflows/sync.yml"), "utf8");
const packageJson = require("../package.json");

test("findAppBundle accepts ChatGPT.app and ignores unrelated app directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-locator-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  fs.mkdirSync(path.join(root, "Other.app", "Contents", "Resources"), { recursive: true });
  const expected = path.join(root, "nested", "ChatGPT.app");
  fs.mkdirSync(path.join(expected, "Contents", "Resources"), { recursive: true });
  fs.writeFileSync(path.join(expected, "Contents", "Resources", "app.asar"), "fixture");

  assert.equal(findAppBundle(root), expected);
  assert.equal(findAppBundle(expected), expected);
});

test("build platform parsing only accepts macOS architectures", () => {
  assert.equal(parsePlatform(["--platform", "mac-arm64"]), "mac-arm64");
  assert.equal(parsePlatform(["--platform", "mac-x64"]), "mac-x64");
  assert.throws(() => parsePlatform(["--platform", "win"]), /Usage/);
  assert.throws(() => parsePlatform(["--platform", "linux-x64"]), /Usage/);
});

test("rebuild selects both macOS architectures and forwards sync options", () => {
  assert.deepEqual(selectedPlatforms("mac"), ["mac-arm64", "mac-x64"]);
  assert.deepEqual(
    syncArgs({ force: true, localMacApp: "/Applications/Codex.app" }),
    ["--force", "--local-mac-app", "/Applications/Codex.app"],
  );
  assert.deepEqual(
    syncArgs({ force: false, localMacApp: null, platform: "mac-x64" }),
    ["--mac-platform", "mac-x64"],
  );
});

test("local App rebuild requires one architecture", () => {
  assert.deepEqual(
    parseArgs(["--platform", "mac-arm64", "--local-mac-app", "/Applications/Codex.app"]),
    { force: false, localMacApp: "/Applications/Codex.app", platform: "mac-arm64" },
  );
  assert.throws(
    () => parseArgs(["--platform", "mac", "--local-mac-app", "/Applications/Codex.app"]),
    /single-architecture/,
  );
});

test("macOS builds preserve the upstream Codex core", () => {
  assert.doesNotMatch(buildMacSource, /replaceCodex/);
  assert.match(buildMacSource, /preserved upstream binary/);
});

test("native ASAR packing invokes the locked CLI through Node", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-asar-pack-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "fixture.asar");
  fs.mkdirSync(path.join(source, "nested"), { recursive: true });
  fs.writeFileSync(path.join(source, "nested", "fixture.txt"), "packed by locked CLI");

  packAsar({ source, destination, cwd: root });

  assert.equal(
    asar.extractFile(destination, "nested/fixture.txt").toString("utf8"),
    "packed by locked CLI",
  );
  assert.doesNotMatch(buildMacSource, /exec\("npx", \["asar"/);
  assert.match(buildCommonSource, /execFileSync\(process\.execPath/);
});

test("native ASAR packing preserves unpacked module directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-asar-unpack-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const source = path.join(root, "source");
  const nativeDir = path.join(source, "node_modules", "native-addon");
  const secondNativeDir = path.join(source, "node_modules", "second-native-addon");
  const destination = path.join(root, "fixture.asar");
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.mkdirSync(secondNativeDir, { recursive: true });
  fs.writeFileSync(path.join(nativeDir, "addon.node"), "native");
  fs.writeFileSync(path.join(nativeDir, "helper"), "companion");
  fs.writeFileSync(path.join(secondNativeDir, "second.node"), "native");

  packAsar({
    source,
    destination,
    cwd: root,
    unpackDirectories: [
      "node_modules/native-addon",
      "node_modules/second-native-addon",
    ],
  });

  for (const relativePath of [
    "node_modules/native-addon/addon.node",
    "node_modules/native-addon/helper",
    "node_modules/second-native-addon/second.node",
  ]) {
    assert.equal(asar.statFile(destination, relativePath).unpacked, true);
    assert.equal(fs.existsSync(path.join(`${destination}.unpacked`, relativePath)), true);
  }
});

test("patch argument parsing rejects retired or unknown targets", () => {
  assert.deepEqual(parsePatchArgs(["mac-arm64", "--verify"]), {
    isCheck: false,
    isVerify: true,
    platform: "mac-arm64",
  });
  assert.throws(() => parsePatchArgs(["win"]), /Unknown argument/);
  assert.throws(() => parsePatchArgs(["unix"]), /Unknown argument/);
  assert.throws(() => parsePatchArgs(["mac-arm64", "mac-x64"]), /Multiple/);
  assert.throws(() => parsePatchArgs(["--check", "--verify"]), /mutually exclusive/);
});

test("package scripts and workflows publish macOS DMGs only", () => {
  for (const scriptName of Object.keys(packageJson.scripts)) {
    assert.doesNotMatch(scriptName, /win|linux|forge/);
  }
  assert.match(manualWorkflowSource, /arch: \[x64, arm64\]/);
  assert.match(releaseWorkflowSource, /Codex-macOS-x64/);
  assert.match(releaseWorkflowSource, /Codex-macOS-arm64/);
  assert.match(releaseWorkflowSource, /files: artifacts\/\*\*\/\*\.dmg/);
  assert.match(releaseWorkflowSource, /macos-arm64-v\$\{MAC_ARM64\}-x64-v\$\{MAC_X64\}/);
  assert.doesNotMatch(manualWorkflowSource, /build-windows|build-linux|windows-latest/);
  assert.doesNotMatch(releaseWorkflowSource, /Windows|Linux|\.zip|\.deb|\.rpm/);
});

test("rebuild and CI strictly verify patches before packaging", () => {
  assert.match(rebuildSource, /patch-all\.js", \[platform, "--verify"\]/);
  assert.doesNotMatch(rebuildSource, /patch-all\.js", \[platform, "--check"\]/);
  assert.match(manualWorkflowSource, /patch-all\.js mac-\$\{\{ matrix\.arch \}\} --verify/);
  assert.match(releaseWorkflowSource, /patch-all\.js mac-\$\{\{ matrix\.arch \}\} --verify/);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const asar = require("@electron/asar");

const {
  findAppBundle,
  packAsar,
  readPeMachine,
  updateWindowsAsarIntegrity,
  verifyPeX64,
} = require("../scripts/build-common");
const { parsePlatform } = require("../scripts/build-from-upstream");
const { resolveLinuxMain } = require("../scripts/prepare-src");
const { parseArgs, selectedPlatforms, syncArgs } = require("../scripts/rebuild");

const buildMacSource = fs.readFileSync(
  path.join(__dirname, "../scripts/build-mac.js"),
  "utf8",
);
const buildCommonSource = fs.readFileSync(
  path.join(__dirname, "../scripts/build-common.js"),
  "utf8",
);
const buildWinSource = fs.readFileSync(
  path.join(__dirname, "../scripts/build-win.js"),
  "utf8",
);
const rebuildSource = fs.readFileSync(
  path.join(__dirname, "../scripts/rebuild.js"),
  "utf8",
);
const manualWorkflowSource = fs.readFileSync(
  path.join(__dirname, "../.github/workflows/build.yml"),
  "utf8",
);
const releaseWorkflowSource = fs.readFileSync(
  path.join(__dirname, "../.github/workflows/sync.yml"),
  "utf8",
);
const windowsSmokeSource = fs.readFileSync(
  path.join(__dirname, "../scripts/smoke-windows.ps1"),
  "utf8",
);

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

test("build platform parsing is strict", () => {
  assert.equal(parsePlatform(["--platform", "mac-arm64"]), "mac-arm64");
  assert.throws(() => parsePlatform(["--platform", "linux-x64"]), /Usage/);
});

test("rebuild selects both mac architectures and forwards explicit sync options", () => {
  assert.deepEqual(selectedPlatforms("mac"), ["mac-arm64", "mac-x64"]);
  assert.deepEqual(
    syncArgs({ force: true, localMacApp: "/Applications/Codex.app" }),
    ["--skip-win", "--force", "--local-mac-app", "/Applications/Codex.app"],
  );
  assert.deepEqual(
    syncArgs({ force: false, localMacApp: null, platform: "mac-x64" }),
    ["--skip-win", "--mac-platform", "mac-x64"],
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

test("native desktop builds preserve the upstream Codex core", () => {
  assert.doesNotMatch(buildMacSource, /replaceCodex/);
  assert.doesNotMatch(buildWinSource, /replaceCodex/);
  assert.match(buildMacSource, /preserved upstream binary/);
  assert.match(buildWinSource, /preserved upstream binary/);
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
  assert.doesNotMatch(buildWinSource, /execFileSync\("npx", \["asar"/);
  assert.match(buildCommonSource, /execFileSync\(process\.execPath/);
});

test("Linux workflows preserve bundled cross-architecture binaries in RPMs", () => {
  assert.match(manualWorkflowSource, /%__strip \/bin\/true/);
  assert.match(releaseWorkflowSource, /%__strip \/bin\/true/);
});

test("Windows workflows compare upstream and packaged smoke results with logs", () => {
  assert.match(manualWorkflowSource, /scripts\/smoke-windows\.ps1/);
  assert.match(releaseWorkflowSource, /scripts\/smoke-windows\.ps1/);
  assert.match(windowsSmokeSource, /ELECTRON_ENABLE_LOGGING/);
  assert.match(windowsSmokeSource, /Both upstream and packaged apps exited/);
  assert.match(windowsSmokeSource, /Packaged app exited while the upstream baseline stayed alive/);
});

test("rebuild requires strict applied-patch verification before packaging", () => {
  assert.match(rebuildSource, /patch-all\.js", \[platform, "--verify"\]/);
  assert.doesNotMatch(rebuildSource, /patch-all\.js", \[platform, "--check"\]/);
});

test("Windows artifact validation rejects non-x64 PE binaries", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pe-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const binary = path.join(root, "Codex.exe");
  const buffer = Buffer.alloc(128);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(64, 0x3c);
  buffer.write("PE\0\0", 64, "ascii");
  buffer.writeUInt16LE(0x8664, 68);
  fs.writeFileSync(binary, buffer);

  assert.equal(readPeMachine(binary), 0x8664);
  assert.doesNotThrow(() => verifyPeX64(binary));
  buffer.writeUInt16LE(0xaa64, 68);
  fs.writeFileSync(binary, buffer);
  assert.throws(() => verifyPeX64(binary), /is not x64 PE/);
});

test("Windows ASAR integrity explicitly supports the Owl runtime", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-owl-integrity-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const resourcesDir = path.join(root, "resources");
  const executablePath = path.join(root, "Codex.exe");
  fs.mkdirSync(resourcesDir);
  fs.writeFileSync(executablePath, "owl runtime without Electron fuses");
  fs.writeFileSync(
    path.join(resourcesDir, "owl-electron-app.json"),
    JSON.stringify({ runtimeName: "owl" }),
  );

  assert.equal(
    updateWindowsAsarIntegrity({
      executablePath,
      resourcesDir,
      oldHash: "a".repeat(64),
      newHash: "b".repeat(64),
    }),
    "owl",
  );
});

test("Windows ASAR integrity updates an embedded Electron hash", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-electron-integrity-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const executablePath = path.join(root, "Codex.exe");
  const oldHash = "a".repeat(64);
  const newHash = "b".repeat(64);
  fs.writeFileSync(executablePath, `prefix${oldHash}suffix`);

  assert.equal(
    updateWindowsAsarIntegrity({
      executablePath,
      resourcesDir: path.join(root, "resources"),
      oldHash,
      newHash,
    }),
    "electron",
  );
  assert.match(fs.readFileSync(executablePath, "utf8"), new RegExp(newHash));
});

test("Windows ASAR integrity rejects unknown or ambiguous runtimes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runtime-integrity-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const resourcesDir = path.join(root, "resources");
  const executablePath = path.join(root, "Codex.exe");
  fs.mkdirSync(resourcesDir);
  fs.writeFileSync(executablePath, "unknown runtime");
  const options = {
    executablePath,
    resourcesDir,
    oldHash: "a".repeat(64),
    newHash: "b".repeat(64),
  };

  assert.throws(() => updateWindowsAsarIntegrity(options), /runtime is not Owl/);
  fs.writeFileSync(
    path.join(resourcesDir, "owl-electron-app.json"),
    JSON.stringify({ runtimeName: "owl" }),
  );
  fs.writeFileSync(executablePath, "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
  assert.throws(() => updateWindowsAsarIntegrity(options), /Electron fuse wire/);
});

test("Linux build uses a validated upstream main entry", (t) => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-linux-main-"));
  t.after(() => fs.rmSync(srcDir, { force: true, recursive: true }));
  const entry = path.join(srcDir, ".vite", "build", "early-bootstrap.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "// entry");

  assert.equal(
    resolveLinuxMain({ upstreamMain: ".vite/build/early-bootstrap.js", srcDir }),
    "src/.vite/build/early-bootstrap.js",
  );
  assert.throws(() => resolveLinuxMain({ upstreamMain: "../escape.js", srcDir }), /Unsafe/);
  assert.throws(() => resolveLinuxMain({ upstreamMain: "missing.js", srcDir }), /not found/);
});

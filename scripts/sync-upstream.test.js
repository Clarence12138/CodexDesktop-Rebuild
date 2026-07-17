const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  findMacApp,
  getZipExtractor,
  parseArchitectures,
  parseArgs,
  parseMachOArchitectures,
  removeCacheEntries,
  validateMacMetadata,
} = require("./sync-upstream-lib");
const { selectPackageForArchitecture } = require("./fetch-msstore");

test("parseArgs accepts a local macOS app and rejects conflicting flags", () => {
  const localMacApp = "/Applications/Codex.app";
  const options = parseArgs(["--force", "--skip-win", "--local-mac-app", localMacApp]);
  assert.equal(options.force, true);
  assert.equal(options.skipWin, true);
  assert.equal(options.localMacApp, path.resolve(localMacApp));
  assert.equal(options.macPlatform, null);
  assert.throws(() => parseArgs(["--skip-mac", "--local-mac-app", "/tmp/App.app"]), /cannot be combined/);
  assert.throws(() => parseArgs(["--local-mac-app"]), /requires a path/);
});

test("parseArgs restricts sync to one macOS platform", () => {
  const options = parseArgs(["--skip-win", "--mac-platform", "mac-x64"]);
  assert.equal(options.macPlatform, "mac-x64");
  assert.throws(() => parseArgs(["--mac-platform", "linux-x64"]), /must be/);
  assert.throws(() => parseArgs(["--skip-mac", "--mac-platform", "mac-x64"]), /cannot be combined/);
});

test("ZIP extraction uses platform-native tools", () => {
  assert.deepEqual(getZipExtractor("Codex.zip", "/tmp/out", "darwin"), {
    binary: "ditto",
    args: ["-xk", "Codex.zip", "/tmp/out"],
  });
  assert.deepEqual(getZipExtractor("Codex.zip", "/tmp/out", "linux"), {
    binary: "unzip",
    args: ["-q", "Codex.zip", "-d", "/tmp/out"],
  });
  assert.equal(getZipExtractor("Codex.msix", "/tmp/out", "win32"), null);
});

test("findMacApp locates an arbitrarily named app containing app.asar", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-find-app-"));
  const app = path.join(root, "nested", "ChatGPT.app");
  fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Resources", "app.asar"), "test");
  assert.equal(findMacApp(root), app);
  fs.rmSync(root, { recursive: true, force: true });
});

test("metadata validation enforces version, build, ASAR version, and architecture", () => {
  const metadata = {
    bundleIdentifier: "com.openai.codex",
    version: "26.707.31428",
    build: "5059",
    executable: "ChatGPT",
    asarVersion: "26.707.31428",
    variants: ["mac-arm64"],
  };
  assert.equal(validateMacMetadata(metadata, { variant: "mac-arm64", version: metadata.version }), metadata);
  assert.throws(() => validateMacMetadata({ ...metadata, asarVersion: "0.0.0" }), /Version mismatch/);
  assert.throws(() => validateMacMetadata(metadata, { variant: "mac-x64" }), /Architecture mismatch/);
  assert.deepEqual(parseArchitectures("arm64 x86_64\n"), ["arm64", "x86_64"]);
});

test("Mach-O validation identifies supported thin architectures", () => {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  assert.deepEqual(parseMachOArchitectures(header), ["arm64"]);

  header.writeUInt32LE(0x01000007, 4);
  assert.deepEqual(parseMachOArchitectures(header), ["x86_64"]);
  header.writeUInt32LE(0x00000007, 4);
  assert.throws(() => parseMachOArchitectures(header), /Unsupported Mach-O CPU type/);
});

test("--force cache removal deletes archives and extraction directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-force-"));
  const archive = path.join(root, "cached.zip");
  const extract = path.join(root, "extract");
  fs.writeFileSync(archive, "cached");
  fs.mkdirSync(extract);
  removeCacheEntries([archive, extract], false);
  assert.equal(fs.existsSync(archive), true);
  removeCacheEntries([archive, extract], true);
  assert.equal(fs.existsSync(archive), false);
  assert.equal(fs.existsSync(extract), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Microsoft Store package selection requires the requested architecture", () => {
  const packages = [
    { name: "OpenAI.Codex_26.715.2305.0_arm64__publisher.msix" },
    { name: "OpenAI.Codex_26.715.2305.0_x64__publisher.msix" },
  ];

  assert.equal(selectPackageForArchitecture(packages, "x64"), packages[1]);
  assert.throws(
    () => selectPackageForArchitecture(packages, "x86"),
    /Unsupported Microsoft Store architecture/,
  );
  assert.throws(
    () => selectPackageForArchitecture(packages.slice(0, 1), "x64"),
    /Expected exactly one x64 Microsoft Store package/,
  );
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { findAppBundle } = require("../scripts/build-common");
const { parsePlatform } = require("../scripts/build-from-upstream");
const { parseArgs, selectedPlatforms, syncArgs } = require("../scripts/rebuild");

const buildMacSource = fs.readFileSync(
  path.join(__dirname, "../scripts/build-mac.js"),
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

test("rebuild requires strict applied-patch verification before packaging", () => {
  assert.match(rebuildSource, /patch-all\.js", \[platform, "--verify"\]/);
  assert.doesNotMatch(rebuildSource, /patch-all\.js", \[platform, "--check"\]/);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  PLATFORM_PRIORITY,
  findUpstreamPkg,
  parseArgs,
  updateVersionFiles,
} = require("../scripts/bump-version");

function createPackage(srcDir, platform, version) {
  const packageDir = path.join(srcDir, platform, "_asar");
  fs.mkdirSync(packageDir, { recursive: true });
  const packagePath = path.join(packageDir, "package.json");
  fs.writeFileSync(packagePath, JSON.stringify({ version }));
  return packagePath;
}

test("findUpstreamPkg selects the requested platform ASAR package", (t) => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "bump-version-"));
  t.after(() => fs.rmSync(srcDir, { recursive: true, force: true }));
  createPackage(srcDir, "mac-arm64", "1.0.0");
  const expected = createPackage(srcDir, "mac-x64", "2.0.0");

  assert.equal(findUpstreamPkg({ srcDir, platform: "mac-x64" }), expected);
});

test("findUpstreamPkg uses deterministic platform priority", (t) => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "bump-version-"));
  t.after(() => fs.rmSync(srcDir, { recursive: true, force: true }));
  createPackage(srcDir, "win", "3.0.0");
  const expected = createPackage(srcDir, "mac-x64", "2.0.0");

  assert.equal(PLATFORM_PRIORITY[0], "mac-arm64");
  assert.equal(findUpstreamPkg({ srcDir }), expected);
});

test("findUpstreamPkg does not accept the obsolete flat package layout", (t) => {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "bump-version-"));
  t.after(() => fs.rmSync(srcDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(srcDir, "unix"), { recursive: true });
  fs.writeFileSync(path.join(srcDir, "unix", "package.json"), "{}");

  assert.equal(findUpstreamPkg({ srcDir }), null);
});

test("parseArgs reads dry-run and platform options", () => {
  assert.deepEqual(parseArgs(["--dry-run", "--platform", "mac-x64"]), {
    dryRun: true,
    platform: "mac-x64",
  });
  assert.throws(() => parseArgs(["--platform"]), /requires a value/);
});

test("updateVersionFiles synchronizes package and lockfile versions", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bump-version-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packagePath = path.join(dir, "package.json");
  const lockPath = path.join(dir, "package-lock.json");
  fs.writeFileSync(packagePath, JSON.stringify({ version: "1.0.0" }));
  fs.writeFileSync(lockPath, JSON.stringify({
    version: "1.0.0",
    packages: { "": { version: "1.0.0" } },
  }));

  const oldVersion = updateVersionFiles({
    packagePath,
    lockPath,
    version: "2.0.0",
    buildNumber: "5059",
  });
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));

  assert.equal(oldVersion, "1.0.0");
  assert.deepEqual(pkg, { version: "2.0.0", codexBuildNumber: "5059" });
  assert.equal(lock.version, "2.0.0");
  assert.equal(lock.packages[""].version, "2.0.0");
});

test("updateVersionFiles rejects an invalid lockfile before writing", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bump-version-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packagePath = path.join(dir, "package.json");
  const lockPath = path.join(dir, "package-lock.json");
  const originalPackage = JSON.stringify({ version: "1.0.0" });
  fs.writeFileSync(packagePath, originalPackage);
  fs.writeFileSync(lockPath, JSON.stringify({ version: "1.0.0" }));

  assert.throws(
    () => updateVersionFiles({ packagePath, lockPath, version: "2.0.0" }),
    /missing packages\[''\]/,
  );
  assert.equal(fs.readFileSync(packagePath, "utf-8"), originalPackage);
});

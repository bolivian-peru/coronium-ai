#!/usr/bin/env node
// Pre-publish checks for coronium-sdk and coronium-cli. Run with `pnpm doctor`
// (also part of `pnpm publish:dry`).
//
// Catches what npm itself will not: missing dist, version drift between
// package.json and the version constants, leftover tarballs, secret-shaped
// strings, and internal identifiers that must never appear in a public repo.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGES = [
  { dir: "sdk-ts", name: "coronium-sdk", versionFile: "src/version.ts", versionConst: "SDK_VERSION" },
  { dir: "cli", name: "coronium-cli", versionFile: "src/version.ts", versionConst: "CLI_VERSION" },
];

const errors = [];

function fail(message) {
  errors.push(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function versionConstant(path, name) {
  const match = readFileSync(path, "utf8").match(new RegExp(`${name}: string = "([^"]+)"`));
  return match ? match[1] : null;
}

// 1. Package shape and version consistency.
for (const pkgInfo of PACKAGES) {
  const dir = join(ROOT, "packages", pkgInfo.dir);
  for (const file of ["dist", "README.md", "LICENSE", "package.json"]) {
    if (!existsSync(join(dir, file))) fail(`${pkgInfo.dir}: missing ${file}`);
  }
  if (!existsSync(join(dir, "package.json"))) continue;
  const pkg = readJson(join(dir, "package.json"));
  if (pkg.name !== pkgInfo.name) fail(`${pkgInfo.dir}: package name is "${pkg.name}", expected "${pkgInfo.name}"`);
  if (pkg.private) fail(`${pkgInfo.dir}: private:true blocks publishing`);
  if (pkg.publishConfig?.access !== "public") fail(`${pkgInfo.dir}: publishConfig.access must be "public"`);
  if (!String(pkg.repository?.url ?? "").includes("github.com/bolivian-peru/coronium-ai")) {
    fail(`${pkgInfo.dir}: repository.url must point at bolivian-peru/coronium-ai`);
  }
  const constant = versionConstant(join(dir, pkgInfo.versionFile), pkgInfo.versionConst);
  if (constant !== pkg.version) fail(`${pkgInfo.dir}: ${pkgInfo.versionConst} (${constant}) differs from package.json (${pkg.version})`);
}

const cliPkg = readJson(join(ROOT, "packages", "cli", "package.json"));
if (cliPkg.dependencies?.["coronium-sdk"] !== "workspace:*") {
  fail(`cli: coronium-sdk dependency must be "workspace:*" (pnpm publish pins it to the SDK version)`);
}
const sdkPkg = readJson(join(ROOT, "packages", "sdk-ts", "package.json"));
if (Object.keys(sdkPkg.dependencies ?? {}).length > 0) fail("sdk-ts: the SDK must have no runtime dependencies");

// 2. No leftover tarballs.
function findTarballs(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...findTarballs(full));
    else if (name.endsWith(".tgz")) found.push(full);
  }
  return found;
}
const tarballs = findTarballs(ROOT);
if (tarballs.length > 0) fail(`leftover tarballs: ${tarballs.join(", ")}`);

// 3. Secrets and internal identifiers in everything that is public.
const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]{10,}/,
  /sk_test_[A-Za-z0-9]{10,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /npm_[A-Za-z0-9]{30,}/,
  /AIza[A-Za-z0-9_-]{30,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AKIA[A-Z0-9]{16}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
];
const INTERNAL_PATTERNS = [
  /\b100\.(64|85|107|108)\.\d+\.\d+\b/,
  /\b(65\.108|37\.27|95\.216|91\.107)\.\d+\.\d+\b/,
  /coronium-mongo|cor-api-v1|ts-api|ts-mongo|home\/projects/,
  /mongodb(\+srv)?:\/\//i,
  /MONGO_HOST|MONGO_URI|STRIPE_SECRET|COINGATE_API_KEY|RESEND_API_KEY/,
  /\bfarmer|\bKOEF\b|\bdefects?\b/i,
  /[A-Za-z]+(Controller|Service)\.(js|ts):\d+/,
];

function scanFile(path) {
  const text = readFileSync(path, "utf8");
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) fail(`secret-shaped string in ${path}: ${pattern}`);
  }
  for (const pattern of INTERNAL_PATTERNS) {
    if (pattern.test(text)) fail(`internal identifier in ${path}: ${pattern}`);
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|js|mjs|cjs|json|yaml|yml|md|txt)$/i.test(name)) scanFile(full);
  }
}
walk(join(ROOT, "packages"));
for (const file of ["AGENTS.md", "llms.txt", "README.md", "CHANGELOG.md", "RELEASE.md"]) {
  if (existsSync(join(ROOT, file))) scanFile(join(ROOT, file));
}

// 4. Copy style in the published READMEs: short dashes only.
for (const pkgInfo of PACKAGES) {
  const readme = join(ROOT, "packages", pkgInfo.dir, "README.md");
  if (existsSync(readme) && /[\u2013\u2014]/.test(readFileSync(readme, "utf8"))) {
    fail(`${readme}: use "-" instead of en or em dashes`);
  }
}

if (errors.length > 0) {
  console.error("Doctor found issues that block publishing:");
  for (const message of errors) console.error(`  x ${message}`);
  process.exit(1);
}
console.log("Doctor: ok - coronium-sdk and coronium-cli look publishable.");

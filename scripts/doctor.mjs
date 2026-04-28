#!/usr/bin/env node
// Pre-publish sanity checks. Run via `pnpm doctor` (also runs as part of
// `pnpm publish:dry` and `pnpm publish:alpha`).
//
// Catches the things npm itself won't: missing dist, leftover .tgz, secret-
// looking strings, references to wrong github org, etc.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url)) + "/..";
const PACKAGES = ["sdk-ts", "cli", "mcp"];

const errors = [];
const warnings = [];

function fail(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }

// 1. Each package has a dist/, README, LICENSE, package.json.
for (const p of PACKAGES) {
  const dir = join(ROOT, "packages", p);
  if (!existsSync(join(dir, "dist"))) fail(`${p}: missing dist/ — run \`pnpm build\``);
  if (!existsSync(join(dir, "README.md"))) fail(`${p}: missing README.md`);
  if (!existsSync(join(dir, "LICENSE"))) fail(`${p}: missing LICENSE`);
  if (!existsSync(join(dir, "package.json"))) { fail(`${p}: missing package.json`); continue; }

  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (!pkg.name?.startsWith("@coronium/")) fail(`${p}: package name "${pkg.name}" must start with @coronium/`);
  if (!pkg.version) fail(`${p}: missing version`);
  if (pkg.private) fail(`${p}: private:true blocks publishing`);
  if (pkg.publishConfig?.access !== "public") fail(`${p}: publishConfig.access must be "public"`);
  if (!pkg.license) warn(`${p}: missing license field`);
}

// 2. No leftover .tgz tarballs (npm pack debris).
function findTarballs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...findTarballs(full));
    else if (name.endsWith(".tgz")) out.push(full);
  }
  return out;
}
const tarballs = findTarballs(ROOT);
if (tarballs.length) fail(`leftover tarballs: ${tarballs.join(", ")} — delete them before publishing`);

// 3. Secret scanner over the trees that will publish (dist/ + root files).
const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]{10,}/,
  /sk_test_[A-Za-z0-9]{10,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /AIza[A-Za-z0-9_-]{30,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AKIA[A-Z0-9]{16}/,
  /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
];
const PROD_HOST_PATTERNS = [
  /\b100\.(64|85|107|108)\.\d+\.\d+\b/,    // Tailscale internal
  /\b65\.108\./, /\b37\.27\./, /\b95\.216\./, /\b91\.107\./, // prod IPs
  /coronium-mongo|cor-api-v1|ts-api|ts-mongo/,
  /MONGO_HOST|MONGO_URI|STRIPE_SECRET|COINGATE_API_KEY|RESEND_API_KEY/,
];

function scanFile(path) {
  const text = readFileSync(path, "utf8");
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) fail(`secret-shaped string in ${path}: ${re}`);
  }
  for (const re of PROD_HOST_PATTERNS) {
    if (re.test(text)) fail(`production identifier in ${path}: ${re}`);
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/\.(ts|js|mjs|cjs|json|yaml|yml|md|txt)$/i.test(name)) scanFile(full);
  }
}
walk(join(ROOT, "packages"));
for (const f of ["openapi.yaml", "AGENTS.md", "llms.txt", "README.md", "CHANGELOG.md"]) {
  if (existsSync(join(ROOT, f))) scanFile(join(ROOT, f));
}

// ─── Report ────────────────────────────────────────────────────────────────

if (warnings.length) {
  console.warn("Warnings:");
  for (const w of warnings) console.warn(`  ! ${w}`);
}
if (errors.length) {
  console.error("Doctor found issues that block publishing:");
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log("Doctor: ok — packages look publishable.");

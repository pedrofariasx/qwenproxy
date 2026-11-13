#!/usr/bin/env node
/**
 * Checks that the Docker build stays compatible with the installed Playwright.
 *
 * The image `mcr.microsoft.com/playwright:v<version>-noble` ships the browser
 * binaries that match that exact Playwright release. If the npm dependency and
 * the image drift apart, Chromium fails to launch at runtime with
 * "Executable doesn't exist" under /ms-playwright — a failure that only shows
 * up on a real request, never at build time.
 *
 * This script is run by `npm run docker:verify` and by CI.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

const pkg = readJson("package.json");
const declared = pkg.dependencies?.patchright ?? "";
const declaredVersion = declared.replace(/^[\^~>=<\s]*/, "");

// The version pinned in the Dockerfile build arg.
const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
const argMatch = dockerfile.match(/^ARG\s+PLAYWRIGHT_VERSION=(\S+)/m);
const dockerVersion = argMatch ? argMatch[1] : null;

// The version pinned in docker-compose.yml.
const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
const composeMatch = compose.match(/PLAYWRIGHT_VERSION:\s*"?([^"\s]+)"?/);
const composeVersion = composeMatch ? composeMatch[1] : null;

// The version actually installed, when node_modules is present.
let installedVersion = null;
try {
  installedVersion = readJson("node_modules/playwright/package.json").version;
} catch {
  /* dependencies not installed */
}

const problems = [];

if (!declaredVersion) {
  problems.push("package.json has no `patchright` dependency");
}

if (!dockerVersion) {
  problems.push("Dockerfile has no `ARG PLAYWRIGHT_VERSION`");
} else if (declaredVersion && dockerVersion !== declaredVersion) {
  problems.push(
    `Dockerfile PLAYWRIGHT_VERSION=${dockerVersion} does not match package.json playwright=${declaredVersion}`,
  );
}

if (!composeVersion) {
  problems.push("docker-compose.yml has no PLAYWRIGHT_VERSION build arg");
} else if (dockerVersion && composeVersion !== dockerVersion) {
  problems.push(
    `docker-compose.yml PLAYWRIGHT_VERSION=${composeVersion} does not match Dockerfile PLAYWRIGHT_VERSION=${dockerVersion}`,
  );
}

if (
  installedVersion &&
  declaredVersion &&
  installedVersion !== declaredVersion
) {
  problems.push(
    `installed playwright=${installedVersion} does not match package.json playwright=${declaredVersion} (run npm ci)`,
  );
}

if (problems.length > 0) {
  console.error("Docker/Playwright version mismatch:\n");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error(
    "\nThe Playwright image ships the browser binaries for its exact version.",
  );
  console.error(
    "Bump PLAYWRIGHT_VERSION in the Dockerfile and docker-compose.yml together",
  );
  console.error("with the `playwright` dependency in package.json.");
  process.exit(1);
}

console.log(`Playwright version is consistent: ${declaredVersion}`);
if (installedVersion) console.log(`Installed: ${installedVersion}`);
console.log(`Dockerfile / docker-compose PLAYWRIGHT_VERSION: ${dockerVersion}`);

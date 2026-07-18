#!/usr/bin/env node
/**
 * Repository validation for my-opencli monorepo plugins.
 *
 * Modes:
 *   (default)        validate manifest + packages + JS syntax
 *   --manifest-only  skip syntax checks
 *   --syntax-only    only JS syntax on tracked plugin files
 *
 * Dependency-light: Node built-ins only.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MANIFEST_FILE = 'opencli-plugin.json';
const ROOT_PACKAGE_FILE = 'package.json';
const OPENCLI_PEER = '@jackwener/opencli';

/** Plugin / path segment names: lowercase alnum, hyphen/underscore, no leading punctuation. */
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

const args = new Set(process.argv.slice(2));
const manifestOnly = args.has('--manifest-only');
const syntaxOnly = args.has('--syntax-only');

let errors = 0;

function fail(msg) {
  console.error(`✗ ${msg}`);
  errors += 1;
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

if (manifestOnly && syntaxOnly) {
  fail('Use at most one of --manifest-only / --syntax-only');
}

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    fail(`Cannot read/parse JSON: ${path.relative(ROOT, filePath)} (${err.message})`);
    return null;
  }
}

/** Relative path is non-empty, non-absolute, and does not escape via `..`. */
function isPathSafe(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) return false;
  if (path.isAbsolute(relPath)) return false;
  const normalized = path.posix.normalize(relPath.replace(/\\/g, '/'));
  if (normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/')) {
    return false;
  }
  if (normalized.includes('\0')) return false;
  return true;
}

/**
 * Resolve a relative path only if it is path-safe and stays strictly inside ROOT
 * (not the root directory itself, not outside via `..` / absolute).
 * Returns { relPath, absPath } or null.
 */
function resolvePluginPathInsideRoot(relPath) {
  if (!isPathSafe(relPath)) return null;
  const normalized = path.posix.normalize(String(relPath).replace(/\\/g, '/'));
  const absPath = path.resolve(ROOT, normalized);
  const relFromRoot = path.relative(ROOT, absPath);
  // Outside ROOT, or exactly ROOT: reject.
  if (
    relFromRoot === '' ||
    relFromRoot === '..' ||
    relFromRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relFromRoot)
  ) {
    return null;
  }
  const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (!absPath.startsWith(rootPrefix)) {
    return null;
  }
  return {
    relPath: normalized,
    absPath,
  };
}

function loadManifest() {
  const manifestPath = path.join(ROOT, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    fail(`Missing ${MANIFEST_FILE}`);
    return null;
  }
  const manifest = readJson(manifestPath);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail(`${MANIFEST_FILE} must be a JSON object`);
    return null;
  }
  return manifest;
}

function enabledPlugins(manifest) {
  const plugins = manifest.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
    return [];
  }
  return Object.entries(plugins)
    .filter(([, entry]) => entry && typeof entry === 'object' && !entry.disabled)
    .map(([name, entry]) => ({ name, entry }));
}

/**
 * Collect enabled plugins with safe in-ROOT paths only.
 * Unsafe paths are reported and skipped (never returned for walk/git).
 */
function collectSafeEnabledPlugins(manifest, { report = true } = {}) {
  const plugins = manifest?.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
    return [];
  }

  const enabled = [];
  for (const [name, entry] of Object.entries(plugins)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.disabled) {
      continue;
    }
    const resolved = resolvePluginPathInsideRoot(entry.path);
    if (!resolved) {
      if (report) {
        fail(
          `Plugin "${name}": path is missing, unsafe, or outside repository root ("${entry.path}")`,
        );
      }
      continue;
    }
    enabled.push({ name, entry, relPath: resolved.relPath, absPath: resolved.absPath });
  }
  return enabled;
}

function validateManifestAndPackages() {
  const manifest = loadManifest();
  if (!manifest) return [];

  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    fail(`${MANIFEST_FILE}: missing top-level "version"`);
  } else {
    ok(`${MANIFEST_FILE} version=${manifest.version}`);
  }

  const rootPkgPath = path.join(ROOT, ROOT_PACKAGE_FILE);
  if (!fs.existsSync(rootPkgPath)) {
    fail(`Missing root ${ROOT_PACKAGE_FILE}`);
  } else {
    const rootPkg = readJson(rootPkgPath);
    if (rootPkg) {
      if (typeof rootPkg.version !== 'string' || !rootPkg.version.trim()) {
        fail(`Root ${ROOT_PACKAGE_FILE}: missing "version"`);
      } else if (
        typeof manifest.version === 'string' &&
        rootPkg.version !== manifest.version
      ) {
        fail(
          `Root ${ROOT_PACKAGE_FILE} version "${rootPkg.version}" !== ${MANIFEST_FILE} version "${manifest.version}"`,
        );
      } else if (typeof manifest.version === 'string') {
        ok(`Root package.json version=${rootPkg.version} matches ${MANIFEST_FILE}`);
      }
    }
  }

  const rootOpencli =
    typeof manifest.opencli === 'string' && manifest.opencli.trim()
      ? manifest.opencli.trim()
      : null;
  if (!rootOpencli) {
    fail(`${MANIFEST_FILE}: missing top-level "opencli" range`);
  } else {
    ok(`${MANIFEST_FILE} opencli=${rootOpencli}`);
  }

  const plugins = manifest.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
    fail(`${MANIFEST_FILE}: "plugins" must be a non-empty object for this monorepo`);
    return [];
  }

  const names = Object.keys(plugins);
  const nameSet = new Set();
  const pathSet = new Set();
  const enabled = [];

  for (const name of names) {
    const entry = plugins[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`Plugin "${name}": entry must be an object`);
      continue;
    }

    if (!SAFE_NAME_RE.test(name)) {
      fail(`Plugin "${name}": name is not path-safe (expected [A-Za-z0-9][A-Za-z0-9_-]*)`);
    } else if (nameSet.has(name)) {
      fail(`Plugin "${name}": duplicate name`);
    } else {
      nameSet.add(name);
    }

    const resolved = resolvePluginPathInsideRoot(entry.path);
    if (!resolved) {
      fail(
        `Plugin "${name}": path is missing, unsafe, or outside repository root ("${entry.path}")`,
      );
      continue;
    }

    if (pathSet.has(resolved.relPath)) {
      fail(`Plugin "${name}": path "${resolved.relPath}" is not unique`);
    } else {
      pathSet.add(resolved.relPath);
    }

    if (entry.disabled) {
      ok(`Plugin "${name}": disabled (skipped package checks)`);
      continue;
    }

    enabled.push({ name, entry, relPath: resolved.relPath, absPath: resolved.absPath });
  }

  for (const { name, entry, relPath, absPath } of enabled) {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
      fail(`Plugin "${name}": directory missing: ${relPath}`);
      continue;
    }

    const pkgPath = path.join(absPath, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      fail(`Plugin "${name}": missing package.json under ${relPath}`);
      continue;
    }

    const pkg = readJson(pkgPath);
    if (!pkg) continue;

    const manifestVersion = entry.version ?? manifest.version;
    if (typeof manifestVersion !== 'string') {
      fail(`Plugin "${name}": no version in subplugin entry or root manifest`);
    } else if (pkg.version !== manifestVersion) {
      fail(
        `Plugin "${name}": manifest version "${manifestVersion}" !== package.json version "${pkg.version}"`,
      );
    } else {
      ok(`Plugin "${name}": version ${pkg.version}`);
    }

    if (pkg.private !== true) {
      fail(`Plugin "${name}": package.json "private" must be true`);
    } else {
      ok(`Plugin "${name}": private=true`);
    }

    if (pkg.type !== 'module') {
      fail(`Plugin "${name}": package.json "type" must be "module" (ESM)`);
    } else {
      ok(`Plugin "${name}": type=module`);
    }

    const entryOpencli =
      typeof entry.opencli === 'string' && entry.opencli.trim() ? entry.opencli.trim() : null;
    if (!entryOpencli) {
      fail(`Plugin "${name}": entry.opencli must be a nonempty string`);
    } else if (rootOpencli && entryOpencli !== rootOpencli) {
      fail(
        `Plugin "${name}": entry.opencli "${entryOpencli}" !== root opencli "${rootOpencli}"`,
      );
    } else {
      ok(`Plugin "${name}": opencli=${entryOpencli}`);
    }

    const peer = pkg.peerDependencies?.[OPENCLI_PEER];
    if (typeof peer !== 'string' || !peer.trim()) {
      fail(`Plugin "${name}": peerDependencies["${OPENCLI_PEER}"] is required`);
    } else if (entryOpencli && peer.trim() !== entryOpencli) {
      fail(
        `Plugin "${name}": peerDependencies["${OPENCLI_PEER}"] "${peer}" !== entry.opencli "${entryOpencli}"`,
      );
    } else {
      ok(`Plugin "${name}": peer ${OPENCLI_PEER}@${peer}`);
    }
  }

  if (enabled.length === 0) {
    fail('No enabled subplugins found');
  } else {
    ok(`Enabled subplugins: ${enabled.map((p) => p.name).join(', ')}`);
  }

  return enabled;
}

function listTrackedPluginJs(enabled) {
  // Only use paths already validated as inside ROOT.
  const dirs = [];
  for (const p of enabled) {
    const resolved = resolvePluginPathInsideRoot(p.relPath);
    if (!resolved) {
      fail(
        `Plugin "${p.name}": refusing syntax scan; path unsafe or outside root ("${p.relPath}")`,
      );
      continue;
    }
    dirs.push(resolved.relPath);
  }
  if (dirs.length === 0) return [];

  // Prefer git-tracked files when available; fall back to walk for non-git checkouts.
  const git = spawnSync(
    'git',
    ['-C', ROOT, 'ls-files', '-z', '--', ...dirs.map((d) => `${d}/**/*.js`), ...dirs.map((d) => `${d}/*.js`)],
    { encoding: 'buffer' },
  );

  if (git.status === 0) {
    const out = git.stdout.toString('utf8');
    return out
      .split('\0')
      .filter(Boolean)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => {
        // Only keep files whose path stays under an approved plugin dir and inside ROOT.
        const fileResolved = resolvePluginPathInsideRoot(f);
        if (!fileResolved) return false;
        return dirs.some(
          (d) => fileResolved.relPath === d || fileResolved.relPath.startsWith(`${d}/`),
        );
      })
      .sort();
  }

  const files = [];
  for (const rel of dirs) {
    const resolved = resolvePluginPathInsideRoot(rel);
    if (!resolved) continue;
    walkJs(resolved.absPath, files);
  }
  return files
    .map((abs) => path.relative(ROOT, abs).split(path.sep).join('/'))
    .filter((rel) => resolvePluginPathInsideRoot(rel))
    .sort();
}

function walkJs(dir, acc) {
  if (!fs.existsSync(dir)) return;
  // Refuse to walk outside ROOT even if a caller passes a bad absolute path.
  const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (dir !== ROOT && !dir.startsWith(rootPrefix)) return;

  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkJs(full, acc);
    else if (ent.isFile() && ent.name.endsWith('.js')) acc.push(full);
  }
}

function validateSyntax(enabled) {
  const files = listTrackedPluginJs(enabled);
  if (files.length === 0) {
    fail('No tracked plugin .js files found for syntax check');
    return;
  }

  let checked = 0;
  for (const rel of files) {
    const resolved = resolvePluginPathInsideRoot(rel);
    if (!resolved) {
      fail(`Syntax check skipped unsafe path: ${rel}`);
      continue;
    }
    const result = spawnSync(process.execPath, ['--check', resolved.absPath], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim();
      fail(`Syntax error in ${rel}${detail ? `\n${detail}` : ''}`);
    } else {
      checked += 1;
    }
  }
  ok(`JS syntax OK for ${checked} tracked plugin file(s)`);
}

function main() {
  console.log(`validate-repo (root=${ROOT})`);

  let enabled = [];
  if (!syntaxOnly) {
    enabled = validateManifestAndPackages();
  } else {
    const manifest = loadManifest();
    // Even in --syntax-only, never construct git/walk paths from unsafe/out-of-root entries.
    enabled = manifest ? collectSafeEnabledPlugins(manifest, { report: true }) : [];
  }

  if (!manifestOnly) {
    if (enabled.length === 0 && syntaxOnly) {
      fail('No enabled plugins with safe in-repo paths to syntax-check');
    } else if (enabled.length > 0) {
      validateSyntax(enabled);
    }
  }

  if (errors > 0) {
    console.error(`\n${errors} validation error(s)`);
    process.exit(1);
  }
  console.log('\nAll repository checks passed.');
}

main();

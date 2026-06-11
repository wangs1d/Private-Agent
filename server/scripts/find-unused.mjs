// Find .ts files in src/ and check if they are imported anywhere
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(process.cwd(), 'src');
const ROOT = process.cwd();

function listTsFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name.startsWith('.')) continue;
      out.push(...listTsFiles(p));
    } else if (ent.isFile() && (p.endsWith('.ts') || p.endsWith('.tsx'))) {
      out.push(p);
    }
  }
  return out;
}

const allFiles = listTsFiles(SRC);
const fileSet = new Map();
for (const f of allFiles) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const noExt = rel.replace(/\.(ts|tsx)$/, '');
  fileSet.set(noExt, rel);
}

const contentCache = new Map();
for (const f of allFiles) {
  contentCache.set(f, fs.readFileSync(f, 'utf8'));
}

function getImports(content) {
  const specs = new Set();
  // import {x} from '...'
  for (const m of content.matchAll(/from\s+['"]([^'"]+)['"]/g)) specs.add(m[1]);
  // import('...') dynamic
  for (const m of content.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  // require('...')
  for (const m of content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  // export {x} from '...'
  for (const m of content.matchAll(/export\s+(?:type\s+)?\{[^}]+\}\s*from\s+['"]([^'"]+)['"]/g)) specs.add(m[1]);
  return specs;
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const dir = path.dirname(fromFile);
  let p = path.resolve(dir, spec);
  // Strip .js/.jsx if present and try both forms
  const stripped = p.replace(/\.(js|jsx)$/, '');
  const candidates = [
    stripped,
    stripped + '.ts',
    stripped + '.tsx',
    stripped + '/index.ts',
    stripped + '/index.tsx',
  ];
  for (const c of candidates) {
    if (contentCache.has(c)) {
      return path.relative(ROOT, c).replace(/\\/g, '/').replace(/\.(ts|tsx)$/, '');
    }
  }
  return null;
}

const importGraph = new Map();
for (const f of allFiles) {
  const content = contentCache.get(f);
  const specs = getImports(content);
  const targets = new Set();
  for (const spec of specs) {
    const tgt = resolveImport(f, spec);
    if (tgt) targets.add(tgt);
  }
  importGraph.set(path.relative(ROOT, f).replace(/\\/g, '/').replace(/\.(ts|tsx)$/, ''), targets);
}

const indexTargets = importGraph.get('src/index') || new Set();

const usedSet = new Set();
function dfs(node) {
  if (usedSet.has(node)) return;
  usedSet.add(node);
  const targets = importGraph.get(node);
  if (!targets) return;
  for (const t of targets) dfs(t);
}
for (const t of indexTargets) dfs(t);

const unused = [];
for (const f of fileSet.keys()) {
  if (f === 'src/index') continue;
  if (!usedSet.has(f)) unused.push(fileSet.get(f));
}

console.log('Total .ts files in src/:', allFiles.length);
console.log('Used files (transitive from src/index):', usedSet.size);
console.log('Files reachable from src/index:', fileSet.size);
console.log('\n=== Unused files (not reachable from src/index) ===');
for (const f of unused.sort()) console.log('  ' + f);

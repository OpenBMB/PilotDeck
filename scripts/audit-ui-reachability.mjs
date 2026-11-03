// Report source modules unreachable from the production entry point. Tests and
// CSS are deliberately excluded as roots: a test alone does not ship a feature.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../ui/src/', import.meta.url));
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.[cm]?[jt]sx?$/.test(file) && !/\.(test|spec)\./.test(file)) files.push(file);
  }
}
walk(root);
const known = new Set(files);
const edges = new Map();
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports = [];
  function visit(node) {
    if (ts.isStringLiteral(node) && (ts.isImportDeclaration(node.parent)
      || ts.isExportDeclaration(node.parent)
      || (ts.isCallExpression(node.parent) && node.parent.expression.kind === ts.SyntaxKind.ImportKeyword))) {
      const name = node.text;
      if (name.startsWith('.')) {
        const base = path.resolve(path.dirname(file), name);
        const stem = base.replace(/\.[cm]?[jt]sx?$/, '');
        const resolved = [base, ...['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'].map(ext => stem + ext)]
          .map(candidate => path.normalize(candidate)).find(candidate => known.has(candidate));
        if (resolved) imports.push(resolved);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  edges.set(file, imports);
}
const reachable = new Set();
function follow(file) {
  if (reachable.has(file)) return;
  reachable.add(file);
  for (const dependency of edges.get(file) ?? []) follow(dependency);
}
for (const entry of ['main.tsx', 'main.jsx', 'appearanceBoot.ts']) if (known.has(path.join(root, entry))) follow(path.join(root, entry));
// Ambient declarations are additional type roots, even without a runtime import.
for (const file of files) if (file.endsWith('.d.ts')) follow(file);
console.log(JSON.stringify({ total: files.length, reachable: reachable.size,
  unreachable: files.filter(file => !reachable.has(file)).map(file => path.relative(root, file).replaceAll('\\', '/')) }, null, 2));

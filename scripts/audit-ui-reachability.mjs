// Report source modules unreachable from the production entry point. Tests and
// CSS are deliberately excluded as roots: a test alone does not ship a feature.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../ui/src/', import.meta.url));
const files = [];
const testFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.[cm]?[jt]sx?$/.test(file)) {
      (/\.(test|spec)\./.test(file) ? testFiles : files).push(file);
    }
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
const relative = file => path.relative(root, file).replaceAll('\\', '/');
const report = { total: files.length, reachable: reachable.size,
  unreachable: files.filter(file => !reachable.has(file)).map(relative) };

// File-level graphs follow every re-export, even when nobody imports the
// exported component. Resolve actual import bindings through barrels as a
// second, conservative report; retain test consumers and side-effect imports.
if (process.argv.includes('--exports')) {
  const configPath = fileURLToPath(new URL('../ui/tsconfig.json', import.meta.url));
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram([...files, ...testFiles], options);
  const checker = program.getTypeChecker();
  const direct = new Set();
  const consumed = new Set();
  const consume = symbol => {
    if (!symbol) return;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    for (const declaration of symbol.declarations ?? []) consumed.add(path.resolve(declaration.getSourceFile().fileName));
  };
  const importModule = node => {
    const symbol = checker.getSymbolAtLocation(node);
    for (const declaration of symbol?.declarations ?? []) direct.add(path.resolve(declaration.getSourceFile().fileName));
    return symbol;
  };
  for (const source of program.getSourceFiles()) {
    const file = path.resolve(source.fileName);
    if (!reachable.has(file) && !testFiles.includes(file)) continue;
    const visit = node => {
      if (ts.isImportDeclaration(node)) {
        const module = importModule(node.moduleSpecifier);
        const clause = node.importClause;
        if (clause?.name) consume(checker.getSymbolAtLocation(clause.name));
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) consume(checker.getSymbolAtLocation(element.name));
        } else if (bindings && module) {
          for (const symbol of checker.getExportsOfModule(module)) consume(symbol);
        }
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0]) {
        importModule(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  report.barrelOnly = files.filter(file => {
    if (!reachable.has(file) || direct.has(file) || consumed.has(file)) return false;
    const source = program.getSourceFile(file);
    const module = source && checker.getSymbolAtLocation(source);
    // A pure barrel has no implementation to remove. Inspect its leaf modules.
    return module && checker.getExportsOfModule(module).some(symbol =>
      (symbol.declarations ?? []).some(declaration =>
        path.resolve(declaration.getSourceFile().fileName) === file
        && !ts.isExportSpecifier(declaration) && !ts.isExportDeclaration(declaration)));
  }).map(relative);
}
console.log(JSON.stringify(report, null, 2));

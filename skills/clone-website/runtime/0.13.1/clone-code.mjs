import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { canonicalJson, sha256 } from './run-store.mjs';

export const CLONE_CODE_SCHEMA_VERSION = 1;

const STATE_HOOKS = new Set(['useState', 'useReducer']);
const UNUSED_DIAGNOSTICS = new Set([6133, 6198]);
const NODE_MODULES = /[\\/]node_modules[\\/]/u;

// The audit uses the clone's own TypeScript so that analysis matches its build.
export function loadTypeScript(root) {
  for (const base of [join(resolve(root), 'package.json'), import.meta.url]) {
    try {
      return createRequire(base)('typescript');
    } catch {
      // Try the next resolver.
    }
  }
  throw new Error('TypeScript is not installed in the clone repository; install it before running audit clone-code');
}

function hookName(ts, expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function enclosingFunctionName(ts, node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current))
      && ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
  }
  return null;
}

function bindingName(ts, element) {
  return element && ts.isBindingElement(element) && ts.isIdentifier(element.name) ? element.name : null;
}

function unwrapInitializer(ts, expression) {
  let current = expression;
  let typeNode = null;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current))) {
    if (ts.isSatisfiesExpression(current)) typeNode ??= current.type;
    current = current.expression;
  }
  return { expression: current, typeNode };
}

function propertyNames(checker, type) {
  return checker.getPropertiesOfType(type).map((property) => property.getName()).sort();
}

export function auditCloneCode({ root = process.cwd(), typescript = null } = {}) {
  const rootPath = resolve(root);
  const ts = typescript ?? loadTypeScript(rootPath);
  const configPath = join(rootPath, 'tsconfig.json');
  if (!existsSync(configPath)) throw new Error(`No tsconfig.json found in ${rootPath}`);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true, noUnusedLocals: true, incremental: false, tsBuildInfoFile: undefined },
  });
  const checker = program.getTypeChecker();
  const files = program.getSourceFiles().filter((file) => !file.isDeclarationFile
    && !NODE_MODULES.test(file.fileName)
    && !relative(rootPath, file.fileName).startsWith('..'));
  const findings = [];
  const registries = [];

  for (const file of files) {
    const filePath = relative(rootPath, file.fileName).split('\\').join('/');
    const unused = new Set(program.getSemanticDiagnostics(file)
      .filter((diagnostic) => UNUSED_DIAGNOSTICS.has(diagnostic.code) && diagnostic.file === file && diagnostic.start !== undefined)
      .map((diagnostic) => diagnostic.start));
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isArrayBindingPattern(node.name) && ts.isCallExpression(node.initializer)) {
          const hook = hookName(ts, node.initializer.expression);
          if (hook && STATE_HOOKS.has(hook)) {
            const [valueElement, setterElement] = node.name.elements;
            const valueName = bindingName(ts, valueElement);
            const setterName = bindingName(ts, setterElement);
            const patternUnused = unused.has(node.name.getStart(file));
            const reason = valueElement && ts.isOmittedExpression(valueElement) && setterName
              ? 'value-omitted'
              : valueName && (patternUnused || unused.has(valueName.getStart(file)))
                ? 'value-never-read'
                : null;
            if (reason) {
              findings.push({
                category: 'state-never-read',
                subject: {
                  file: filePath,
                  hook,
                  component: enclosingFunctionName(ts, node),
                  value: valueName?.text ?? null,
                  setter: setterName?.text ?? null,
                },
                reason,
                line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
                status: 'open',
              });
            }
          }
        }
        const { expression, typeNode } = unwrapInitializer(ts, node.initializer);
        const declaredType = node.type ?? typeNode;
        if (declaredType && ts.isIdentifier(node.name) && ts.isObjectLiteralExpression(expression)) {
          const type = checker.getTypeFromTypeNode(declaredType);
          // Only mapped key domains such as Record<Union, T> or Partial<...>
          // describe a registry; interfaces like CSS property bags do not.
          if (type.flags & ts.TypeFlags.Object && ts.getObjectFlags(type) & ts.ObjectFlags.Mapped && !checker.getIndexInfosOfType(type).length) {
            const domain = propertyNames(checker, type);
            const provided = propertyNames(checker, checker.getTypeAtLocation(expression));
            if (domain.length >= 2 && provided.every((key) => domain.includes(key))) {
              registries.push({
                name: node.name.text,
                file: filePath,
                line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
                domain,
                provided,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  const byDomain = new Map();
  for (const registry of registries) {
    const key = canonicalJson(registry.domain);
    if (!byDomain.has(key)) byDomain.set(key, []);
    byDomain.get(key).push(registry);
  }
  for (const group of byDomain.values()) {
    if (group.length < 2) continue;
    const union = [...new Set(group.flatMap((registry) => registry.provided))].sort();
    for (const registry of group) {
      const missing = union.filter((key) => !registry.provided.includes(key));
      if (!missing.length) continue;
      findings.push({
        category: 'registry-key-mismatch',
        subject: {
          registry: `${registry.file}#${registry.name}`,
          domain: sha256(canonicalJson(registry.domain)).slice(0, 12),
        },
        observed: {
          missing,
          provided: registry.provided.length,
          domain: registry.domain.length,
          siblings: group.filter((entry) => entry !== registry).map((entry) => ({ registry: `${entry.file}#${entry.name}`, provided: entry.provided.length })),
        },
        line: registry.line,
        status: 'open',
      });
    }
  }

  return {
    schemaVersion: CLONE_CODE_SCHEMA_VERSION,
    kind: 'clone-code-audit',
    typescriptVersion: ts.version,
    checks: ['state-never-read', 'registry-key-mismatch'],
    filesAnalyzed: files.length,
    registriesAnalyzed: registries.length,
    complete: true,
    findings,
  };
}

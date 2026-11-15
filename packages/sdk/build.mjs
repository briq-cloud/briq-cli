// Builds the published package into dist/ (or the directory passed as the first argument):
//   index.js     one ESM file whose only import besides Node's is `ws`, the one dependency
//   index.d.ts   the declarations of every file behind src/index.ts in one file, with the types of
//                @briq/public written out: a consumer needs no @types package and no other package
// @briq/public is not published. The SDK only imports its types, so no code of it goes into
// the bundle and zod, which that package is made of, is not a dependency.
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const PUBLIC = '@briq/public';
const ENTRY = resolve(root, 'src/index.ts');

/** The declarations of every file, as the compiler emits them: file name (`index.d.ts`) → text. */
function compile() {
  const config = ts.getParsedCommandLineOfConfigFile(
    resolve(root, 'tsconfig.json'),
    { declaration: true, emitDeclarationOnly: true, noEmit: false },
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      },
    },
  );
  const program = ts.createProgram([ENTRY], config.options);
  const failures = ts.getPreEmitDiagnostics(program);
  if (failures.length) throw new Error(ts.formatDiagnostics(failures, ts.createCompilerHost({})));
  const emitted = new Map();
  program.emit(
    undefined,
    (file, data) => {
      if (file.endsWith('.d.ts')) emitted.set(basename(file), data);
    },
    undefined,
    true,
  );
  return { program, emitted };
}

/** Local name → the text of the type, for each `import type { X } from '@briq/public'` of the sources. */
function writtenTypes(program) {
  const checker = program.getTypeChecker();
  const flags =
    ts.TypeFormatFlags.NoTruncation |
    ts.TypeFormatFlags.InTypeAlias |
    ts.TypeFormatFlags.MultilineObjectLiterals;
  const written = new Map();
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !file.fileName.startsWith(`${root}/src/`)) continue;
    for (const st of file.statements) {
      if (!ts.isImportDeclaration(st) || st.moduleSpecifier.text !== PUBLIC) continue;
      for (const el of st.importClause?.namedBindings?.elements ?? []) {
        const symbol = checker.getAliasedSymbol(checker.getSymbolAtLocation(el.name));
        written.set(
          el.name.text,
          checker.typeToString(checker.getDeclaredTypeOfSymbol(symbol), undefined, flags),
        );
      }
    }
  }
  return written;
}

/**
 * The declarations behind src/index.ts as one file: each file's declarations with its relative
 * imports resolved inside the file, and each type taken from @briq/public written out. Only what
 * index.ts exports is exported.
 */
function declarations({ program, emitted }) {
  const parse = (name) => {
    const text = emitted.get(name);
    if (text === undefined) throw new Error(`no declarations were emitted for ${name}`);
    return ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true);
  };
  const fileOf = (spec) => basename(spec).replace(/\.js$/, '.d.ts');
  const relative = (spec) => spec.startsWith('./');
  const namesOf = (st) =>
    ts.isVariableStatement(st)
      ? st.declarationList.declarations.map((d) => d.name.text)
      : [st.name.text];
  const exportKeyword = (st) => st.modifiers?.find((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const files = new Map();
  const visit = (name) => {
    if (files.has(name)) return;
    const file = parse(name);
    files.set(name, file);
    for (const st of file.statements)
      if (
        (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) &&
        st.moduleSpecifier &&
        relative(st.moduleSpecifier.text)
      )
        visit(fileOf(st.moduleSpecifier.text));
  };
  visit('index.d.ts');

  const exported = new Set();
  for (const st of files.get('index.d.ts').statements) {
    if (ts.isExportDeclaration(st)) {
      if (!st.exportClause || !ts.isNamedExports(st.exportClause))
        throw new Error('index.ts re-exports with `export *`');
      for (const el of st.exportClause.elements) {
        if (el.propertyName) throw new Error(`index.ts renames ${el.propertyName.text}`);
        exported.add(el.name.text);
      }
    } else if (exportKeyword(st)) for (const n of namesOf(st)) exported.add(n);
  }

  const declared = new Set();
  const written = writtenTypes(program);
  let body = '';
  for (const [name, text] of written) {
    declared.add(name);
    body += `${exported.has(name) ? 'export ' : ''}type ${name} = ${text};\n`;
  }
  for (const [name, file] of files) {
    for (const st of file.statements) {
      if (ts.isImportDeclaration(st)) {
        const spec = st.moduleSpecifier.text;
        if (spec !== PUBLIC && !relative(spec)) throw new Error(`${name} imports ${spec}`);
        continue;
      }
      if (ts.isExportDeclaration(st)) continue;
      for (const n of namesOf(st)) {
        if (declared.has(n)) throw new Error(`${n} is declared twice in the declarations`);
        declared.add(n);
      }
      const modifier = exportKeyword(st);
      const lead = file.text.slice(st.getFullStart(), st.getStart(file));
      const rest = file.text.slice(modifier ? modifier.end : st.getStart(file), st.getEnd());
      const isExported = namesOf(st).some((n) => exported.has(n));
      body += `${lead}${isExported ? 'export ' : ''}${rest.trimStart()}\n`.replace(
        /import\("\.\/[^"]+"\)\./g,
        '',
      );
    }
  }
  for (const n of exported)
    if (!declared.has(n)) throw new Error(`${n} is exported but declared nowhere`);
  // `export {}` keeps the declarations that are not exported private to the file.
  return `${body}export {};\n`;
}

export async function buildSdk(outDir = resolve(root, 'dist')) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: { index: 'src/index.ts' },
    outdir: outDir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: `node${pkg.engines.node.replace(/^>=/, '').split('.')[0]}`,
    external: Object.keys(pkg.dependencies ?? {}),
    metafile: true,
    logLevel: 'warning',
  });
  const dts = declarations(compile());
  if (dts.includes(PUBLIC) || /\bfrom ['"]ws['"]|\bimport\(/.test(dts))
    throw new Error('index.d.ts still names another package or file');
  await writeFile(resolve(outDir, 'index.d.ts'), dts);
  return result.metafile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildSdk(process.argv[2]);

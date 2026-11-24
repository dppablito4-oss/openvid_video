import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');

// Execute application code with controlled browser/service boundaries. No
// network, email, database or media permissions are needed for these regressions.
export function loadSource(file, { mocks = {}, globals = {}, expose = [] } = {}) {
    const filename = path.resolve(root, file);
    const loadedModule = { exports: {} };
    const sandbox = {
        module: loadedModule, exports: loadedModule.exports, console, Buffer, Blob, File,
        Request, Response, Headers, Uint8Array, ArrayBuffer, Float32Array,
        setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
        process: { env: {} },
        require(id) {
            if (Object.hasOwn(mocks, id)) return mocks[id];
            if (id.startsWith('@/') || id.startsWith('.')) {
                const target = id.startsWith('@/') ? path.resolve(root, id.slice(2)) : path.resolve(path.dirname(filename), id);
                const candidate = [target, `${target}.ts`, `${target}.tsx`].find(p => fs.existsSync(p) && fs.statSync(p).isFile());
                return loadSource(candidate, { mocks, globals });
            }
            return require(id);
        },
        ...globals,
    };
    const source = fs.readFileSync(filename, 'utf8') + `\nObject.assign(exports, {${expose.join(',')}});`;
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
    vm.runInNewContext(compiled.outputText, sandbox, { filename });
    return loadedModule.exports;
}

// Exercise private editor callbacks in isolation without mounting the entire
// WebGL editor. Callback bodies come directly from the application source.
export function loadCallbacks(file, names, globals = {}) {
    const filename = path.resolve(root, file);
    const tree = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declarations = [];
    function visit(node) {
        if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(tree))) {
            const initializer = node.initializer;
            const callback = ts.isCallExpression(initializer) ? initializer.arguments[0] : initializer;
            declarations.push(`var ${node.name.getText(tree)} = ${callback.getText(tree)};`);
        }
        ts.forEachChild(node, visit);
    }
    visit(tree);
    const context = vm.createContext({ console, ...globals });
    vm.runInContext(ts.transpile(declarations.join('\n'), { target: ts.ScriptTarget.ES2022 }), context);
    return context;
}

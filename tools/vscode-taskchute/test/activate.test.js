/* extension.js の activate() が例外なく通り、コマンドが全部登録されるか */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const EXT = require('path').join(__dirname, '..');

const registered = [];
const stub = {
  ViewColumn: { One: 1 },
  StatusBarAlignment: { Left: 1 },
  Uri: { file: (p) => ({ fsPath: p }), parse: (s) => ({ toString: () => s }) },
  env: { openExternal: async () => true },
  commands: {
    registerCommand: (id, fn) => {
      registered.push(id);
      return { dispose() {} };
    },
    executeCommand: async () => {},
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: () => undefined }),
    openTextDocument: async () => ({}),
  },
  window: {
    activeTextEditor: null,
    createWebviewPanel: () => ({
      webview: { cspSource: 'x', asWebviewUri: (u) => u, postMessage: () => {}, onDidReceiveMessage: () => ({ dispose() {} }) },
      reveal() {}, onDidDispose: () => ({ dispose() {} }), set html(v) {},
    }),
    createStatusBarItem: () => ({ show() {}, dispose() {}, text: '', tooltip: '', command: '' }),
    showErrorMessage: (m) => { console.log('  [error]', m); return Promise.resolve(); },
    showWarningMessage: () => Promise.resolve(),
    showInformationMessage: () => Promise.resolve(),
    setStatusBarMessage: () => {},
    showQuickPick: async () => null,
    showInputBox: async () => undefined,
    showOpenDialog: async () => null,
    showTextDocument: async () => ({}),
  },
};

const orig = Module._load;
Module._load = function (r) {
  return r === 'vscode' ? stub : orig.apply(this, arguments);
};

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { console.log('  NG  ' + name + '  -> ' + e.message); process.exitCode = 1; }
}

console.log('# extension.js の起動');

const ext = require(EXT + '/src/extension');
const ctx = { extensionPath: EXT, subscriptions: [] };

ok('activate() が例外を投げない', () => {
  ext.activate(ctx);
});

const pkgRaw = fs.readFileSync(EXT + '/package.json');

ok('package.json に BOM が付いていない', () => {
  // BOM があると JSON.parse も VS Code のマニフェスト読み込みも失敗し、
  // 拡張機能ごと読み込まれなくなる (command not found になる)
  const bom = pkgRaw[0] === 0xef && pkgRaw[1] === 0xbb && pkgRaw[2] === 0xbf;
  assert.strictEqual(bom, false, 'package.json の先頭に BOM がある');
});

const pkg = JSON.parse(pkgRaw.toString('utf8'));
const declared = pkg.contributes.commands.map((c) => c.command);

ok('engines.vscode が緩すぎず厳しすぎない', () => {
  const m = /^\^?(\d+)\.(\d+)\./.exec(pkg.engines.vscode);
  assert.ok(m, 'engines.vscode の書式: ' + pkg.engines.vscode);
  const minor = Number(m[2]);
  assert.ok(minor <= 70, `engines.vscode が新しすぎる (${pkg.engines.vscode})。古い VS Code で読み込まれなくなる`);
});

ok('package.json の全コマンドが登録される', () => {
  const missing = declared.filter((c) => !registered.includes(c));
  assert.deepStrictEqual(missing, [], '未登録: ' + missing.join(', '));
});

ok('登録したのに宣言していないコマンドが無い', () => {
  const extra = registered.filter((c) => !declared.includes(c));
  assert.deepStrictEqual(extra, [], '宣言漏れ: ' + extra.join(', '));
});

ok('キーバインドの参照先が全部実在する', () => {
  const keys = pkg.contributes.keybindings || [];
  const broken = keys.filter((k) => !declared.includes(k.command));
  assert.deepStrictEqual(broken.map((k) => k.command), [], 'コマンドが無いキーバインド');
});

ok('Ctrl+Alt+D がデイリーノートに割り当たっている', () => {
  const k = (pkg.contributes.keybindings || []).find((x) => x.key === 'ctrl+alt+d');
  assert.ok(k, 'ctrl+alt+d のキーバインドが無い');
  assert.strictEqual(k.command, 'taskchute.openDailyNote');
  assert.ok(registered.includes('taskchute.openDailyNote'), 'コマンドが登録されていない');
});

ok('deactivate() も例外を投げない', () => {
  ext.deactivate();
});

console.log('\n  宣言コマンド: ' + declared.length + ' / 登録コマンド: ' + registered.length);
console.log('  登録された順: ' + registered.join(', '));

Module._load = orig;
console.log(`\n${pass} 件成功` + (process.exitCode ? ' / 失敗あり' : ' / 失敗なし'));

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

const pkg = JSON.parse(fs.readFileSync(EXT + '/package.json', 'utf8'));
const declared = pkg.contributes.commands.map((c) => c.command);

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

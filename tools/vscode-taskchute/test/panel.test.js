/* panel.js を vscode API のスタブで通しで動かす */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const EXT = require('path').join(__dirname, '..');

// ---- vscode スタブ -------------------------------------------------------
const sent = [];
const notices = [];
let quickPickAnswer = null;
let inputBoxAnswer = null;
let warningAnswer = null;

const fakeWebview = {
  cspSource: 'vscode-webview://x',
  html: '',
  asWebviewUri: (u) => ({ toString: () => 'vscode-resource:' + u.fsPath }),
  postMessage: (m) => {
    sent.push(m);
    return Promise.resolve(true);
  },
  onDidReceiveMessage: (cb) => {
    fakeWebview._cb = cb;
    return { dispose() {} };
  },
};
const fakePanel = {
  webview: fakeWebview,
  reveal() {},
  onDidDispose: () => ({ dispose() {} }),
  dispose() {},
  set html(v) {},
};

const vscodeStub = {
  ViewColumn: { One: 1 },
  StatusBarAlignment: { Left: 1 },
  Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }), parse: (s) => ({ toString: () => s }) },
  env: { openExternal: async () => true },
  commands: { executeCommand: async () => {}, registerCommand: () => ({ dispose() {} }) },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: () => undefined }),
    openTextDocument: async (u) => ({ uri: u }),
  },
  window: {
    createWebviewPanel: () => Object.assign(Object.create(Object.getPrototypeOf(fakePanel)), fakePanel),
    showErrorMessage: (m) => { notices.push(['error', m]); return Promise.resolve(undefined); },
    showWarningMessage: (m) => { notices.push(['warn', m]); return Promise.resolve(warningAnswer); },
    showInformationMessage: (m) => { notices.push(['info', m]); return Promise.resolve(undefined); },
    setStatusBarMessage: (m) => notices.push(['status', m]),
    showQuickPick: async () => quickPickAnswer,
    showInputBox: async () => inputBoxAnswer,
    showTextDocument: async () => ({}),
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
  },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};

const M = require(EXT + '/src/model');
const { Store } = require(EXT + '/src/store');
const { TaskChutePanel } = require(EXT + '/src/panel');

// ---- 準備 ---------------------------------------------------------------
const tmp = path.join(os.tmpdir(), 'tc-panel-' + Date.now());
const store = new Store(tmp, '.taskchute');
store.loadConfig();
const openedNotes = [];
const ctx = { extensionPath: EXT, subscriptions: [] };
const panel = new TaskChutePanel(ctx, store, async (d) => openedNotes.push(d));

let pass = 0;
function ok(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('同期テストのみ');
    pass++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.log('  NG  ' + name + '  -> ' + e.message);
    process.exitCode = 1;
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.log('  NG  ' + name + '  -> ' + e.message);
    process.exitCode = 1;
  }
}
const lastState = () => [...sent].reverse().find((m) => m.type === 'state');
const send = (m) => panel.handle(m);

(async () => {
  console.log('# パネルの起動');
  panel.reveal();
  ok('Webview を開くと state が飛ぶ', () => {
    const s = lastState();
    assert.ok(s, 'state が来ていない');
    assert.strictEqual(s.payload.baseDate, M.todayStr());
    assert.strictEqual(s.payload.rows.length, 0);
    assert.ok(s.payload.config.sections.length >= 3);
  });
  ok('HTML に CSP と media が入っている', () => {
    const html = panel.html();
    assert.ok(html.includes('Content-Security-Policy'));
    assert.ok(html.includes('main.js'));
    assert.ok(html.includes('main.css'));
    assert.ok(/nonce-[a-z0-9]+/.test(html));
  });

  const today = M.todayStr();

  console.log('# タスクの追加と編集');
  await okAsync('add でタスクが増え、ファイルに保存される', async () => {
    await send({ type: 'add', id: null, position: 'above' });
    assert.strictEqual(panel.tasks.length, 1);
    assert.ok(fs.existsSync(store.dayPath(today)));
    assert.strictEqual(store.loadDay(today).length, 1);
  });

  const id1 = panel.tasks[0].id;
  await okAsync('patch で名前・見積・Project が入る', async () => {
    await send({ type: 'patch', id: id1, patch: { name: 'メールチェック', project: 'Work', estimateMin: '15', section: 'B' } });
    const t = store.loadDay(today)[0];
    assert.strictEqual(t.name, 'メールチェック');
    assert.strictEqual(t.estimateMin, 15, '文字列の "15" が数値になる');
    assert.strictEqual(t.project, 'Work');
  });

  await okAsync('見積H で入れると分に直る (H と M は連動)', async () => {
    await send({ type: 'patch', id: id1, patch: { estimateHour: '1.5' } });
    assert.strictEqual(panel.tasks[0].estimateMin, 90);
    await send({ type: 'patch', id: id1, patch: { estimateMin: '15' } });
    assert.strictEqual(panel.tasks[0].estimateMin, 15);
  });

  console.log('# 打刻');
  await okAsync('開始を打刻すると現在時刻が入る', async () => {
    await send({ type: 'stamp', id: id1, field: 'start' });
    assert.match(panel.tasks[0].start, /^\d{2}:\d{2}$/);
    assert.strictEqual(panel.tasks[0].end, '');
    const row = lastState().payload.rows[0];
    assert.strictEqual(row.status, '□');
    assert.strictEqual(row.done, false);
  });

  await okAsync('終了を打刻すると完了になり実績が出る', async () => {
    await send({ type: 'patch', id: id1, patch: { start: '09:00' } });
    await send({ type: 'patch', id: id1, patch: { end: '09:22' } });
    const row = lastState().payload.rows[0];
    assert.strictEqual(row.status, '■');
    assert.strictEqual(row.actualMin, 22);
    assert.strictEqual(row.done, true);
  });

  await okAsync('直前の終了時刻を開始に転記できる (Ctrl+T 相当)', async () => {
    await send({ type: 'add', id: null, position: 'above' });
    const id2 = panel.tasks.find((t) => t.id !== id1).id;
    await send({ type: 'patch', id: id2, patch: { name: '朝のレシピ' } });
    // 転記元が上に来るように並べ替えてから
    const idxNew = panel.tasks.findIndex((t) => t.id === id2);
    if (idxNew === 0) await send({ type: 'move', id: id2, dir: 'down' });
    await send({ type: 'carryStart', id: id2 });
    const t2 = panel.tasks.find((t) => t.id === id2);
    assert.strictEqual(t2.start, '09:22', '直前タスクの終了 09:22 が入る');
  });

  console.log('# 集計');
  await okAsync('終了予定時刻 = 現在 + 未完了の見積', async () => {
    const id2 = panel.tasks.find((t) => t.id !== id1).id;
    await send({ type: 'patch', id: id2, patch: { estimateMin: '60', start: '', end: '' } });
    const p = lastState().payload;
    assert.strictEqual(p.summary.estMin, 75);
    assert.strictEqual(p.summary.doneMin, 15);
    assert.strictEqual(p.summary.remainMin, 60);
    assert.strictEqual(p.summary.etaMin, p.nowMin + 60);
  });

  console.log('# 画面へ渡す状態');
  await okAsync('列の定義と現在の節が含まれる', async () => {
    const p = lastState().payload;
    assert.ok(Array.isArray(p.columns), 'columns が配列');
    assert.strictEqual(p.columns[0].key, 'status');
    assert.ok(p.columns.some((c) => c.key === 'name' && c.visible === true));
    assert.ok(p.columns.some((c) => c.key === 'hint' && c.visible === false), 'ヒントは既定で非表示');
    assert.ok(!p.columns.some((c) => c.key === 'estimateHour'), '見積H の列は無い');
    assert.ok('currentSection' in p, '現在の節が入っている');
    assert.ok(Array.isArray(p.busyDates), 'カレンダーの点用の日付一覧');
  });

  await okAsync('月日は 09/06(日) の形で渡る', async () => {
    const p = lastState().payload;
    const row = p.rows[0];
    assert.match(row.dateLabel, /^\d{2}\/\d{2} (Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/, row.dateLabel);
  });

  await okAsync('実行中の行に経過時間が付く', async () => {
    await send({ type: 'add', id: null, position: 'above' });
    const t = panel.tasks.find((x) => !x.name);
    await send({ type: 'patch', id: t.id, patch: { name: '実行中テスト', start: M.minToHhmm(M.nowMin() - 12) } });
    const row = lastState().payload.rows.find((x) => x.id === t.id);
    assert.strictEqual(row.running, true);
    assert.strictEqual(row.elapsedMin, 12);
    await send({ type: 'patch', id: t.id, patch: { end: M.nowHhmm() } });
    const row2 = lastState().payload.rows.find((x) => x.id === t.id);
    assert.strictEqual(row2.running, false, '終了したら実行中ではない');
    assert.strictEqual(row2.elapsedMin, null);
  });

  console.log('# セルの短縮入力');
  await okAsync('月日セルに 9/7 や +1 を打てる', async () => {
    await send({ type: 'add', id: null, position: 'above' });
    const t = panel.tasks.find((x) => !x.name);
    await send({ type: 'patch', id: t.id, patch: { name: '短縮入力テスト' } });
    await send({ type: 'patch', id: t.id, patch: { dateText: '+2' } });
    let hit = panel.tasks.find((x) => x.name === '短縮入力テスト');
    assert.strictEqual(hit.date, M.addDays(today, 2));
    await send({ type: 'patch', id: hit.id, patch: { dateText: '0' } });
    hit = panel.tasks.find((x) => x.name === '短縮入力テスト');
    assert.strictEqual(hit.date, today, '0 で基準日に戻る');
  });

  await okAsync('解釈できない月日は無視する', async () => {
    const t = panel.tasks.find((x) => x.name === '短縮入力テスト');
    const before = t.date;
    await send({ type: 'patch', id: t.id, patch: { dateText: 'あいう' } });
    assert.strictEqual(panel.tasks.find((x) => x.name === '短縮入力テスト').date, before);
  });

  await okAsync('見積セルに 1.5h や 1:30 を打てる', async () => {
    const t = panel.tasks.find((x) => x.name === '短縮入力テスト');
    await send({ type: 'patch', id: t.id, patch: { estimateText: '1.5h' } });
    assert.strictEqual(panel.tasks.find((x) => x.id === t.id).estimateMin, 90);
    await send({ type: 'patch', id: t.id, patch: { estimateText: '1:30' } });
    assert.strictEqual(panel.tasks.find((x) => x.id === t.id).estimateMin, 90);
    await send({ type: 'patch', id: t.id, patch: { estimateText: '45' } });
    assert.strictEqual(panel.tasks.find((x) => x.id === t.id).estimateMin, 45);
    await send({ type: 'patch', id: t.id, patch: { estimateText: '' } });
    assert.strictEqual(panel.tasks.find((x) => x.id === t.id).estimateMin, null, '空欄で未設定に戻る');
    await send({ type: 'patch', id: t.id, patch: { estimateText: 'あ' } });
    assert.strictEqual(panel.tasks.find((x) => x.id === t.id).estimateMin, null, '読めない入力は無視');
  });

  console.log('# 期限 (due)');
  await okAsync('期限を短縮入力で入れて、空欄で消せる', async () => {
    const t = panel.tasks.find((x) => x.name === '短縮入力テスト');
    await send({ type: 'patch', id: t.id, patch: { dueText: '+3' } });
    assert.strictEqual(panel.tasks.find((x) => x.id === t.id).due, M.addDays(today, 3));
    const row = lastState().payload.rows.find((x) => x.id === t.id);
    assert.match(row.dueLabel, /^\d{2}\/\d{2} (Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/, row.dueLabel);
    assert.strictEqual(row.dueState, 'later');
    await send({ type: 'patch', id: t.id, patch: { dueText: '' } });
    assert.strictEqual(panel.tasks.find((x) => x.id === t.id).due, '', '空欄で期限なしに戻る');
    assert.strictEqual(lastState().payload.rows.find((x) => x.id === t.id).dueLabel, '');
  });

  await okAsync('読めない期限は無視する', async () => {
    const t = panel.tasks.find((x) => x.name === '短縮入力テスト');
    await send({ type: 'patch', id: t.id, patch: { dueText: '2026-09-20' } });
    await send({ type: 'patch', id: t.id, patch: { dueText: 'あいう' } });
    assert.strictEqual(panel.tasks.find((x) => x.id === t.id).due, '2026-09-20');
  });

  await okAsync('期限切れ・当日の件数がヘッダに渡る', async () => {
    const t = panel.tasks.find((x) => x.name === '短縮入力テスト');
    await send({ type: 'patch', id: t.id, patch: { dueText: M.addDays(today, -1) } });
    const a = lastState().payload.dueAlert;
    assert.strictEqual(a.overdue, 1);
    assert.strictEqual(a.total, 1);
    await send({ type: 'patch', id: t.id, patch: { dueText: today } });
    assert.strictEqual(lastState().payload.dueAlert.today, 1);
    await send({ type: 'patch', id: t.id, patch: { dueText: '' } });
    assert.strictEqual(lastState().payload.dueAlert.total, 0);
  });

  console.log('# タスクに紐づくメモ');
  await okAsync('メモが無ければテンプレートを選んで作り、紐づける', async () => {
    await send({ type: 'add', id: null, position: 'above' });
    const t = panel.tasks.find((x) => !x.name);
    await send({ type: 'patch', id: t.id, patch: { name: '定例ミーティング', project: 'Work' } });
    assert.strictEqual(panel.tasks.find((x) => x.id === t.id).notePath, '', '最初は紐づいていない');

    quickPickAnswer = { label: '会議', fsPath: path.join(tmp, '80_tamplate', 'task', '会議.md') };
    await send({ type: 'openNote', id: t.id });

    const after = panel.tasks.find((x) => x.id === t.id);
    assert.strictEqual(after.notePath, `notes/${today}-定例ミーティング.md`);
    const body = fs.readFileSync(path.join(tmp, after.notePath), 'utf8');
    assert.ok(body.startsWith('# 定例ミーティング'), body.slice(0, 40));
    assert.ok(body.includes('## 決まったこと'), '選んだテンプレートが使われる');
    const row = lastState().payload.rows.find((x) => x.id === t.id);
    assert.strictEqual(row.hasNote, true, 'メモ列に印が出る');
  });

  await okAsync('2 回目は作り直さず、同じメモを開く', async () => {
    const t = panel.tasks.find((x) => x.name === '定例ミーティング');
    const before = t.notePath;
    const files = fs.readdirSync(path.join(tmp, 'notes')).length;
    quickPickAnswer = null; // 選択肢は出ないはず
    await send({ type: 'openNote', id: t.id });
    assert.strictEqual(panel.tasks.find((x) => x.id === t.id).notePath, before);
    assert.strictEqual(fs.readdirSync(path.join(tmp, 'notes')).length, files, 'ファイルが増えない');
  });

  await okAsync('テンプレート選択を中止したらメモを作らない', async () => {
    await send({ type: 'add', id: null, position: 'above' });
    const t = panel.tasks.find((x) => !x.name);
    await send({ type: 'patch', id: t.id, patch: { name: '中止テスト' } });
    const files = fs.readdirSync(path.join(tmp, 'notes')).length;
    quickPickAnswer = undefined; // Esc
    await send({ type: 'openNote', id: t.id });
    assert.strictEqual(panel.tasks.find((x) => x.id === t.id).notePath, '', '紐づかない');
    assert.strictEqual(fs.readdirSync(path.join(tmp, 'notes')).length, files, 'ファイルも増えない');
    warningAnswer = 'Delete';
    await send({ type: 'delete', id: t.id });
    warningAnswer = undefined;
  });

  await okAsync('メモ列を空欄にすると紐づけを外せる (ファイルは消さない)', async () => {
    const t = panel.tasks.find((x) => x.name === '定例ミーティング');
    const fsPath = path.join(tmp, t.notePath);
    await send({ type: 'patch', id: t.id, patch: { notePath: '' } });
    assert.strictEqual(panel.tasks.find((x) => x.id === t.id).notePath, '');
    assert.strictEqual(lastState().payload.rows.find((x) => x.id === t.id).hasNote, false);
    assert.ok(fs.existsSync(fsPath), 'メモの実体は残す');
  });

  console.log('# 絞り込み');
  await okAsync('未完了だけ表示にすると、完了と翌日以降が消える', async () => {
    await send({ type: 'clearFilter' });
    // 前提を作る: 翌日のタスクを 1 件置く (完了タスクは既にある)
    await send({ type: 'add', id: null, position: 'above' });
    const fut = panel.tasks.find((x) => !x.name);
    await send({ type: 'patch', id: fut.id, patch: { name: '明日のタスク' } });
    await send({ type: 'patch', id: fut.id, patch: { dateText: '+1' } });

    const before = lastState().payload;
    assert.strictEqual(before.filter.active, false);
    assert.ok(before.rows.some((r) => r.done), '前提: 完了タスクが表に出ている');
    assert.ok(before.rows.some((r) => r.status === '◎'), '前提: 翌日以降が表に出ている');

    await send({ type: 'toggleOnlyPending' });
    const p = lastState().payload;
    assert.strictEqual(p.filter.onlyPending, true);
    assert.strictEqual(p.filter.active, true);
    assert.ok(!p.rows.some((r) => r.done), '完了が消える');
    assert.ok(!p.rows.some((r) => r.status === '◎'), '翌日以降が消える');
    assert.ok(p.filter.shown < p.filter.total, `${p.filter.total}件中 ${p.filter.shown}件`);
  });

  await okAsync('絞り込んでも集計は一日ぶん全部で計算する', async () => {
    const filtered = lastState().payload;
    await send({ type: 'toggleOnlyPending' }); // 解除
    const all = lastState().payload;
    assert.deepStrictEqual(filtered.summary, all.summary, '見積・消化・残・終了予定が変わらない');
    assert.deepStrictEqual(filtered.sections, all.sections, '節別サマリーも変わらない');
  });

  await okAsync('Project で絞れる', async () => {
    await send({ type: 'clearFilter' });
    quickPickAnswer = { label: 'Work', value: 'Work' };
    await send({ type: 'filterBy', field: 'project' });
    const p = lastState().payload;
    assert.strictEqual(p.filter.project, 'Work');
    assert.ok(p.rows.length > 0, '1件は残る');
    assert.ok(p.rows.every((r) => r.project === 'Work'), 'Work 以外が消える');
  });

  await okAsync('Mode でも絞れて、条件は重ねられる', async () => {
    quickPickAnswer = { label: 'Focus', value: 'Focus' };
    await send({ type: 'filterBy', field: 'mode' });
    const p = lastState().payload;
    assert.strictEqual(p.filter.project, 'Work');
    assert.strictEqual(p.filter.mode, 'Focus');
    assert.ok(p.rows.every((r) => r.project === 'Work' && r.mode === 'Focus'));
  });

  await okAsync('絞り込み中に足したタスクは条件を引き継ぐ', async () => {
    await send({ type: 'add', id: null, position: 'above' });
    const t = panel.tasks.find((x) => !x.name && x.project === 'Work');
    assert.ok(t, '追加したタスクに Project が入る');
    assert.strictEqual(t.mode, 'Focus', 'Mode も引き継ぐ');
    assert.ok(lastState().payload.rows.some((r) => r.id === t.id), '追加直後に消えない');
    await send({ type: 'delete', id: t.id });
  });

  await okAsync('Shift+F ですべて解除される', async () => {
    await send({ type: 'clearFilter' });
    const p = lastState().payload;
    assert.strictEqual(p.filter.active, false);
    assert.strictEqual(p.filter.project, '');
    assert.strictEqual(p.filter.mode, '');
    assert.strictEqual(p.filter.onlyPending, false);
    assert.strictEqual(p.filter.shown, p.filter.total);
  });

  console.log('# アイドリング');
  await okAsync('アイドリングは見積0で挿入され、開始セルの編集を促す', async () => {
    sent.length = 0;
    await send({ type: 'addIdle', id: panel.tasks[0].id });
    const idle = panel.tasks.find((x) => x.name === 'Idling');
    assert.ok(idle, 'アイドリングが挿入される');
    assert.strictEqual(idle.estimateMin, 0);
    const focus = sent.find((m) => m.type === 'editCell');
    assert.ok(focus && focus.col === 'start', '開始セルの編集に入る');
  });

  console.log('# 繰り返し');
  await okAsync('繰り返しを設定して完了させると翌日分ができる', async () => {
    const id2 = panel.tasks.find((t) => t.name === '朝のレシピ').id;
    quickPickAnswer = { label: '毎日', kind: 'daily', interval: 1 };
    await send({ type: 'repeatSettings', id: id2 });
    assert.ok(panel.tasks.find((t) => t.id === id2).repeat, '繰り返しが設定される');

    const tomorrow = M.addDays(today, 1);
    assert.strictEqual(
      store.loadDay(tomorrow).filter((t) => t.name === '朝のレシピ').length,
      0,
      'まだ翌日分は無い'
    );

    await send({ type: 'stamp', id: id2, field: 'end' });
    const next = panel.tasks.filter((t) => t.date === tomorrow && t.name === '朝のレシピ');
    assert.strictEqual(next.length, 1, '翌日分が1件できる');
    assert.strictEqual(next[0].name, '朝のレシピ');
    assert.strictEqual(next[0].start, '', '実績は引き継がない');
    assert.strictEqual(next[0].seriesId, id2);
  });

  await okAsync('同じ系列を二重に複製しない', async () => {
    const id2 = panel.tasks.find((t) => t.date === today && t.name === '朝のレシピ').id;
    const tomorrow = M.addDays(today, 1);
    await send({ type: 'patch', id: id2, patch: { end: '' } });
    await send({ type: 'stamp', id: id2, field: 'end' });
    assert.strictEqual(
      panel.tasks.filter((t) => t.date === tomorrow && t.name === '朝のレシピ').length,
      1
    );
  });

  console.log('# 日付変更と並べ替え');
  await okAsync('日付変更 (w = 1週間後) でファイルが移る', async () => {
    await send({ type: 'add', id: null, position: 'above' });
    const t = panel.tasks.find((x) => !x.name);
    await send({ type: 'patch', id: t.id, patch: { name: '来週の締切' } });
    inputBoxAnswer = 'w';
    await send({ type: 'changeDate', id: t.id });
    const target = M.addDays(today, 7);
    assert.strictEqual(store.loadDay(target).length, 1);
    assert.strictEqual(store.loadDay(target)[0].name, '来週の締切');
    assert.ok(!store.loadDay(today).some((x) => x.name === '来週の締切'));
  });

  await okAsync('区切りタスクは時刻を過ぎたら通常並べ替えで翌日へ', async () => {
    await send({ type: 'add', id: null, position: 'above' });
    const t = panel.tasks.find((x) => !x.name);
    await send({ type: 'patch', id: t.id, patch: { name: '退勤', project: 'Divider', sectionSort: '0001' } });
    await send({ type: 'sort', mode: 'normal' });
    const moved = panel.tasks.find((x) => x.name === '退勤');
    assert.strictEqual(moved.date, M.addDays(today, 1), '00:01 は既に過ぎているので翌日へ');
  });

  await okAsync('並べ替えで ＃ が 10 刻みになる', async () => {
    await send({ type: 'sort', mode: 'fast' });
    const nos = panel.tasks.filter((t) => t.date === today).map((t) => t.no);
    assert.deepStrictEqual(nos, nos.map((_, i) => (i + 1) * 10));
  });

  console.log('# 基準日の移動と表示');
  await okAsync('基準日を翌日に動かすと積み残しが見える', async () => {
    await send({ type: 'shiftBaseDate', delta: 1 });
    const p = lastState().payload;
    assert.strictEqual(p.baseDate, M.addDays(today, 1));
    const past = p.rows.filter((r) => r.status === '★');
    assert.ok(past.length >= 0);
    assert.ok(p.rows.every((r) => !(r.status === '■' && r.date < p.baseDate)), '過去の完了は既定で隠れる');
    await send({ type: 'togglePastDone' });
    const p2 = lastState().payload;
    assert.ok(p2.rows.some((r) => r.status === '■' && r.date < p2.baseDate), '切り替えると出る');
    await send({ type: 'setBaseDate', date: today });
  });

  console.log('# 削除・検索入力・シミュレーション');
  await okAsync('削除は確認が要る', async () => {
    const before = panel.tasks.length;
    warningAnswer = undefined; // キャンセル
    await send({ type: 'delete', id: id1 });
    assert.strictEqual(panel.tasks.length, before, 'キャンセルしたら消えない');
    warningAnswer = 'Delete';
    await send({ type: 'delete', id: id1 });
    assert.strictEqual(panel.tasks.length, before - 1);
  });

  await okAsync('検索入力で過去のタスクを引ける', async () => {
    await send({ type: 'add', id: null, position: 'above' });
    const t = panel.tasks.find((x) => !x.name);
    const idx = store.nameIndex(true);
    const hit = idx.find((n) => n.name === '朝のレシピ');
    assert.ok(hit, '索引に載っている');
    quickPickAnswer = { label: hit.name, entry: hit };
    await send({ type: 'searchName', id: t.id });
    assert.strictEqual(panel.tasks.find((x) => x.id === t.id).name, '朝のレシピ');
  });

  await okAsync('シミュレーションの結果が Webview に返る', async () => {
    const pending = panel.tasks.find((t) => t.date === today && !t.end);
    await send({ type: 'patch', id: pending.id, patch: { estimateMin: '30' } });
    sent.length = 0;
    await send({ type: 'simulate', id: pending.id });
    const sim = sent.find((m) => m.type === 'simulation');
    assert.ok(sim, 'simulation が返らない');
    assert.match(sim.payload.target.end, /^\d{2}:\d{2}$/);
  });

  await okAsync('デイリーノートを開く要求が渡る', async () => {
    await send({ type: 'openDailyNote', date: today });
    assert.deepStrictEqual(openedNotes, [today]);
  });

  console.log('# 再読み込み');
  await okAsync('再読み込みしても内容が保たれる', async () => {
    const before = panel.tasks.filter((t) => t.date === today).map((t) => t.name).sort();
    panel.load();
    const after = panel.tasks.filter((t) => t.date === today).map((t) => t.name).sort();
    assert.deepStrictEqual(after, before);
  });

  ok('エラー通知が出ていない', () => {
    const errs = notices.filter((n) => n[0] === 'error');
    assert.deepStrictEqual(errs, []);
  });

  panel.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
  Module._load = origLoad;
  console.log(`\n${pass} 件成功` + (process.exitCode ? ' / 失敗あり' : ' / 失敗なし'));
})();

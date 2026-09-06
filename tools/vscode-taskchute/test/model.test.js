/* TaskChute 拡張のロジック検証 (VS Code なしで動く部分) */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = require('path').join(__dirname, '..', 'src');
const M = require(base + '/model');
const { Store } = require(base + '/store');
const daily = require(base + '/dailyNote');
const ics = require(base + '/ics');

let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.log('  NG  ' + name + '  -> ' + e.message);
    process.exitCode = 1;
  }
}

console.log('# model: 日付');
ok('addDays / weekday', () => {
  assert.strictEqual(M.addDays('2026-09-06', 1), '2026-09-07');
  assert.strictEqual(M.addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(M.weekdayJa('2026-09-06'), '日');
});
ok('addMonths は月末を丸める', () => {
  assert.strictEqual(M.addMonths('2026-01-31', 1), '2026-02-28');
});
ok('日付変更 (PDF 4.2 の仕様)', () => {
  const b = '2026-01-07';
  assert.strictEqual(M.applyDateChange('2026-01-07', '', b), '2026-01-08', '空欄=翌日');
  assert.strictEqual(M.applyDateChange('2026-01-07', '2', b), '2026-01-09', '2=2日後');
  assert.strictEqual(M.applyDateChange('2026-01-07', '2/3', b), '2026-02-03', '2/3=2月3日');
  assert.strictEqual(M.applyDateChange('2026-01-07', 'w', b), '2026-01-14', 'w=1週間後');
  assert.strictEqual(M.applyDateChange('2026-01-07', 'm', b), '2026-02-07', 'm=1ヶ月後');
  assert.strictEqual(M.applyDateChange('2026-01-07', 'y', b), '2027-01-07', 'y=1年後');
  assert.strictEqual(M.applyDateChange('2026-01-07', '0', b), b, '0=基準日');
  assert.strictEqual(M.applyDateChange('2026-01-07', '-1', b), '2026-01-06', '-1=前日');
});

console.log('# model: 月日セルの短縮入力');
ok('数字だけ / 月日 / 4桁', () => {
  const cur = '2026-09-06';
  const base = '2026-09-06';
  assert.strictEqual(M.parseDateInput('7', cur, base), '2026-09-07', '7 = 今月7日');
  assert.strictEqual(M.parseDateInput('3', cur, base), '2026-10-03', '過ぎている日は翌月へ送る');
  assert.strictEqual(M.parseDateInput('9/7', cur, base), '2026-09-07');
  assert.strictEqual(M.parseDateInput('12.25', cur, base), '2026-12-25');
  assert.strictEqual(M.parseDateInput('0907', cur, base), '2026-09-07');
  assert.strictEqual(M.parseDateInput('1/5', cur, base), '2027-01-05', '過去になるなら翌年');
});
ok('相対 (+n / -n / w / m / y / 0)', () => {
  const cur = '2026-09-06';
  const base = '2026-09-06';
  assert.strictEqual(M.parseDateInput('+1', cur, base), '2026-09-07');
  assert.strictEqual(M.parseDateInput('-1', cur, base), '2026-09-05');
  assert.strictEqual(M.parseDateInput('+10', cur, base), '2026-09-16');
  assert.strictEqual(M.parseDateInput('w', cur, base), '2026-09-13');
  assert.strictEqual(M.parseDateInput('w2', cur, base), '2026-09-20');
  assert.strictEqual(M.parseDateInput('m', cur, base), '2026-10-06');
  assert.strictEqual(M.parseDateInput('y', cur, base), '2027-09-06');
  assert.strictEqual(M.parseDateInput('0', '2026-09-20', base), base);
});
ok('曜日と相対語', () => {
  const cur = '2026-09-06'; // 日曜
  const base = '2026-09-06';
  assert.strictEqual(M.parseDateInput('月', cur, base), '2026-09-07');
  assert.strictEqual(M.parseDateInput('火', cur, base), '2026-09-08');
  assert.strictEqual(M.parseDateInput('日', cur, base), '2026-09-13', '同じ曜日は翌週');
  assert.strictEqual(M.parseDateInput('tue', cur, base), '2026-09-08');
  assert.strictEqual(M.parseDateInput('明日', cur, base), '2026-09-07');
  assert.strictEqual(M.parseDateInput('あさって', cur, base), '2026-09-08');
  assert.strictEqual(M.parseDateInput('today', cur, base), '2026-09-06');
});
ok('絶対日付と、解釈できない入力', () => {
  const cur = '2026-09-06';
  assert.strictEqual(M.parseDateInput('2026-12-25', cur, cur), '2026-12-25');
  assert.strictEqual(M.parseDateInput('2026/1/5', cur, cur), '2026-01-05');
  assert.strictEqual(M.parseDateInput('', cur, cur), null, '空欄は変更なし');
  assert.strictEqual(M.parseDateInput('あいう', cur, cur), null);
  assert.strictEqual(M.parseDateInput('99', cur, cur), null, '日として無効');
});
ok('日付変更ダイアログは空欄=翌日のまま', () => {
  const b = '2026-01-07';
  assert.strictEqual(M.applyDateChange('2026-01-07', '', b), '2026-01-08');
  assert.strictEqual(M.applyDateChange('2026-01-07', '2', b), '2026-01-09', 'ダイアログでは符号なしも相対');
  assert.strictEqual(M.applyDateChange('2026-01-07', '火', b), '2026-01-13', '曜日も使える');
});

console.log('# model: 見積の入力');
ok('分 / 時間 / 混在の書き方', () => {
  assert.strictEqual(M.estimateInput('90'), 90);
  assert.strictEqual(M.estimateInput('45m'), 45);
  assert.strictEqual(M.estimateInput('45分'), 45);
  assert.strictEqual(M.estimateInput('1.5h'), 90);
  assert.strictEqual(M.estimateInput('1.5時間'), 90);
  assert.strictEqual(M.estimateInput('1:30'), 90);
  assert.strictEqual(M.estimateInput('1h30'), 90);
  assert.strictEqual(M.estimateInput('0'), 0);
  assert.strictEqual(M.estimateInput(''), null);
  assert.strictEqual(M.estimateInput('あ'), null);
});

console.log('# model: 時刻と実績');
ok('hhmm 変換', () => {
  assert.strictEqual(M.hhmmToMin('9:05'), 545);
  assert.strictEqual(M.hhmmToMin('0930'), 570);
  assert.strictEqual(M.hhmmToMin(''), null);
  assert.strictEqual(M.minToHhmm(545), '09:05');
});
ok('実績 = 終了 - 開始 / 日跨ぎ', () => {
  assert.strictEqual(M.actualMin({ start: '09:00', end: '09:22' }), 22);
  assert.strictEqual(M.actualMin({ start: '23:40', end: '00:10' }), 30);
  assert.strictEqual(M.actualMin({ start: '09:00', end: '' }), null);
});
ok('ステータス記号', () => {
  const b = '2026-09-06';
  assert.strictEqual(M.statusMark({ date: b, end: '10:00' }, b), '■');
  assert.strictEqual(M.statusMark({ date: b, end: '' }, b), '□');
  assert.strictEqual(M.statusMark({ date: '2026-09-07', end: '' }, b), '◎');
  assert.strictEqual(M.statusMark({ date: '2026-09-05', end: '' }, b), '★');
});

const cfg = {
  sections: [
    { key: 'A', start: '06:00', end: '08:00' },
    { key: 'B', start: '08:00', end: '12:00' },
    { key: 'C', start: '12:00', end: '13:00' },
  ],
  dividerProject: '区切り',
};

console.log('# model: 期限 (due)');
ok('期限の状態を判定する', () => {
  const b = '2026-09-10';
  const mk = (due, end) => M.newTask(b, { due, end: end || '' });
  assert.strictEqual(M.dueState(mk(''), b), 'none', '期限なし');
  assert.strictEqual(M.dueState(mk('2026-09-09'), b), 'overdue', '期限切れ');
  assert.strictEqual(M.dueState(mk('2026-09-10'), b), 'today', '今日が期限');
  assert.strictEqual(M.dueState(mk('2026-09-12'), b), 'soon', '2日以内');
  assert.strictEqual(M.dueState(mk('2026-09-20'), b), 'later', 'まだ先');
  assert.strictEqual(M.dueState(mk('2026-09-01', '10:00'), b), 'done', '完了済みは警告しない');
});
ok('手を打つべき期限の件数', () => {
  const b = '2026-09-10';
  const tasks = [
    M.newTask(b, { due: '2026-09-08' }),
    M.newTask(b, { due: '2026-09-09' }),
    M.newTask(b, { due: '2026-09-10' }),
    M.newTask(b, { due: '2026-09-15' }),
    M.newTask(b, { due: '2026-09-01', start: '09:00', end: '09:30' }),
    M.newTask(b, {}),
  ];
  const a = M.dueAlertCount(tasks, b);
  assert.deepStrictEqual(a, { overdue: 2, today: 1, total: 3 });
});
ok('期限は月日と同じ短縮入力で書ける', () => {
  const cur = '2026-09-06';
  assert.strictEqual(M.parseDateInput('9/12', cur, cur), '2026-09-12');
  assert.strictEqual(M.parseDateInput('+3', cur, cur), '2026-09-09');
});
ok('新しいタスクは期限なしで始まる', () => {
  assert.strictEqual(M.newTask('2026-09-06').due, '');
});

console.log('# model: 節と集計');
ok('時刻から節を求める', () => {
  assert.strictEqual(M.sectionAtMinute(cfg, 9 * 60).key, 'B');
  assert.strictEqual(M.sectionAtMinute(cfg, 12 * 60 + 30).key, 'C');
  assert.strictEqual(M.sectionAtMinute(cfg, 3 * 60), null);
});
ok('終了予定時刻 = 現在 + 未完了の見積', () => {
  const b = '2026-09-06';
  const tasks = [
    M.newTask(b, { estimateMin: 30, start: '09:00', end: '09:35' }),
    M.newTask(b, { estimateMin: 45 }),
    M.newTask(b, { estimateMin: 15 }),
  ];
  const s = M.daySummary(tasks, b, 10 * 60);
  assert.strictEqual(s.estMin, 90);
  assert.strictEqual(s.doneMin, 30);
  assert.strictEqual(s.remainMin, 60);
  assert.strictEqual(s.doneCount, 1);
  assert.strictEqual(M.minToHhmm(s.etaMin), '11:00');
});
ok('積み残しも終了予定に含める', () => {
  const b = '2026-09-06';
  const tasks = [M.newTask('2026-09-05', { estimateMin: 20 }), M.newTask(b, { estimateMin: 10 })];
  const s = M.daySummary(tasks, b, 600);
  assert.strictEqual(s.leftoverMin, 20);
  assert.strictEqual(M.minToHhmm(s.etaMin), '10:30');
});
ok('節別サマリーの色 (青/赤/灰)', () => {
  const b = '2026-09-06';
  const tasks = [
    M.newTask(b, { section: 'B', estimateMin: 60 }),
    M.newTask(b, { section: 'C', estimateMin: 120 }), // C は上限 60 分 -> 超過
    M.newTask(b, { section: 'A', estimateMin: 30, start: '06:10', end: '06:40' }),
  ];
  const now = 9 * 60; // A は終了済み、B が現在
  const sum = M.sectionSummary(tasks, cfg, b, now);
  const byKey = Object.fromEntries(sum.map((s) => [s.key, s]));
  assert.strictEqual(byKey.A.color, 'gray', 'A: 終了済みで未完了なし -> 灰');
  assert.strictEqual(byKey.B.color, 'blue', 'B: 上限内 -> 青');
  assert.strictEqual(byKey.C.color, 'red', 'C: 上限超過 -> 赤');
  assert.strictEqual(byKey.B.current, true, 'B が現在の節');
});
ok('終了した節に未完了が残っていれば赤', () => {
  const b = '2026-09-06';
  const tasks = [M.newTask(b, { section: 'A', estimateMin: 30 })];
  const sum = M.sectionSummary(tasks, cfg, b, 9 * 60);
  assert.strictEqual(sum[0].color, 'red');
});
ok('現在の節と残り時間', () => {
  const info = M.currentSectionInfo(cfg, 9 * 60 + 30); // 09:30 -> B(08:00-12:00)
  assert.strictEqual(info.key, 'B');
  assert.strictEqual(info.remainMin, 150, '12:00 まで 150 分');
  assert.strictEqual(M.currentSectionInfo(cfg, 3 * 60), null, '時間帯の外');
});

console.log('# model: 並べ替え');
ok('節 -> スター -> ＃ の順', () => {
  const b = '2026-09-06';
  const t1 = M.newTask(b, { section: 'B', no: 10, name: 'B1' });
  const t2 = M.newTask(b, { section: 'A', no: 20, name: 'A1' });
  const t3 = M.newTask(b, { section: 'B', no: 30, name: 'B2-star', star: true });
  const sorted = [t1, t2, t3].sort((a, c) => M.compareTasks(a, c, cfg, b));
  assert.deepStrictEqual(sorted.map((t) => t.name), ['A1', 'B2-star', 'B1']);
});
ok('過去 -> 基準日 -> 翌日以降 の順', () => {
  const b = '2026-09-06';
  const a = M.newTask('2026-09-07', { name: 'future' });
  const c = M.newTask('2026-09-05', { name: 'past' });
  const d = M.newTask(b, { name: 'today' });
  const sorted = [a, c, d].sort((x, y) => M.compareTasks(x, y, cfg, b));
  assert.deepStrictEqual(sorted.map((t) => t.name), ['past', 'today', 'future']);
});
ok('翌日以降は節内ソート順が効く', () => {
  const b = '2026-09-06';
  const n = '2026-09-07';
  const a = M.newTask(n, { section: 'B', no: 10, sectionSort: '0830', name: 'late' });
  const c = M.newTask(n, { section: 'B', no: 20, sectionSort: '0800', name: 'early' });
  const sorted = [a, c].sort((x, y) => M.compareTasks(x, y, cfg, b));
  assert.deepStrictEqual(sorted.map((t) => t.name), ['early', 'late']);
});
ok('renumber は日ごとに 10 刻み', () => {
  const t = [M.newTask('2026-09-06'), M.newTask('2026-09-06'), M.newTask('2026-09-07')];
  M.renumber(t);
  assert.deepStrictEqual(t.map((x) => x.no), [10, 20, 10]);
});
ok('区切りタスクは時刻を過ぎたら翌日へ', () => {
  const b = '2026-09-06';
  const t = M.newTask(b, { project: '区切り', sectionSort: '1300', name: '退勤' });
  const notYet = M.pushDividers([t], cfg, b, 12 * 60);
  assert.strictEqual(notYet.length, 0);
  assert.strictEqual(t.date, b);
  const moved = M.pushDividers([t], cfg, b, 14 * 60);
  assert.strictEqual(moved.length, 1);
  assert.strictEqual(t.date, '2026-09-07');
});

console.log('# model: 繰り返し');
ok('毎日 / N日ごと / 曜日 / 毎月', () => {
  assert.strictEqual(M.nextRepeatDate({ kind: 'daily', interval: 1 }, '2026-09-06'), '2026-09-07');
  assert.strictEqual(M.nextRepeatDate({ kind: 'interval', interval: 3 }, '2026-09-06'), '2026-09-09');
  // 2026-09-06 は日曜。次の月曜は 09-07
  assert.strictEqual(M.nextRepeatDate({ kind: 'weekly', weekdays: [1] }, '2026-09-06'), '2026-09-07');
  assert.strictEqual(M.nextRepeatDate({ kind: 'weekdays' }, '2026-09-06'), '2026-09-07');
  assert.strictEqual(M.nextRepeatDate({ kind: 'monthly', interval: 1, monthDay: 6 }, '2026-09-06'), '2026-10-06');
});
ok('複製は実績を引き継がない / 時間帯指定が効く', () => {
  const t = M.newTask('2026-09-06', {
    name: '朝のレシピ',
    section: 'D',
    fixedSection: 'B',
    estimateMin: 15,
    start: '13:00',
    end: '13:20',
    repeat: { kind: 'daily', interval: 1 },
  });
  const c = M.cloneForNextOccurrence(t);
  assert.strictEqual(c.date, '2026-09-07');
  assert.strictEqual(c.section, 'B', '時間帯指定があれば翌日はそこに入る');
  assert.strictEqual(c.start, '');
  assert.strictEqual(c.end, '');
  assert.strictEqual(c.estimateMin, 15);
});
ok('表示名は 【B】…(repeats)', () => {
  const t = M.newTask('2026-09-06', { name: 'メールチェック', fixedSection: 'B', repeat: { kind: 'daily' } });
  assert.strictEqual(M.displayName(t), '【B】メールチェック (repeats)');
});

console.log('# model: シミュレーション');
ok('見積どおり進んだ場合の終了時刻', () => {
  const b = '2026-09-06';
  const t1 = M.newTask(b, { name: '朝', estimateMin: 30, start: '09:00', end: '09:30' });
  const t2 = M.newTask(b, { name: '資料作成', estimateMin: 90 });
  const t3 = M.newTask(b, { name: 'セミナー2', estimateMin: 60 });
  const r = M.simulate([t1, t2, t3], t3.id, b, 9 * 60 + 30);
  assert.strictEqual(M.minToHhmm(r.target.endMin), '12:00');
  assert.strictEqual(M.minToHhmm(r.target.startMin), '11:00');
});

console.log('# store: 保存と読み込み');
const tmp = path.join(os.tmpdir(), 'tc-test-' + Date.now());
const store = new Store(tmp, '.taskchute');
ok('config.json を自動生成する', () => {
  const c = store.loadConfig();
  assert.ok(fs.existsSync(store.configPath()));
  assert.ok(c.sections.length >= 3);
});
ok('1日1ファイルで往復できる', () => {
  const b = '2026-09-06';
  const t = M.newTask(b, { name: 'テスト', estimateMin: 25 });
  store.writeDay(b, [t]);
  const back = store.loadDay(b);
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0].name, 'テスト');
  assert.strictEqual(back[0].estimateMin, 25);
});
ok('範囲外の日へ移動したタスクは移動先へ書き込まれる', () => {
  const b = '2026-09-06';
  const far = '2026-12-25';
  const t = M.newTask(b, { name: '遠い予定' });
  t.date = far;
  store.saveTasks([t], [b]);
  assert.deepStrictEqual(store.loadDay(b), []);
  assert.strictEqual(store.loadDay(far)[0].name, '遠い予定');
});
ok('タスク名の索引が作れる', () => {
  store.writeDay('2026-09-01', [
    M.newTask('2026-09-01', { name: 'メールチェック', project: 'Work', start: '09:00', end: '09:12' }),
  ]);
  store.writeDay('2026-09-02', [
    M.newTask('2026-09-02', { name: 'メールチェック', project: 'Work', start: '09:00', end: '09:18' }),
  ]);
  const idx = store.nameIndex(true);
  const hit = idx.find((n) => n.name === 'メールチェック');
  assert.strictEqual(hit.count, 2);
  assert.strictEqual(Math.round(hit.actualSum / hit.actualCount), 15);
});

console.log('# dailyNote');
ok('パス書式 YYYY/MM/DD', () => {
  const p = daily.notePathFor(tmp, { folder: '20_daily', format: 'YYYY/MM/DD' }, '2026-09-06');
  assert.ok(p.endsWith(path.join('20_daily', '2026', '09', '06.md')), p);
});
ok('テンプレートを差し込んでノートを作る', () => {
  const cfg2 = { folder: '20_daily', format: 'YYYY/MM/DD', template: '' };
  const r = daily.ensureNote(tmp, cfg2, '2026-09-06');
  assert.strictEqual(r.created, true);
  const body = fs.readFileSync(r.fsPath, 'utf8');
  assert.ok(body.includes('# 2026-09-06 (日)'), body.slice(0, 200));
  assert.ok(body.includes('../../2026/09/05.md') || body.includes('05.md'), '前日リンク');
  const again = daily.ensureNote(tmp, cfg2, '2026-09-06');
  assert.strictEqual(again.created, false, '既存ファイルは上書きしない');
});
ok('自前テンプレートのプレースホルダ', () => {
  const out = daily.renderTemplate('{{date}} {{weekday}} / {{date:YYYY年M}} / {{title}}', '2026-09-06', {});
  assert.ok(out.startsWith('2026-09-06 日 /'), out);
  assert.ok(out.includes('2026年'), out);
  assert.ok(out.includes('2026-09-06 (日)'), out);
});

console.log('# taskNote (タスクに紐づくメモ)');
const taskNote = require(base + '/taskNote');
ok('ファイル名に使えない文字を落とす', () => {
  assert.strictEqual(taskNote.sanitizeFileName('見積書のレビュー'), '見積書のレビュー');
  assert.strictEqual(taskNote.sanitizeFileName('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i');
  assert.strictEqual(taskNote.sanitizeFileName('  ..空白.. '), '空白');
  assert.strictEqual(taskNote.sanitizeFileName(''), '無題');
  assert.ok(taskNote.sanitizeFileName('あ'.repeat(200)).length <= 60, '長すぎる名前は切り詰める');
});
ok('見本テンプレートを置いて、一覧に出せる', () => {
  const dir = path.join(tmp, '80_tamplate', 'task');
  assert.strictEqual(taskNote.ensureTemplates(dir), true, '無ければ作る');
  assert.strictEqual(taskNote.ensureTemplates(dir), false, '既にあれば何もしない');
  const list = taskNote.listTemplates(dir);
  assert.deepStrictEqual(list.map((t) => t.name).sort(), ['メモ', '会議', '調査']);
  fs.writeFileSync(path.join(dir, '自作.md'), '# {{task}}\n', 'utf8');
  assert.strictEqual(taskNote.listTemplates(dir).length, 4, 'ファイルを足せば選択肢が増える');
});
ok('置き場所は 日付-タスク名 で、重複したら枝番を振る', () => {
  const t = M.newTask('2026-09-06', { name: '見積書のレビュー' });
  const a = taskNote.decidePath(tmp, 'notes', t);
  assert.strictEqual(a.rel, 'notes/2026-09-06-見積書のレビュー.md');
  fs.mkdirSync(path.dirname(a.fsPath), { recursive: true });
  fs.writeFileSync(a.fsPath, 'x', 'utf8');
  const b = taskNote.decidePath(tmp, 'notes', t);
  assert.strictEqual(b.rel, 'notes/2026-09-06-見積書のレビュー-2.md');
});
ok('テンプレートの差し込み文字が埋まる', () => {
  const t = M.newTask('2026-09-06', {
    name: '見積書のレビュー',
    project: 'Work',
    mode: 'Focus',
    section: 'B',
    estimateMin: 60,
    due: '2026-09-12',
  });
  const out = taskNote.render(
    '# {{task}}\n{{date}}({{weekday}}){{dueLine}}\n{{project}}/{{mode}}/{{section}}/{{estimate}}\n{{dailyLink}}',
    t,
    { dailyLink: '[link](x.md)' }
  );
  assert.ok(out.includes('# 見積書のレビュー'), out);
  assert.ok(out.includes('2026-09-06(日)'), out);
  assert.ok(out.includes('期限 2026-09-12 (土)'), out);
  assert.ok(out.includes('Work/Focus/B/60'), out);
  assert.ok(out.includes('[link](x.md)'), out);
});
ok('期限が無ければ期限の行は空になる', () => {
  const t = M.newTask('2026-09-06', { name: 'x' });
  assert.strictEqual(taskNote.render('{{dueLine}}', t, {}), '');
});
ok('テンプレートからメモを書き出せる', () => {
  const t = M.newTask('2026-09-08', { name: '定例ミーティング', project: 'Work' });
  const tplDir = path.join(tmp, '80_tamplate', 'task');
  const dailyFs = path.join(tmp, '20_daily', '2026', '09', '08.md');
  const r = taskNote.createNote(tmp, { folder: 'notes' }, t, path.join(tplDir, '会議.md'), dailyFs);
  assert.strictEqual(r.rel, 'notes/2026-09-08-定例ミーティング.md');
  const body = fs.readFileSync(r.fsPath, 'utf8');
  assert.ok(body.startsWith('# 定例ミーティング'), body.slice(0, 40));
  assert.ok(body.includes('## 決まったこと'), '会議テンプレートの見出しが入る');
  assert.ok(body.includes('../20_daily/2026/09/08.md'), 'デイリーノートへの相対リンク');
});
ok('テンプレートを選ばなくても最低限のメモができる', () => {
  const t = M.newTask('2026-09-09', { name: 'テンプレなし' });
  const r = taskNote.createNote(tmp, { folder: 'notes' }, t, null, null);
  const body = fs.readFileSync(r.fsPath, 'utf8');
  assert.ok(body.startsWith('# テンプレなし'), body);
});

console.log('# ics');
ok('VEVENT を読み取れる', () => {
  const sample = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:abc-123',
    'SUMMARY:定例\\, 週次ミーティング',
    'LOCATION:会議室A',
    'DTSTART:20260907T100000',
    'DTEND:20260907T110000',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:allday-1',
    'SUMMARY:休暇',
    'DTSTART;VALUE=DATE:20260908',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const evs = ics.parseEvents(sample);
  assert.strictEqual(evs.length, 2);
  assert.strictEqual(evs[0].summary, '定例, 週次ミーティング');
  const t = ics.eventToTask(evs[0], Object.assign({ calendarProject: '予定' }, cfg));
  assert.strictEqual(t.date, '2026-09-07');
  assert.strictEqual(t.estimateMin, 60);
  assert.strictEqual(t.sectionSort, '1000');
  assert.strictEqual(t.start, '', '予定は実績時刻を埋めない (完了扱いを避ける)');
  assert.ok(t.hint.includes('10:00-11:00'), t.hint);
  assert.ok(t.hint.includes('会議室A'));
  const t2 = ics.eventToTask(evs[1], Object.assign({ calendarProject: '予定' }, cfg));
  assert.strictEqual(t2.hint.includes('All day'), true, t2.hint);
});
ok('折り返し行を連結する', () => {
  const lines = ics.unfold('SUMMARY:とても長い\r\n 件名です');
  assert.strictEqual(lines[0], 'SUMMARY:とても長い件名です');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} 件成功` + (process.exitCode ? ' / 失敗あり' : ' / 失敗なし'));

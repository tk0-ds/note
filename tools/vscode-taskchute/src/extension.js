// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const M = require('./model');
const { Store } = require('./store');
const daily = require('./dailyNote');
const ics = require('./ics');
const { TaskChutePanel } = require('./panel');

/** @type {TaskChutePanel|null} */
let panel = null;
/** @type {Store|null} */
let store = null;

function cfgGet() {
  return vscode.workspace.getConfiguration('taskchute');
}

/** ノート環境のルートを決める */
function resolveRoot() {
  const explicit = String(cfgGet().get('rootFolder') || '').trim();
  if (explicit) return explicit;
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) return folders[0].uri.fsPath;
  return null;
}

function getStore() {
  const root = resolveRoot();
  if (!root) {
    vscode.window.showErrorMessage(
      'TaskChute: no folder is open. Open the notes root folder, or set taskchute.rootFolder.'
    );
    return null;
  }
  if (!store || store.root !== root) {
    store = new Store(root, String(cfgGet().get('dataFolder') || '.taskchute'));
  }
  return store;
}

function dailyCfg() {
  const c = cfgGet();
  return {
    folder: String(c.get('dailyNote.folder') || '20_daily'),
    format: String(c.get('dailyNote.format') || 'YYYY/MM/DD'),
    template: String(c.get('dailyNote.template') || ''),
  };
}

/** デイリーノートを開く (無ければテンプレートから作る) */
async function openDailyNote(dateStr) {
  const s = getStore();
  if (!s) return;
  const res = daily.ensureNote(s.root, dailyCfg(), dateStr);
  const uri = vscode.Uri.file(res.fsPath);
  if (cfgGet().get('dailyNote.useDefaultEditor')) {
    await vscode.commands.executeCommand('vscode.open', uri);
  } else {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  }
  if (res.created) {
    vscode.window.setStatusBarMessage(`TaskChute: created the daily note for ${dateStr}`, 3000);
  }
}

/** 今開いているファイルがデイリーノートなら、その日付を返す */
function dateOfActiveEditor() {
  const ed = vscode.window.activeTextEditor;
  const s = getStore();
  if (!ed || !s) return null;
  const cfg = dailyCfg();
  const base = path.join(s.root, cfg.folder);
  const p = ed.document.uri.fsPath;
  if (!p.startsWith(base)) return null;
  const m = /(\d{4})[-/\\](\d{2})[-/\\](\d{2})/.exec(p.slice(base.length));
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const m2 = /(\d{4})-(\d{2})-(\d{2})/.exec(path.basename(p));
  return m2 ? `${m2[1]}-${m2[2]}-${m2[3]}` : null;
}

function getPanel(context) {
  const s = getStore();
  if (!s) return null;
  if (!panel || panel.store !== s) {
    panel = new TaskChutePanel(context, s, openDailyNote);
  }
  return panel;
}

// ------------------------------------------------------------------ コマンド

async function quickAddTask(context) {
  const s = getStore();
  if (!s) return;
  const cfg = s.loadConfig();
  const raw = await vscode.window.showInputBox({
    title: 'TaskChute: add a task',
    prompt: 'Format: name [/Project] [@Mode] [30m or 1.5h] [!due]   e.g. Send the quote /Work @Focus 60m !9/12',
    placeHolder: 'Send the quote /Work @Focus 60m !9/12',
  });
  if (!raw) return;

  let text = raw.trim();
  let estimateMin = null;
  let project = '';
  let mode = '';
  let due = '';

  // !9/12 !+3 !w のように書くと期限になる
  text = text.replace(/(?:^|\s)!(\S+)/, (_m, v) => {
    const d = M.parseDateInput(v, M.todayStr(), M.todayStr());
    if (d) due = d;
    return ' ';
  });

  text = text.replace(/(?:^|\s)(\d+(?:\.\d+)?)(h|時間)(?=\s|$)/i, (_m, n) => {
    estimateMin = Math.round(Number(n) * 60);
    return ' ';
  });
  text = text.replace(/(?:^|\s)(\d+)(m|分)(?=\s|$)/i, (_m, n) => {
    estimateMin = Number(n);
    return ' ';
  });
  text = text.replace(/(?:^|\s)\/(\S+)/, (_m, v) => {
    project = v;
    return ' ';
  });
  text = text.replace(/(?:^|\s)@(\S+)/, (_m, v) => {
    mode = v;
    return ' ';
  });
  const name = text.replace(/\s+/g, ' ').trim();
  if (!name) return;

  const date = M.todayStr();
  const list = s.loadDay(date);
  const sec = M.sectionAtMinute(cfg, M.nowMin());
  const t = M.newTask(date, {
    name,
    project,
    mode,
    estimateMin,
    due,
    section: sec ? sec.key : '',
    no: (list.length + 1) * 10,
  });
  list.push(t);
  s.writeDay(date, list);
  s.invalidate();
  vscode.window.setStatusBarMessage(
    `TaskChute: added "${name}"${due ? ` (due ${due})` : ''}`,
    3000
  );
  if (panel && panel.panel) panel.load();
}

async function importIcs(context) {
  const s = getStore();
  if (!s) return;
  const picked = await vscode.window.showOpenDialog({
    title: 'Pick an ICS file',
    canSelectMany: false,
    filters: { iCalendar: ['ics'], 'All files': ['*'] },
  });
  if (!picked || picked.length === 0) return;

  let events;
  try {
    events = ics.parseEvents(fs.readFileSync(picked[0].fsPath, 'utf8'));
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to read the ICS file: ${e.message}`);
    return;
  }
  if (events.length === 0) {
    vscode.window.showInformationMessage('No importable events were found.');
    return;
  }

  const cfg = s.loadConfig();
  const from = await vscode.window.showInputBox({
    title: 'Import from (start date)',
    value: M.todayStr(),
    validateInput: (v) => (M.parseDateStr(v) ? null : 'Use the YYYY-MM-DD format'),
  });
  if (!from) return;
  const to = await vscode.window.showInputBox({
    title: 'Import to (end date)',
    value: M.addDays(from, 14),
    validateInput: (v) => (M.parseDateStr(v) ? null : 'Use the YYYY-MM-DD format'),
  });
  if (!to) return;

  const tasks = events
    .map((e) => ics.eventToTask(e, cfg))
    .filter((t) => M.diffDays(from, t.date) >= 0 && M.diffDays(t.date, to) >= 0);

  const byDate = new Map();
  for (const t of tasks) {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push(t);
  }

  let added = 0;
  let updated = 0;
  for (const [date, list] of byDate) {
    const day = s.loadDay(date);
    for (const t of list) {
      const hit = t.calendarUid ? day.find((x) => x.calendarUid === t.calendarUid) : null;
      if (hit) {
        hit.name = t.name;
        hit.estimateMin = t.estimateMin;
        hit.sectionSort = t.sectionSort;
        hit.hint = t.hint;
        if (!hit.section) hit.section = t.section;
        updated += 1;
      } else {
        t.no = (day.length + 1) * 10;
        day.push(t);
        added += 1;
      }
    }
    s.writeDay(date, day);
  }
  s.invalidate();
  vscode.window.showInformationMessage(`TaskChute: imported ${added} event(s), updated ${updated}.`);
  if (panel && panel.panel) panel.load();
}

// ------------------------------------------------------------------ 起動

function activate(context) {
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('taskchute.open', () => {
    const p = getPanel(context);
    if (p) p.reveal();
  });

  reg('taskchute.openDailyNote', () => openDailyNote(M.todayStr()));

  reg('taskchute.openPrevDailyNote', () => {
    const cur = dateOfActiveEditor() || M.todayStr();
    return openDailyNote(M.addDays(cur, -1));
  });

  reg('taskchute.openNextDailyNote', () => {
    const cur = dateOfActiveEditor() || M.todayStr();
    return openDailyNote(M.addDays(cur, 1));
  });

  reg('taskchute.openDailyNoteByDate', async () => {
    const v = await vscode.window.showInputBox({
      title: 'Open a daily note',
      value: M.todayStr(),
      prompt: 'YYYY-MM-DD / today / yesterday / tomorrow / -3 (3 days ago) / +2 (in 2 days)',
    });
    if (!v) return;
    const s = v.trim();
    let target = M.todayStr();
    if (M.parseDateStr(s)) target = s;
    else if (s === 'today' || s === '今日') target = M.todayStr();
    else if (s === 'yesterday' || s === '昨日') target = M.addDays(M.todayStr(), -1);
    else if (s === 'tomorrow' || s === '明日') target = M.addDays(M.todayStr(), 1);
    else if (/^[+-]?\d+$/.test(s)) target = M.addDays(M.todayStr(), Number(s));
    else {
      vscode.window.showWarningMessage(`Cannot read this as a date: ${s}`);
      return;
    }
    return openDailyNote(target);
  });

  reg('taskchute.quickAddTask', () => quickAddTask(context));
  reg('taskchute.importIcs', () => importIcs(context));

  reg('taskchute.openConfig', async () => {
    const s = getStore();
    if (!s) return;
    s.loadConfig();
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.configPath()));
    await vscode.window.showTextDocument(doc);
  });

  reg('taskchute.rebuildNameIndex', () => {
    const s = getStore();
    if (!s) return;
    const n = s.nameIndex(true).length;
    vscode.window.showInformationMessage(`TaskChute: indexed ${n} task name(s).`);
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = '$(checklist) TaskChute';
  status.tooltip = 'Open the TaskChute panel (Ctrl+Alt+T)';
  status.command = 'taskchute.open';
  status.show();
  context.subscriptions.push(status);
}

function deactivate() {
  if (panel) panel.dispose();
}

module.exports = { activate, deactivate };

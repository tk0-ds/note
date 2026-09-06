// @ts-check
'use strict';
/**
 * タスクに紐づけるメモ (.md) の作成。
 *
 * - 置き場所  : notes/YYYY-MM-DD-タスク名.md (設定で変えられる)
 * - テンプレート: 80_tamplate/task/*.md を並べて選ばせる
 *
 * タスクには「ルートからの相対パス」だけを持たせる。
 * 環境フォルダごと別 PC へコピーしてもリンクが切れないようにするため。
 */

const fs = require('fs');
const path = require('path');
const M = require('./model');

/** 初回に置いておくテンプレート */
const STARTER_TEMPLATES = {
  'メモ.md': `# {{task}}

- 実行予定 {{date}} ({{weekday}}){{dueLine}}
- Project {{project}} / Mode {{mode}} / 見積 {{estimate}}分
- {{dailyLink}}

## わかっていること

-

## やること

- [ ]

## メモ

-
`,
  '会議.md': `# {{task}}

- 日時 {{date}} ({{weekday}}){{dueLine}}
- {{dailyLink}}

## 目的

## 論点

-

## 決まったこと

-

## 宿題

- [ ]
`,
  '調査.md': `# {{task}}

- 実行予定 {{date}} ({{weekday}}){{dueLine}}
- {{dailyLink}}

## 何を知りたいか

## 調べたこと

-

## わかったこと

-

## 次の一手

- [ ]
`,
};

/** Windows のファイル名に使えない文字を落とす */
function sanitizeFileName(name) {
  const s = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 32) // 制御文字を落とす
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60)
    .trim();
  return s || '無題';
}

/** テンプレート置き場を用意する。無ければ見本を書き出す */
function ensureTemplates(dir) {
  if (fs.existsSync(dir)) return false;
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(STARTER_TEMPLATES)) {
    fs.writeFileSync(path.join(dir, name), body, 'utf8');
  }
  return true;
}

/** 選択肢に出すテンプレートの一覧 */
function listTemplates(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .sort()
    .map((f) => ({ name: f.replace(/\.md$/i, ''), fsPath: path.join(dir, f) }));
}

/** そのタスクのメモの置き場所を決める。既にあれば -2, -3 と枝番を振る */
function decidePath(root, folder, task) {
  const dir = path.join(root, folder);
  const base = `${task.date}-${sanitizeFileName(task.name)}`;
  let rel = path.join(folder, `${base}.md`);
  let n = 2;
  while (fs.existsSync(path.join(root, rel))) {
    rel = path.join(folder, `${base}-${n}.md`);
    n += 1;
    if (n > 999) break;
  }
  return { dir, rel: rel.split(path.sep).join('/'), fsPath: path.join(root, rel) };
}

/** テンプレートの差し込み文字を埋める */
function render(text, task, ctx) {
  const est = task.estimateMin === null || task.estimateMin === undefined ? '' : String(task.estimateMin);
  const dueLine = task.due ? ` / 期限 ${task.due} (${M.weekdayJa(task.due)})` : '';
  const now = new Date();
  const stamp = `${M.toDateStr(now)} ${M.pad2(now.getHours())}:${M.pad2(now.getMinutes())}`;
  return String(text)
    .replace(/\{\{\s*task\s*\}\}/g, task.name || '(名称未設定)')
    .replace(/\{\{\s*project\s*\}\}/g, task.project || '-')
    .replace(/\{\{\s*mode\s*\}\}/g, task.mode || '-')
    .replace(/\{\{\s*section\s*\}\}/g, task.section || '-')
    .replace(/\{\{\s*estimate\s*\}\}/g, est || '-')
    .replace(/\{\{\s*due\s*\}\}/g, task.due || '')
    .replace(/\{\{\s*dueLine\s*\}\}/g, dueLine)
    .replace(/\{\{\s*date\s*\}\}/g, task.date)
    .replace(/\{\{\s*weekday\s*\}\}/g, M.weekdayJa(task.date))
    .replace(/\{\{\s*now\s*\}\}/g, stamp)
    .replace(/\{\{\s*dailyLink\s*\}\}/g, (ctx && ctx.dailyLink) || '');
}

/** その日のデイリーノートへの相対リンク */
function dailyLink(noteFsPath, dailyFsPath, dateStr) {
  if (!dailyFsPath) return '';
  let rel = path.relative(path.dirname(noteFsPath), dailyFsPath).split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return `[${dateStr} のデイリーノート](${encodeURI(rel)})`;
}

/**
 * メモを作る。
 * @param {string} root 環境フォルダ
 * @param {{folder:string}} noteCfg
 * @param {any} task
 * @param {string|null} templateFsPath 選んだテンプレート。null なら見出しだけ
 * @param {string|null} dailyFsPath その日のデイリーノートの絶対パス
 * @returns {{rel:string, fsPath:string}}
 */
function createNote(root, noteCfg, task, templateFsPath, dailyFsPath) {
  const target = decidePath(root, noteCfg.folder || 'notes', task);
  let tpl = `# {{task}}\n\n- 実行予定 {{date}} ({{weekday}}){{dueLine}}\n- {{dailyLink}}\n\n`;
  if (templateFsPath && fs.existsSync(templateFsPath)) {
    const raw = fs.readFileSync(templateFsPath, 'utf8');
    if (raw.trim()) tpl = raw;
  }
  const body = render(tpl, task, {
    dailyLink: dailyLink(target.fsPath, dailyFsPath, task.date),
  });
  fs.mkdirSync(path.dirname(target.fsPath), { recursive: true });
  fs.writeFileSync(target.fsPath, body, 'utf8');
  return { rel: target.rel, fsPath: target.fsPath };
}

module.exports = {
  STARTER_TEMPLATES,
  sanitizeFileName,
  ensureTemplates,
  listTemplates,
  decidePath,
  render,
  dailyLink,
  createNote,
};

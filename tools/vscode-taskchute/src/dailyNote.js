// @ts-check
'use strict';
/**
 * デイリーノート (.md) の作成とパス解決。
 * Obsidian の「デイリーノート」と同じ考え方だが、Obsidian には依存しない。
 */

const fs = require('fs');
const path = require('path');
const M = require('./model');

const DEFAULT_TEMPLATE = `---
date: {{date}}
weekday: {{weekday}}
tags: [daily]
aliases: []
---

# {{date}} ({{weekday}})

{{prevLink}} | {{nextLink}}

## 今日の狙い

-

## メモ

-

## ふりかえり

-
`;

/** 'YYYY/MM/DD' のような書式を日付に当てはめる */
function formatDate(dateStr, fmt, now) {
  const d = M.parseDateStr(dateStr) || new Date();
  const t = now || new Date();
  const map = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MM: M.pad2(d.getMonth() + 1),
    DD: M.pad2(d.getDate()),
    ddd: M.WEEKDAY_JA[d.getDay()],
    HH: M.pad2(t.getHours()),
    mm: M.pad2(t.getMinutes()),
  };
  return String(fmt).replace(/YYYY|YY|MM|DD|ddd|HH|mm/g, (k) => map[k]);
}

/** その日のノートの絶対パス */
function notePathFor(root, cfg, dateStr) {
  const rel = formatDate(dateStr, cfg.format || 'YYYY/MM/DD');
  return path.join(root, cfg.folder || '20_daily', `${rel}.md`);
}

/** from から to への相対リンク (Markdown 用に / 区切り) */
function relLink(fromFile, toFile) {
  let rel = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return encodeURI(rel);
}

/** テンプレートのプレースホルダを埋める */
function renderTemplate(text, dateStr, ctx) {
  const now = new Date();
  return String(text)
    .replace(/\{\{\s*date\s*:\s*([^}]+?)\s*\}\}/g, (_m, fmt) => formatDate(dateStr, fmt, now))
    .replace(/\{\{\s*date\s*\}\}/g, dateStr)
    .replace(/\{\{\s*weekday\s*\}\}/g, M.weekdayJa(dateStr))
    .replace(/\{\{\s*time\s*\}\}/g, formatDate(dateStr, 'HH:mm', now))
    .replace(/\{\{\s*title\s*\}\}/g, `${dateStr} (${M.weekdayJa(dateStr)})`)
    .replace(/\{\{\s*prevLink\s*\}\}/g, ctx.prevLink || '')
    .replace(/\{\{\s*nextLink\s*\}\}/g, ctx.nextLink || '');
}

/**
 * その日のノートを用意する。無ければテンプレートから作る。
 * 中身が空のファイルだけが残っている場合も、テンプレートを流し込む。
 * @returns {{fsPath: string, created: boolean}}
 */
function ensureNote(root, cfg, dateStr) {
  const target = notePathFor(root, cfg, dateStr);
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8').trim() !== '') {
    return { fsPath: target, created: false };
  }

  const prev = notePathFor(root, cfg, M.addDays(dateStr, -1));
  const next = notePathFor(root, cfg, M.addDays(dateStr, 1));
  const ctx = {
    prevLink: `[← ${M.addDays(dateStr, -1)}](${relLink(target, prev)})`,
    nextLink: `[${M.addDays(dateStr, 1)} →](${relLink(target, next)})`,
  };

  let tpl = DEFAULT_TEMPLATE;
  if (cfg.template) {
    const tplPath = path.isAbsolute(cfg.template) ? cfg.template : path.join(root, cfg.template);
    if (fs.existsSync(tplPath)) {
      const raw = fs.readFileSync(tplPath, 'utf8');
      if (raw.trim()) tpl = raw;
    }
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderTemplate(tpl, dateStr, ctx), 'utf8');
  return { fsPath: target, created: true };
}

module.exports = { formatDate, notePathFor, renderTemplate, ensureNote, relLink, DEFAULT_TEMPLATE };

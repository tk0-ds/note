// @ts-check
'use strict';
/**
 * タスクデータの読み書き。
 * 1 日 1 ファイル (.taskchute/days/YYYY-MM-DD.json) で保存する。
 */

const fs = require('fs');
const path = require('path');
const M = require('./model');

const DEFAULT_CONFIG = {
  '//': 'TaskChute for VS Code の設定ファイル',
  sections: [
    { key: 'A', label: 'Early', start: '06:00', end: '08:00' },
    { key: 'B', label: 'Morning', start: '08:00', end: '12:00' },
    { key: 'C', label: 'Noon', start: '12:00', end: '13:00' },
    { key: 'D', label: 'Afternoon', start: '13:00', end: '17:00' },
    { key: 'E', label: 'Evening', start: '17:00', end: '19:00' },
    { key: 'F', label: 'Night', start: '19:00', end: '22:00' },
    { key: 'G', label: 'Late', start: '22:00', end: '24:00' },
  ],
  projects: ['Manage', 'Life', 'Work', '学習', 'Divider'],
  modes: [
    { name: 'Focus', color: '#ffd6d6', textColor: '#8a1c1c' },
    { name: 'Routine', color: '#e2eefc', textColor: '#1c467d' },
    { name: 'Comm', color: '#e6f6e0', textColor: '#245c18' },
    { name: 'Input', color: '#f3e8fd', textColor: '#5b2a86' },
    { name: 'Move', color: '#fdf0dc', textColor: '#7a4b10' },
    { name: 'Rest', color: '#eeeeee', textColor: '#555555' },
  ],
  dividerProject: 'Divider',
  calendarProject: 'Event',
  idleTaskName: 'Idling',
  view: {
    pastDays: 7,
    futureDays: 10,
    forecastDays: 10,
  },
  columns: {
    status: { label: '□', visible: true, width: 26 },
    date: { label: 'Date', visible: true, width: 74 },
    due: { label: 'Due', visible: true, width: 74 },
    section: { label: 'Sec', visible: true, width: 34 },
    no: { label: '#', visible: false, width: 40 },
    star: { label: '★', visible: true, width: 24 },
    project: { label: 'Project', visible: true, width: 76 },
    mode: { label: 'Mode', visible: true, width: 70 },
    name: { label: 'Task', visible: true, width: 240 },
    memo: { label: 'Note', visible: true, width: 34 },
    estimate: { label: 'Est', visible: true, width: 44 },
    actual: { label: 'Act', visible: true, width: 44 },
    start: { label: 'Start', visible: true, width: 46 },
    end: { label: 'End', visible: true, width: 46 },
    sectionSort: { label: 'Order', visible: false, width: 48 },
    hint: { label: 'Hint', visible: false, width: 180 },
    comment: { label: 'Comment', visible: false, width: 180 },
  },
};

/** 列の並び順。config で消しても順番はここで決まる */
const COLUMN_ORDER = [
  'status',
  'date',
  'due',
  'section',
  'no',
  'star',
  'project',
  'mode',
  'name',
  'memo',
  'estimate',
  'actual',
  'start',
  'end',
  'sectionSort',
  'hint',
  'comment',
];

class Store {
  /** @param {string} root ノート環境のルート */
  constructor(root, dataFolder) {
    this.root = root;
    this.dataFolder = dataFolder || '.taskchute';
    this._config = null;
    this._nameIndex = null;
  }

  dataDir() {
    return path.join(this.root, this.dataFolder);
  }

  daysDir() {
    return path.join(this.dataDir(), 'days');
  }

  configPath() {
    return path.join(this.dataDir(), 'config.json');
  }

  dayPath(dateStr) {
    return path.join(this.daysDir(), `${dateStr}.json`);
  }

  ensureDirs() {
    fs.mkdirSync(this.daysDir(), { recursive: true });
  }

  // -------------------------------------------------------------- 設定

  loadConfig(force) {
    if (this._config && !force) return this._config;
    this.ensureDirs();
    const p = this.configPath();
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
      this._config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      return this._config;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      this._config = Object.assign({}, DEFAULT_CONFIG, raw);
      this._config.view = Object.assign({}, DEFAULT_CONFIG.view, raw.view || {});
      if (!Array.isArray(this._config.sections) || this._config.sections.length === 0) {
        this._config.sections = DEFAULT_CONFIG.sections;
      }
      // 列は 1 つずつ既定と混ぜる。config に書いていない列は既定のまま
      const cols = {};
      for (const key of COLUMN_ORDER) {
        cols[key] = Object.assign({}, DEFAULT_CONFIG.columns[key], (raw.columns || {})[key] || {});
      }
      this._config.columns = cols;
    } catch (e) {
      this._config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      this._config.__error = `config.json が読めませんでした: ${e.message}`;
    }
    return this._config;
  }

  saveConfig(cfg) {
    this.ensureDirs();
    fs.writeFileSync(this.configPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    this._config = cfg;
  }

  // -------------------------------------------------------------- 日別データ

  /** @returns {any[]} その日のタスク配列 */
  loadDay(dateStr) {
    const p = this.dayPath(dateStr);
    if (!fs.existsSync(p)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw.tasks || [];
      return list.map((t) => Object.assign(M.newTask(dateStr), t, { date: dateStr }));
    } catch (e) {
      throw new Error(`${path.basename(p)} が読めません: ${e.message}`);
    }
  }

  writeDay(dateStr, tasks) {
    this.ensureDirs();
    const p = this.dayPath(dateStr);
    if (!tasks || tasks.length === 0) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return;
    }
    const body = { date: dateStr, updatedAt: new Date().toISOString(), tasks };
    fs.writeFileSync(p, JSON.stringify(body, null, 2) + '\n', 'utf8');
  }

  /** from..to (両端を含む) の全タスク */
  loadRange(from, to) {
    const out = [];
    let d = from;
    let guard = 0;
    while (M.diffDays(d, to) >= 0 && guard < 1000) {
      out.push(...this.loadDay(d));
      d = M.addDays(d, 1);
      guard += 1;
    }
    return out;
  }

  /**
   * 読み込み済みの範囲のタスクを保存する。
   * 範囲外の日に移動したタスクは、その日のファイルへ追記する。
   * @param {any[]} tasks 現在メモリ上にある全タスク
   * @param {string[]} loadedDates 読み込み済みの日付一覧
   */
  saveTasks(tasks, loadedDates) {
    this.ensureDirs();
    const byDate = new Map();
    for (const t of tasks) {
      if (!byDate.has(t.date)) byDate.set(t.date, []);
      byDate.get(t.date).push(t);
    }
    const loaded = new Set(loadedDates);
    // 読み込み済みの日は丸ごと書き換える (空なら削除)
    for (const d of loaded) {
      this.writeDay(d, byDate.get(d) || []);
    }
    // 範囲外へ移動した分は既存ファイルへマージ
    for (const [d, list] of byDate) {
      if (loaded.has(d)) continue;
      const existing = this.loadDay(d);
      const ids = new Set(existing.map((t) => t.id));
      const merged = existing.concat(list.filter((t) => !ids.has(t.id)));
      for (const t of existing) {
        const hit = list.find((x) => x.id === t.id);
        if (hit) Object.assign(t, hit);
      }
      this.writeDay(d, merged);
    }
    this._nameIndex = null;
  }

  /** 範囲外の 1 日に 1 件だけ足す (繰り返しの翌回複製など) */
  appendToDay(dateStr, task) {
    const list = this.loadDay(dateStr);
    if (list.some((t) => t.id === task.id)) return false;
    list.push(task);
    this.writeDay(dateStr, list);
    this._nameIndex = null;
    return true;
  }

  /** 同じ繰り返し系列のタスクが既にその日にあるか */
  hasSeriesOn(dateStr, seriesId) {
    if (!seriesId) return false;
    return this.loadDay(dateStr).some((t) => (t.seriesId || t.id) === seriesId);
  }

  // -------------------------------------------------------------- 索引

  /** タスクが 1 件でも入っている日の一覧。カレンダーに点を打つのに使う */
  datesWithTasks() {
    const dir = this.daysDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();
  }

  /** 過去に入力したタスク名の一覧 (検索入力用) */
  nameIndex(force) {
    if (this._nameIndex && !force) return this._nameIndex;
    const dir = this.daysDir();
    const map = new Map();
    if (fs.existsSync(dir)) {
      const files = fs
        .readdirSync(dir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort()
        .reverse()
        .slice(0, 800);
      for (const f of files) {
        let list = [];
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          list = Array.isArray(raw) ? raw : raw.tasks || [];
        } catch (e) {
          continue;
        }
        const date = f.slice(0, 10);
        for (const t of list) {
          const name = String(t.name || '').trim();
          if (!name) continue;
          const prev = map.get(name);
          const actual = M.actualMin(t);
          if (!prev) {
            map.set(name, {
              name,
              project: t.project || '',
              mode: t.mode || '',
              estimateMin: t.estimateMin || null,
              section: t.section || '',
              lastDate: date,
              count: 1,
              actualSum: actual || 0,
              actualCount: actual === null ? 0 : 1,
            });
          } else {
            prev.count += 1;
            if (date > prev.lastDate) {
              prev.lastDate = date;
              prev.project = t.project || prev.project;
              prev.mode = t.mode || prev.mode;
              prev.estimateMin = t.estimateMin || prev.estimateMin;
              prev.section = t.section || prev.section;
            }
            if (actual !== null) {
              prev.actualSum += actual;
              prev.actualCount += 1;
            }
          }
        }
      }
    }
    this._nameIndex = Array.from(map.values()).sort((a, b) =>
      a.lastDate === b.lastDate ? b.count - a.count : a.lastDate < b.lastDate ? 1 : -1
    );
    return this._nameIndex;
  }

  invalidate() {
    this._config = null;
    this._nameIndex = null;
  }
}

module.exports = { Store, DEFAULT_CONFIG, COLUMN_ORDER };

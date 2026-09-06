// @ts-check
'use strict';
/**
 * TaskChute のデータモデルと純粋な計算処理。
 * VS Code API には依存しないので、node から直接読み込んで動作確認できる。
 */

/** ノートのテンプレートなど、ユーザの文章に入るほうの曜日 */
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];
/** 画面 (UI) に出すほうの曜日 */
const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad2 = (n) => String(n).padStart(2, '0');

/** Date -> 'YYYY-MM-DD' */
function toDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 'YYYY-MM-DD' -> Date (ローカル時刻の 0 時) */
function parseDateStr(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function todayStr() {
  return toDateStr(new Date());
}

/** 日付文字列に日数を足す */
function addDays(dateStr, n) {
  const d = parseDateStr(dateStr);
  if (!d) return dateStr;
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/** 日付文字列に月数を足す (月末は丸める) */
function addMonths(dateStr, n) {
  const d = parseDateStr(dateStr);
  if (!d) return dateStr;
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toDateStr(d);
}

/** 曜日 (日=0) */
function weekdayIndex(dateStr) {
  const d = parseDateStr(dateStr);
  return d ? d.getDay() : 0;
}

function weekdayJa(dateStr) {
  return WEEKDAY_JA[weekdayIndex(dateStr)];
}

function weekdayEn(dateStr) {
  return WEEKDAY_EN[weekdayIndex(dateStr)];
}

/** 2 つの日付の差 (日数)。b - a */
function diffDays(a, b) {
  const da = parseDateStr(a);
  const db = parseDateStr(b);
  if (!da || !db) return 0;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

// ---------------------------------------------------------------- 時刻

/** 'HH:MM' -> 分。空や不正なら null */
function hhmmToMin(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  if (!t) return null;
  let m = /^(\d{1,2}):(\d{1,2})$/.exec(t);
  if (!m) m = /^(\d{1,2})(\d{2})$/.exec(t); // 0930 のような 4 桁入力も受ける
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 47 || mi > 59) return null;
  return h * 60 + mi;
}

/** 分 -> 'HH:MM' */
function minToHhmm(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  const v = Math.round(n);
  return `${pad2(Math.floor(v / 60))}:${pad2(((v % 60) + 60) % 60)}`;
}

function nowMin(date) {
  const d = date || new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function nowHhmm(date) {
  return minToHhmm(nowMin(date));
}

// ---------------------------------------------------------------- タスク

/** 空のタスクを作る */
function newTask(dateStr, patch) {
  return Object.assign(
    {
      id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      date: dateStr,
      due: '', // 期限。'' なら期限なし。date (実行予定日) とは別物
      section: '',
      no: 0,
      star: false,
      project: '',
      mode: '',
      name: '',
      estimateMin: null,
      start: '',
      end: '',
      sectionSort: '',
      hint: '',
      hintLink: '',
      notePath: '', // 紐づけたメモ (.md) の、ルートからの相対パス
      comment: '',
      repeat: null,
      fixedSection: '',
      calendarUid: '',
      seriesId: '',
      createdAt: new Date().toISOString(),
    },
    patch || {}
  );
}

/** 実績時間 (分)。終了が開始より前なら日をまたいだとみなす */
function actualMin(task) {
  const s = hhmmToMin(task.start);
  const e = hhmmToMin(task.end);
  if (s === null || e === null) return null;
  let d = e - s;
  if (d < 0) d += 24 * 60;
  return d;
}

function isDone(task) {
  return !!(task.end && hhmmToMin(task.end) !== null);
}

/**
 * ステータス記号。
 *  ■ 完了 / □ 基準日の未完了 / ◎ 翌日以降 / ★ 基準日より前の未完了 (積み残し)
 */
function statusMark(task, baseDate) {
  if (isDone(task)) return '■';
  const d = diffDays(baseDate, task.date);
  if (d < 0) return '★';
  if (d > 0) return '◎';
  return '□';
}

/**
 * 期限の状態。
 *  none    期限なし
 *  done    完了済み (期限は気にしなくてよい)
 *  overdue 期限切れ
 *  today   今日が期限
 *  soon    2 日以内
 *  later   まだ先
 */
function dueState(task, baseDate) {
  if (!task.due) return 'none';
  if (isDone(task)) return 'done';
  const d = diffDays(baseDate, task.due);
  if (d < 0) return 'overdue';
  if (d === 0) return 'today';
  if (d <= 2) return 'soon';
  return 'later';
}

/** 手を打つべき期限 (期限切れ + 今日が期限) の件数 */
function dueAlertCount(tasks, baseDate) {
  let overdue = 0;
  let today = 0;
  for (const t of tasks) {
    const s = dueState(t, baseDate);
    if (s === 'overdue') overdue += 1;
    else if (s === 'today') today += 1;
  }
  return { overdue, today, total: overdue + today };
}

/** 並べ替えのグループ。0=積み残し(過去) 1=基準日 2=翌日以降 */
function groupOf(task, baseDate) {
  const d = diffDays(baseDate, task.date);
  if (d < 0) return 0;
  if (d > 0) return 2;
  return 1;
}

/** 節 (セクション) の定義を取得 */
function sectionOf(config, key) {
  if (!key) return null;
  return (config.sections || []).find((s) => s.key === key) || null;
}

/** 時刻 (分) からその時刻を含む節を求める */
function sectionAtMinute(config, minute) {
  const list = config.sections || [];
  for (const s of list) {
    const st = hhmmToMin(s.start);
    let en = hhmmToMin(s.end);
    if (st === null || en === null) continue;
    if (en <= st) en += 24 * 60; // 日をまたぐ節
    let m = minute;
    if (m < st) m += 24 * 60;
    if (m >= st && m < en) return s;
  }
  return null;
}

/** 節の並び順 (config の定義順)。未設定は最後 */
function sectionOrder(config, key) {
  const list = config.sections || [];
  const i = list.findIndex((s) => s.key === key);
  return i < 0 ? 999 : i;
}

/**
 * 並べ替えの比較関数。
 *  グループ (過去 → 基準日 → 翌日以降) → 月日 → 節 → スター → 順序数
 *  基準日のタスクは「＃」、翌日以降のタスクは「節内ソート順」を最後の鍵にする。
 */
function compareTasks(a, b, config, baseDate) {
  const ga = groupOf(a, baseDate);
  const gb = groupOf(b, baseDate);
  if (ga !== gb) return ga - gb;
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const sa = sectionOrder(config, a.section);
  const sb = sectionOrder(config, b.section);
  if (sa !== sb) return sa - sb;
  const st = (a.star ? 0 : 1) - (b.star ? 0 : 1);
  if (st !== 0) return st;
  if (ga === 2) {
    const ka = String(a.sectionSort || '9999');
    const kb = String(b.sectionSort || '9999');
    if (ka !== kb) return ka < kb ? -1 : 1;
  }
  const na = Number(a.no || 0);
  const nb = Number(b.no || 0);
  if (na !== nb) return na - nb;
  return String(a.createdAt || '') < String(b.createdAt || '') ? -1 : 1;
}

/** 並べ替え後に ＃ を 10 刻みで振り直す (日ごとに 10 から) */
function renumber(tasks) {
  const counters = new Map();
  for (const t of tasks) {
    const n = (counters.get(t.date) || 0) + 10;
    counters.set(t.date, n);
    t.no = n;
  }
  return tasks;
}

/**
 * 「区切り」タスクの先送り。
 * Project が config.dividerProject のタスクで、節内ソート順の 4 桁 (1300 = 13:00) を
 * 現在時刻が過ぎていれば翌日に振り替える。通常/全力の並べ替えでのみ実行する。
 * @returns {string[]} 日付が変わったタスクの id
 */
function pushDividers(tasks, config, baseDate, nowMinute) {
  const proj = config.dividerProject || '区切り';
  const moved = [];
  for (const t of tasks) {
    if (t.project !== proj) continue;
    if (t.date !== baseDate) continue;
    if (isDone(t)) continue;
    const limit = hhmmToMin(t.sectionSort);
    if (limit === null) continue;
    if (nowMinute > limit) {
      t.date = addDays(t.date, 1);
      moved.push(t.id);
    }
  }
  return moved;
}

// ---------------------------------------------------------------- 集計

/**
 * 今日のサマリー。
 *  見積 : 基準日のタスクの見積合計と件数
 *  消化 : 完了済みの見積合計と件数
 *  残   : 見積 - 消化
 *  終了予定時刻 : 現在時刻 + 未完了タスクの見積合計
 */
function daySummary(tasks, baseDate, nowMinute) {
  const today = tasks.filter((t) => t.date === baseDate);
  let estMin = 0;
  let estCount = 0;
  let doneMin = 0;
  let doneCount = 0;
  let actualSum = 0;
  for (const t of today) {
    const e = Number(t.estimateMin || 0);
    estMin += e;
    estCount += 1;
    if (isDone(t)) {
      doneMin += e;
      doneCount += 1;
      actualSum += actualMin(t) || 0;
    }
  }
  const leftover = tasks.filter((t) => !isDone(t) && diffDays(baseDate, t.date) < 0);
  const leftoverMin = leftover.reduce((a, t) => a + Number(t.estimateMin || 0), 0);
  return {
    estMin,
    estCount,
    doneMin,
    doneCount,
    remainMin: estMin - doneMin,
    remainCount: estCount - doneCount,
    actualSum,
    leftoverMin,
    leftoverCount: leftover.length,
    etaMin: nowMinute + (estMin - doneMin) + leftoverMin,
  };
}

/**
 * 節別サマリーと色。
 *  灰 : 終了した節で未完了タスクが残っていない
 *  赤 : 見積合計が節の上限を超えている、または終了した節に未完了が残っている
 *  青 : 上限内
 *  下線 : 現在の節
 */
function sectionSummary(tasks, config, baseDate, nowMinute) {
  const cur = sectionAtMinute(config, nowMinute);
  return (config.sections || []).map((s) => {
    const st = hhmmToMin(s.start);
    let en = hhmmToMin(s.end);
    if (st !== null && en !== null && en <= st) en += 24 * 60;
    const capacity = st === null || en === null ? null : en - st;
    const inSec = tasks.filter((t) => t.date === baseDate && t.section === s.key);
    const estMin = inSec.reduce((a, t) => a + Number(t.estimateMin || 0), 0);
    const pending = inSec.filter((t) => !isDone(t)).length;
    const finished = en !== null && nowMinute >= en;
    let color = 'blue';
    if (capacity !== null && estMin > capacity) color = 'red';
    if (finished) color = pending > 0 ? 'red' : 'gray';
    return {
      key: s.key,
      label: s.label || '',
      start: s.start,
      end: s.end,
      capacity,
      estMin,
      count: inSec.length,
      pending,
      color,
      current: !!(cur && cur.key === s.key),
    };
  });
}

/** 基準日の翌日以降 n 日分の見積合計 */
function forecast(tasks, baseDate, days) {
  const out = [];
  for (let i = 1; i <= days; i++) {
    const d = addDays(baseDate, i);
    const list = tasks.filter((t) => t.date === d);
    out.push({
      date: d,
      weekday: weekdayEn(d),
      estMin: list.reduce((a, t) => a + Number(t.estimateMin || 0), 0),
      count: list.length,
    });
  }
  return out;
}

/**
 * 見積もりシミュレーション。
 * 直近の終了時刻と現在時刻の遅い方を起点に、対象タスクまでの未完了見積を積み上げる。
 */
function simulate(sortedTasks, targetId, baseDate, nowMinute) {
  const done = sortedTasks.filter((t) => isDone(t) && t.date === baseDate);
  let base = nowMinute;
  for (const t of done) {
    const e = hhmmToMin(t.end);
    if (e !== null && e > base) base = e;
  }
  let acc = base;
  const chain = [];
  for (const t of sortedTasks) {
    if (isDone(t)) continue;
    if (diffDays(baseDate, t.date) > 0) break;
    const est = Number(t.estimateMin || 0);
    const from = acc;
    acc += est;
    chain.push({ id: t.id, name: t.name, from, to: acc, estMin: est });
    if (t.id === targetId) {
      return { base, chain, target: { id: t.id, name: t.name, startMin: from, endMin: acc } };
    }
  }
  return { base, chain, target: null };
}

// ---------------------------------------------------------------- 日付変更

/** 曜日の別名。'月' でも 'mon' でも受ける */
const WEEKDAY_ALIASES = {
  日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6,
  にち: 0, げつ: 1, か: 2, すい: 3, もく: 4, きん: 5, ど: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** 相対語 */
const DAY_WORDS = {
  今日: 0, きょう: 0, today: 0,
  明日: 1, あした: 1, あす: 1, tomorrow: 1,
  明後日: 2, あさって: 2,
  昨日: -1, きのう: -1, yesterday: -1,
  一昨日: -2, おととい: -2,
};

/** from の翌日以降で、最初に weekday になる日 */
function nextWeekday(fromDate, weekday) {
  for (let i = 1; i <= 7; i++) {
    const cand = addDays(fromDate, i);
    if (weekdayIndex(cand) === weekday) return cand;
  }
  return fromDate;
}

/**
 * 月日セルの短縮入力を解釈する。解釈できなければ null。
 *
 *   '7'          -> 今月 7 日 (基準日より前なら翌月)
 *   '9/7' '9.7'  -> 9 月 7 日 (過去になるなら翌年)
 *   '0907'       -> 同上
 *   '+1' '-1'    -> 翌日 / 前日
 *   '0'          -> 基準日
 *   'w' 'w2'     -> 1/2 週間後
 *   'm' 'y'      -> 1 ヶ月後 / 1 年後
 *   '火' 'tue'   -> 次の火曜
 *   '明日' 'あさって' 'today' など
 *   '2026-09-07' '2026/9/7' -> その日付
 *
 * @param {string} raw 入力文字列
 * @param {string} currentDate そのタスクの現在の日付 (相対計算の起点)
 * @param {string} baseDate 基準日
 */
function parseDateInput(raw, currentDate, baseDate) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return null;
  const from = parseDateStr(currentDate) ? currentDate : todayStr();
  const base = parseDateStr(baseDate) ? baseDate : from;

  // 2026-09-07 / 2026/9/7
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return toDateStr(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));

  // +1 / -3
  m = /^([+-])(\d+)$/.exec(s);
  if (m) return addDays(from, (m[1] === '-' ? -1 : 1) * Number(m[2]));

  // 0 = 基準日
  if (s === '0') return base;

  // w / w2 / m / y
  m = /^([wWmMyY])(\d*)$/.exec(s);
  if (m) {
    const n = m[2] === '' ? 1 : Number(m[2]);
    const k = m[1].toLowerCase();
    if (k === 'w') return addDays(from, 7 * n);
    if (k === 'm') return addMonths(from, n);
    return addMonths(from, 12 * n);
  }

  // 相対語
  const wordKey = Object.prototype.hasOwnProperty.call(DAY_WORDS, s)
    ? s
    : Object.prototype.hasOwnProperty.call(DAY_WORDS, s.toLowerCase())
      ? s.toLowerCase()
      : null;
  if (wordKey !== null) return addDays(base, DAY_WORDS[wordKey]);

  // 曜日
  const wdKey = Object.prototype.hasOwnProperty.call(WEEKDAY_ALIASES, s)
    ? s
    : Object.prototype.hasOwnProperty.call(WEEKDAY_ALIASES, s.toLowerCase())
      ? s.toLowerCase()
      : null;
  if (wdKey !== null) return nextWeekday(from, WEEKDAY_ALIASES[wdKey]);

  // 9/7 や 9.7
  m = /^(\d{1,2})[/.](\d{1,2})$/.exec(s);
  if (!m) {
    // 0907 のような 4 桁
    const four = /^(\d{2})(\d{2})$/.exec(s);
    if (four && Number(four[1]) >= 1 && Number(four[1]) <= 12 && Number(four[2]) >= 1 && Number(four[2]) <= 31) {
      m = four;
    }
  }
  if (m) {
    const mo = Number(m[1]);
    const dy = Number(m[2]);
    if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;
    const y = (parseDateStr(from) || new Date()).getFullYear();
    let cand = toDateStr(new Date(y, mo - 1, dy));
    if (diffDays(base, cand) < 0) cand = toDateStr(new Date(y + 1, mo - 1, dy));
    return cand;
  }

  // 1〜31 の数字だけ = その日
  m = /^(\d{1,2})$/.exec(s);
  if (m) {
    const dy = Number(m[1]);
    if (dy < 1 || dy > 31) return null;
    const d = parseDateStr(from) || new Date();
    let cand = toDateStr(new Date(d.getFullYear(), d.getMonth(), dy));
    if (diffDays(base, cand) < 0) {
      const nx = addMonths(cand, 1);
      const nd = parseDateStr(nx);
      cand = toDateStr(new Date(nd.getFullYear(), nd.getMonth(), dy));
    }
    return cand;
  }

  return null;
}

/**
 * 「日付変更」ダイアログの入力。空欄は翌日という TaskChute の作法を保つ。
 * それ以外は月日セルと同じ解釈。
 */
function applyDateChange(dateStr, input, baseDate) {
  const raw = String(input === undefined || input === null ? '' : input).trim();
  if (!raw || raw === '翌日') return addDays(dateStr, 1);
  // ダイアログでは符号なしの数字も相対日数として扱う (TaskChute 互換)
  const rel = /^-?\d+$/.exec(raw);
  if (rel) {
    const n = Number(raw);
    if (n === 0) return baseDate;
    if (Math.abs(n) <= 31) return addDays(dateStr, n);
  }
  const parsed = parseDateInput(raw, dateStr, baseDate);
  return parsed === null ? dateStr : parsed;
}

/**
 * 見積の入力を分に直す。解釈できなければ null。
 *   '90' '90m' '90分' -> 90
 *   '1.5h' '1.5時間'  -> 90
 *   '1:30' '1h30'     -> 90
 */
function estimateInput(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return null;
  let m = /^(\d+(?:\.\d+)?)\s*(?:h|H|時間)$/.exec(s);
  if (m) return Math.round(Number(m[1]) * 60);
  m = /^(\d+)\s*(?:m|M|分)$/.exec(s);
  if (m) return Number(m[1]);
  m = /^(\d{1,2}):(\d{1,2})$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d+)\s*[hH]\s*(\d+)\s*[mM]?$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s));
  return null;
}

/** 現在の節と、その節の残り時間 (分) */
function currentSectionInfo(config, nowMinute) {
  const s = sectionAtMinute(config, nowMinute);
  if (!s) return null;
  let en = hhmmToMin(s.end);
  const st = hhmmToMin(s.start);
  if (en !== null && st !== null && en <= st) en += 24 * 60;
  let now = nowMinute;
  if (st !== null && now < st) now += 24 * 60;
  return {
    key: s.key,
    label: s.label || '',
    start: s.start,
    end: s.end,
    remainMin: en === null ? null : Math.max(0, en - now),
  };
}

// ---------------------------------------------------------------- 繰り返し

/**
 * 次回の実行日を求める。
 * repeat = { kind, interval, weekdays, monthDay }
 *   kind: 'daily' | 'interval' | 'weekly' | 'weekdays' | 'monthly' | 'yearly'
 */
function nextRepeatDate(repeat, fromDate) {
  if (!repeat) return null;
  const kind = repeat.kind || 'daily';
  const interval = Math.max(1, Number(repeat.interval || 1));
  if (kind === 'daily' || kind === 'interval') return addDays(fromDate, interval);
  if (kind === 'monthly') {
    const next = addMonths(fromDate, interval);
    if (repeat.monthDay) {
      const d = parseDateStr(next);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(Number(repeat.monthDay), last));
      return toDateStr(d);
    }
    return next;
  }
  if (kind === 'yearly') return addMonths(fromDate, 12 * interval);
  if (kind === 'weekly' || kind === 'weekdays') {
    let days = Array.isArray(repeat.weekdays) ? repeat.weekdays.map(Number) : [];
    if (kind === 'weekdays' && days.length === 0) days = [1, 2, 3, 4, 5];
    if (days.length === 0) days = [weekdayIndex(fromDate)];
    for (let i = 1; i <= 371; i++) {
      const cand = addDays(fromDate, i);
      if (days.includes(weekdayIndex(cand))) return cand;
    }
  }
  return addDays(fromDate, 1);
}

/** 繰り返しタスクを次回分として複製する */
function cloneForNextOccurrence(task) {
  const nextDate = nextRepeatDate(task.repeat, task.date);
  if (!nextDate) return null;
  return newTask(nextDate, {
    section: task.fixedSection || task.section,
    no: task.no,
    star: false,
    project: task.project,
    mode: task.mode,
    name: task.name,
    estimateMin: task.estimateMin,
    sectionSort: task.sectionSort,
    hint: task.hint,
    hintLink: task.hintLink,
    repeat: task.repeat ? Object.assign({}, task.repeat) : null,
    fixedSection: task.fixedSection,
    seriesId: task.seriesId || task.id,
  });
}

/** 繰り返しの説明文 (画面に出るので英語) */
function repeatLabel(repeat) {
  if (!repeat) return '';
  const n = Math.max(1, Number(repeat.interval || 1));
  switch (repeat.kind) {
    case 'daily':
      return n === 1 ? 'Every day' : `Every ${n} days`;
    case 'interval':
      return `Every ${n} days`;
    case 'weekdays':
      return 'Weekdays';
    case 'weekly': {
      const days = (repeat.weekdays || []).map((i) => WEEKDAY_EN[i]).join(' ');
      return days ? `Weekly ${days}` : 'Weekly';
    }
    case 'monthly':
      return repeat.monthDay ? `Monthly on day ${repeat.monthDay}` : 'Monthly';
    case 'yearly':
      return 'Yearly';
    default:
      return 'Repeats';
  }
}

/** 表示用の作業内容 (【B】…(repeats) の飾りつけ) */
function displayName(task) {
  const prefix = task.fixedSection ? `【${task.fixedSection}】` : '';
  const suffix = task.repeat ? ' (repeats)' : '';
  return `${prefix}${task.name || ''}${suffix}`;
}

module.exports = {
  WEEKDAY_JA,
  WEEKDAY_EN,
  pad2,
  toDateStr,
  parseDateStr,
  todayStr,
  addDays,
  addMonths,
  weekdayIndex,
  weekdayJa,
  weekdayEn,
  diffDays,
  hhmmToMin,
  minToHhmm,
  nowMin,
  nowHhmm,
  newTask,
  actualMin,
  isDone,
  statusMark,
  dueState,
  dueAlertCount,
  groupOf,
  sectionOf,
  sectionAtMinute,
  sectionOrder,
  compareTasks,
  renumber,
  pushDividers,
  daySummary,
  sectionSummary,
  forecast,
  simulate,
  applyDateChange,
  parseDateInput,
  estimateInput,
  currentSectionInfo,
  nextWeekday,
  WEEKDAY_ALIASES,
  nextRepeatDate,
  cloneForNextOccurrence,
  repeatLabel,
  displayName,
};

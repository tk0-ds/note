// @ts-check
'use strict';
/**
 * ICS (iCalendar) ファイルの取り込み口。
 *
 * Outlook 側と直結する前の暫定手段として、書き出した .ics を読み込んで
 * 予定を TaskChute のタスクとして取り込む。
 *
 * 制限:
 *  - RRULE (繰り返し予定) は展開しない。最初の 1 回だけ取り込む。
 *  - TZID 付きの時刻はローカル時刻として扱う。末尾 Z (UTC) だけは変換する。
 */

const M = require('./model');

/** 折り返された行を連結する */
function unfold(text) {
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (out.length > 0 && /^[ \t]/.test(line)) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function unescapeText(v) {
  return String(v)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/** 'NAME;PARAM=X:VALUE' を分解する */
function parseLine(line) {
  const idx = line.indexOf(':');
  if (idx < 0) return null;
  const left = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const parts = left.split(';');
  const name = parts[0].toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq > 0) params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
  }
  return { name, params, value };
}

/** ICS の日時を Date と「終日かどうか」に変換する */
function parseDateTime(value, params) {
  const v = String(value).trim();
  let m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (m) {
    const [, y, mo, d, h, mi, s, z] = m;
    if (z) {
      return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false };
    }
    return { date: new Date(+y, +mo - 1, +d, +h, +mi, +s), allDay: false };
  }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) {
    const [, y, mo, d] = m;
    return { date: new Date(+y, +mo - 1, +d), allDay: true };
  }
  if (params && params.VALUE === 'DATE') return { date: null, allDay: true };
  return { date: null, allDay: false };
}

/** 'PT1H30M' などの DURATION を分に直す */
function parseDuration(v) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v).trim());
  if (!m) return null;
  const days = Number(m[1] || 0);
  const h = Number(m[2] || 0);
  const mi = Number(m[3] || 0);
  return days * 1440 + h * 60 + mi;
}

/** ICS 本文から予定の配列を取り出す */
function parseEvents(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN' && p.value.toUpperCase() === 'VEVENT') {
      cur = { uid: '', summary: '', location: '', start: null, end: null, allDay: false, durationMin: null, recurring: false };
      continue;
    }
    if (p.name === 'END' && p.value.toUpperCase() === 'VEVENT') {
      if (cur) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    switch (p.name) {
      case 'UID':
        cur.uid = p.value.trim();
        break;
      case 'SUMMARY':
        cur.summary = unescapeText(p.value).trim();
        break;
      case 'LOCATION':
        cur.location = unescapeText(p.value).trim();
        break;
      case 'DTSTART': {
        const r = parseDateTime(p.value, p.params);
        cur.start = r.date;
        cur.allDay = r.allDay;
        break;
      }
      case 'DTEND': {
        const r = parseDateTime(p.value, p.params);
        cur.end = r.date;
        break;
      }
      case 'DURATION':
        cur.durationMin = parseDuration(p.value);
        break;
      case 'RRULE':
        cur.recurring = true;
        break;
      default:
        break;
    }
  }
  return events.filter((e) => e.start instanceof Date && !Number.isNaN(e.start.getTime()));
}

/**
 * 予定を TaskChute のタスクに変換する。
 * 開始/終了 (実績) は埋めない。埋めると完了扱いになってしまうため。
 */
function eventToTask(ev, config) {
  const dateStr = M.toDateStr(ev.start);
  const startMin = ev.allDay ? null : ev.start.getHours() * 60 + ev.start.getMinutes();
  let durationMin = ev.durationMin;
  if (durationMin === null || durationMin === undefined) {
    if (ev.end instanceof Date) durationMin = Math.round((ev.end.getTime() - ev.start.getTime()) / 60000);
  }
  if (ev.allDay) durationMin = 0;
  const sec = startMin === null ? null : M.sectionAtMinute(config, startMin);
  const timeLabel = ev.allDay
    ? 'All day'
    : `${M.minToHhmm(startMin)}${ev.end ? '-' + M.minToHhmm(ev.end.getHours() * 60 + ev.end.getMinutes()) : ''}`;
  const hintParts = [`Event ${timeLabel}`];
  if (ev.location) hintParts.push(`@${ev.location}`);
  if (ev.recurring) hintParts.push('(recurring: first occurrence only)');

  return M.newTask(dateStr, {
    project: config.calendarProject || '予定',
    name: ev.summary || '(no title)',
    section: sec ? sec.key : '',
    estimateMin: durationMin && durationMin > 0 ? durationMin : 0,
    sectionSort: startMin === null ? '' : M.minToHhmm(startMin).replace(':', ''),
    hint: hintParts.join(' '),
    calendarUid: ev.uid ? `${ev.uid}#${dateStr}` : '',
  });
}

module.exports = { parseEvents, eventToTask, parseDuration, parseDateTime, unfold };

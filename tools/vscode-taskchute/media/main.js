/*
 * TaskChute webview front-end
 *
 * マウスを使わない前提の作り。
 *  - 通常モード : セルの上をカーソルが動く。1 文字キーがコマンドとして効く
 *  - 編集モード : カーソル位置のセルだけが入力欄になる。Esc で通常モードへ戻る
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const overlay = document.getElementById('overlay');
  const dialogEl = document.getElementById('dialog');
  const dialogBody = document.getElementById('dialog-body');

  /** @type {any} */
  let state = null;

  const ui = {
    mode: 'normal', // 'normal' | 'edit'
    rowId: null,
    col: 'name',
    draft: '',
    caretToEnd: false,
    combo: null, // { items: [{value,label,detail}], index }
    calendar: null, // { cursor: 'YYYY-MM-DD' }
    showAllCols: false,
  };

  // 編集できない列
  const READONLY_COLS = { status: true, actual: true, star: true };
  // 候補リストを出す列
  const COMBO_COLS = { section: true, project: true, mode: true, name: true };

  // ------------------------------------------------------------ 小道具

  function post(type, extra) {
    vscode.postMessage(Object.assign({ type }, extra || {}));
  }

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, String(v));
      }
    }
    for (const c of children || []) {
      if (c === null || c === undefined || c === false) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  }

  /** 分 -> '1:30' */
  function dur(min) {
    if (min === null || min === undefined || min === '' || Number.isNaN(Number(min))) return '';
    const v = Math.round(Number(min));
    const sign = v < 0 ? '-' : '';
    const a = Math.abs(v);
    return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
  }

  /** 分 -> 'HH:MM' (24 時を超えたら翌表記) */
  function clock(min) {
    if (min === null || min === undefined) return '';
    const v = Math.round(min);
    const day = Math.floor(v / 1440);
    const m = ((v % 1440) + 1440) % 1440;
    const s = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return day > 0 ? `${s} +${day}d` : s;
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const WEEKDAY = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  function parseDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function fmtDate(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function addDays(s, n) {
    const d = parseDate(s);
    if (!d) return s;
    d.setDate(d.getDate() + n);
    return fmtDate(d);
  }
  function addMonths(s, n) {
    const d = parseDate(s);
    if (!d) return s;
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return fmtDate(d);
  }

  // ------------------------------------------------------------ カーソル

  function columns() {
    if (!state) return [];
    return state.columns.filter((c) => ui.showAllCols || c.visible !== false);
  }

  function rows() {
    return state ? state.rows : [];
  }

  function rowIndex() {
    return rows().findIndex((r) => r.id === ui.rowId);
  }

  function currentRow() {
    const i = rowIndex();
    return i < 0 ? null : rows()[i];
  }

  function colIndex() {
    return columns().findIndex((c) => c.key === ui.col);
  }

  function ensureCursor() {
    const list = rows();
    if (list.length === 0) {
      ui.rowId = null;
      return;
    }
    if (!list.some((r) => r.id === ui.rowId)) {
      const first = list.find((r) => r.isToday && !r.done) || list[0];
      ui.rowId = first.id;
    }
    const cols = columns();
    if (cols.length === 0) return;
    if (!cols.some((c) => c.key === ui.col)) ui.col = (cols.find((c) => c.key === 'name') || cols[0]).key;
  }

  function moveRow(delta) {
    const list = rows();
    if (list.length === 0) return;
    const i = rowIndex();
    const j = Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + delta));
    ui.rowId = list[j].id;
    refreshCursor();
  }

  function moveCol(delta) {
    const cols = columns();
    if (cols.length === 0) return;
    const i = colIndex();
    const j = Math.max(0, Math.min(cols.length - 1, (i < 0 ? 0 : i) + delta));
    ui.col = cols[j].key;
    refreshCursor();
  }

  function refreshCursor() {
    document.querySelectorAll('tbody tr').forEach((tr) => {
      const on = tr.getAttribute('data-id') === ui.rowId;
      tr.classList.toggle('cursor-row', on);
      tr.querySelectorAll('td').forEach((td) => {
        td.classList.toggle('cursor-cell', on && td.getAttribute('data-col') === ui.col);
      });
    });
    scrollCursorIntoView(true);
  }

  /**
   * カーソルを画面内に入れる。
   * scrollIntoView は縦だけを指定できないので、自前で計算する。
   * 描画のたびに横スクロールすると左端の列が勝手に隠れてしまうため、
   * 横方向はカーソルを動かしたときだけ追いかける。
   */
  function scrollCursorIntoView(horizontal) {
    const wrap = app.querySelector('.tablewrap');
    if (!wrap) return;
    const cell = wrap.querySelector('td.cursor-cell');
    if (!cell) return;
    const c = cell.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    const head = wrap.querySelector('thead');
    const headH = head ? head.getBoundingClientRect().height : 0;

    if (c.top < w.top + headH) wrap.scrollTop -= w.top + headH - c.top;
    else if (c.bottom > w.bottom) wrap.scrollTop += c.bottom - w.bottom;

    if (!horizontal) return;
    if (c.left < w.left) wrap.scrollLeft -= w.left - c.left;
    else if (c.right > w.right) wrap.scrollLeft += c.right - w.right;
  }

  // ------------------------------------------------------------ ヘッダ

  function stat(k, v, cls) {
    return el('span', { class: `stat${cls ? ' ' + cls : ''}` }, [
      el('span', { class: 'k', text: k }),
      el('span', { class: 'v', text: v }),
    ]);
  }

  function renderHead() {
    const s = state.summary;
    const isToday = state.baseDate === state.today;
    const cs = state.currentSection;

    const line1 = el('div', { class: 'head-row' }, [
      el('span', { class: `mode-badge ${ui.mode}`, text: ui.mode === 'edit' ? 'EDIT' : 'NORMAL' }),
      el('span', { class: 'date', text: `${state.baseDate} (${state.baseWeekday})` }),
      el('span', {
        class: `today-flag${isToday ? '' : ' moved'}`,
        text: isToday ? 'base = today' : 'base date moved - press T for today',
      }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'now' }, [
        el('span', { class: 'label', text: 'Now' }),
        el('span', { class: 'clock', text: state.nowHhmm }),
      ]),
      el('span', { class: 'cursec' }, cs
        ? [
            el('span', { class: 'label', text: 'Sec' }),
            el('span', { class: 'key', text: cs.key }),
            el('span', { class: 'name', text: cs.label }),
            el('span', { class: 'range', text: `${cs.start}-${cs.end}` }),
            el('span', { class: 'remain', text: cs.remainMin === null ? '' : `${cs.remainMin}m left` }),
          ]
        : [el('span', { class: 'label', text: 'Sec' }), el('span', { class: 'name', text: 'outside sections' })]),
      el('span', { class: 'eta' }, [
        el('span', { class: 'label', text: 'ETA' }),
        el('span', { class: `value${s.etaMin >= 22 * 60 ? ' over' : ''}`, text: clock(s.etaMin) }),
      ]),
    ]);

    const line2 = el('div', { class: 'head-row' }, [
      el('div', { class: 'stats' }, [
        stat('Est', `${dur(s.estMin)} (${s.estCount})`),
        stat('Done', `${dur(s.doneMin)} (${s.doneCount})`),
        stat('Left', `${dur(s.remainMin)} (${s.remainCount})`),
        stat('Act', dur(s.actualSum)),
        s.leftoverCount > 0 ? stat('Carryover', `${dur(s.leftoverMin)} (${s.leftoverCount})`, 'leftover') : null,
      ]),
    ]);

    const line3 = el('div', { class: 'head-row' }, [
      el(
        'div',
        { class: 'secbar' },
        state.sections.map((x) =>
          el(
            'span',
            {
              class: `sec ${x.color}${x.current ? ' current' : ''}`,
              title: `${x.start}-${x.end} / cap ${dur(x.capacity)} / ${x.count} tasks (${x.pending} pending)`,
            },
            [
              el('span', { class: 'k', text: x.key }),
              document.createTextNode(dur(x.estMin) || '0:00'),
              el('span', { class: 'cap', text: ` /${dur(x.capacity)}` }),
            ]
          )
        )
      ),
    ]);

    const line4 = el('div', { class: 'head-row' }, [
      el(
        'div',
        { class: 'forecast' },
        [el('span', { class: 'label', text: 'Ahead' })].concat(
          state.forecast.map((f) =>
            el('span', {
              class: `f${f.estMin >= 600 ? ' busy' : ''}`,
              text: `${f.date.slice(5)}(${f.weekday}) ${dur(f.estMin) || '-'}`,
            })
          )
        )
      ),
    ]);

    // 期限の警告と絞り込みの状態。どちらも無いときは行ごと出さない
    const notices = [];
    const alert = state.dueAlert || { overdue: 0, today: 0, total: 0 };
    if (alert.total > 0) {
      notices.push(
        el('span', { class: 'notice due' }, [
          el('span', { class: 'k', text: 'Due' }),
          alert.overdue > 0 ? el('span', { class: 'v over', text: `${alert.overdue} overdue` }) : null,
          alert.today > 0 ? el('span', { class: 'v', text: `${alert.today} due today` }) : null,
        ])
      );
    }
    const f = state.filter || {};
    if (f.active) {
      const parts = [];
      if (f.onlyPending) parts.push('Pending only');
      if (f.project) parts.push(`Project=${f.project}`);
      if (f.mode) parts.push(`Mode=${f.mode}`);
      notices.push(
        el('span', { class: 'notice filter' }, [
          el('span', { class: 'k', text: 'Filter' }),
          el('span', { class: 'v', text: parts.join(' / ') }),
          el('span', { class: 'count', text: `${f.shown} of ${f.total}` }),
          el('span', { class: 'off', text: 'Shift+F to clear' }),
        ])
      );
    }
    const noticeRow = notices.length ? el('div', { class: 'head-row' }, notices) : null;

    const hints = ui.mode === 'edit'
      ? 'Enter commit / Tab commit and move right / Esc cancel' +
        (COMBO_COLS[ui.col] ? ' / arrow keys pick a suggestion' : '') +
        (ui.col === 'date' || ui.col === 'due' ? ' / Ctrl+Space calendar' : '')
      : 'hjkl move  i edit  s start  e end  t carry  n add  d date  O note  r repeat  f pending  P/M filter  ? help';

    const line5 = el('div', { class: 'head-row' }, [el('div', { class: 'keyhint', text: hints })]);

    return el('div', { class: 'head' }, [line1, line2, line3, line4, noticeRow, line5].filter(Boolean));
  }

  // ------------------------------------------------------------ 表

  function cellText(r, key) {
    switch (key) {
      case 'status':
        return r.status;
      case 'date':
        return r.dateLabel;
      case 'due':
        return r.dueLabel;
      case 'section':
        return r.section || '·';
      case 'no':
        return String(r.no || '');
      case 'star':
        return r.star ? '★' : '☆';
      case 'project':
        return r.project;
      case 'mode':
        return r.mode;
      case 'name':
        return r.displayName;
      case 'memo':
        return r.hasNote ? '●' : '';
      case 'estimate':
        return r.estimateMin === '' || r.estimateMin === null ? '' : String(r.estimateMin);
      case 'actual':
        return r.running ? dur(r.elapsedMin) : dur(r.actualMin);
      case 'start':
        return r.start;
      case 'end':
        return r.end;
      case 'sectionSort':
        return r.sectionSort;
      case 'hint':
        return r.hint;
      case 'comment':
        return r.comment;
      default:
        return '';
    }
  }

  /** 編集を始めるときに入力欄へ入れる初期値 */
  function editValue(r, key) {
    if (key === 'date' || key === 'due') return '';
    if (key === 'estimate') return r.estimateMin === '' || r.estimateMin === null ? '' : String(r.estimateMin);
    if (key === 'name') return r.name;
    if (key === 'memo') return r.notePath;
    return cellText(r, key) === '·' ? '' : cellText(r, key);
  }

  function editPlaceholder(r, key) {
    if (key === 'date') return `${r.dateLabel}  ->  9/7  +1  w  tue  tomorrow`;
    if (key === 'due') return `${r.dueLabel || 'no due date'}  ->  9/12  +3  w   (empty to clear)`;
    if (key === 'memo') return 'note path (empty to unlink)';
    if (key === 'estimate') return '90 / 1.5h / 1:30';
    if (key === 'start' || key === 'end') return '--:--';
    if (key === 'sectionSort') return '0815';
    return '';
  }

  function renderRow(r, prev) {
    const cls = [
      r.done ? 'done' : '',
      r.isToday ? 'today' : r.status === '★' ? 'past' : 'future',
      r.isDivider ? 'divider' : '',
      r.running ? 'running' : '',
      prev && prev.date !== r.date ? 'daysep' : '',
      r.id === ui.rowId ? 'cursor-row' : '',
    ]
      .filter(Boolean)
      .join(' ');

    const tds = columns().map((c) => {
      const isCursor = r.id === ui.rowId && c.key === ui.col;
      const td = el('td', {
        class: `col-${c.key}${isCursor ? ' cursor-cell' : ''}${READONLY_COLS[c.key] ? ' ro' : ''}`,
        'data-col': c.key,
      });
      // 作業内容は余った幅を吸わせるので、幅を指定しない
      if (c.width && c.key !== 'name') td.style.width = `${c.width}px`;

      if (isCursor && ui.mode === 'edit') {
        const input = el('input', {
          class: 'cell-edit',
          type: 'text',
          id: 'cell-edit',
          placeholder: editPlaceholder(r, c.key),
          autocomplete: 'off',
          spellcheck: 'false',
          oninput: (ev) => {
            ui.draft = ev.target.value;
            if (COMBO_COLS[ui.col]) {
              buildCombo(ui.draft);
              renderOverlay();
            }
          },
        });
        input.value = ui.draft;
        td.appendChild(input);
      } else {
        const span = el('span', { class: 'cv', text: cellText(r, c.key) });
        if (c.key === 'mode' && r.modeColor) {
          span.classList.add('chip');
          span.style.background = r.modeColor;
          if (r.modeTextColor) span.style.color = r.modeTextColor;
        }
        if (c.key === 'star') span.classList.add(r.star ? 'on' : 'off');
        if (c.key === 'actual' && r.running) span.classList.add('live');
        if (c.key === 'due' && r.dueState && r.dueState !== 'none') span.classList.add(`due-${r.dueState}`);
        td.appendChild(span);
      }
      return td;
    });

    return el('tr', { class: cls, 'data-id': r.id }, tds);
  }

  function renderTable() {
    const cols = columns();
    const thead = el('thead', {}, [
      el(
        'tr',
        {},
        cols.map((c) => {
          const th = el('th', { class: `col-${c.key}`, text: c.label });
          if (c.width && c.key !== 'name') th.style.width = `${c.width}px`;
          return th;
        })
      ),
    ]);
    const tbody = el('tbody', {}, []);
    let prev = null;
    for (const r of rows()) {
      tbody.appendChild(renderRow(r, prev));
      prev = r;
    }
    const table = el('table', {}, [thead, tbody]);
    // 幅に余裕があれば作業内容が広がり、足りなければ横スクロールする
    const minWidth = cols.reduce((a, c) => a + (Number(c.width) || 60), 0);
    table.style.minWidth = `${minWidth}px`;

    return el('div', { class: 'tablewrap' }, [
      rows().length === 0
        ? el('div', { class: 'empty', text: 'No tasks. Press n to add one.' })
        : table,
    ]);
  }

  // ------------------------------------------------------------ 候補リスト

  function comboSource() {
    if (!state) return [];
    if (ui.col === 'section') {
      return state.config.sections.map((s) => ({
        value: s.key,
        label: `${s.key}  ${s.label || ''}`,
        detail: `${s.start}-${s.end}`,
      }));
    }
    if (ui.col === 'project') return (state.config.projects || []).map((p) => ({ value: p, label: p, detail: '' }));
    if (ui.col === 'mode') return (state.config.modes || []).map((m) => ({ value: m.name, label: m.name, detail: '' }));
    if (ui.col === 'name') return (state.names || []).map((n) => ({ value: n, label: n, detail: '' }));
    return [];
  }

  /**
   * 候補を組み立てる。
   * @param {string} text 絞り込み文字列
   * @param {string} [current] 編集開始時の値。空欄で開いたときはこれを選択状態にする
   */
  function buildCombo(text, current) {
    const q = String(text || '').trim().toLowerCase();
    const src = comboSource();
    let items;
    if (!q) {
      items = src.slice(0, 12);
      // 現在の値が候補の後ろに埋もれていたら先頭に出す
      if (current && !items.some((x) => x.value === current)) {
        const hit = src.find((x) => x.value === current);
        if (hit) items = [hit].concat(items).slice(0, 12);
      }
    } else {
      const starts = src.filter((x) => x.value.toLowerCase().startsWith(q));
      const includes = src.filter((x) => !x.value.toLowerCase().startsWith(q) && x.value.toLowerCase().includes(q));
      items = starts.concat(includes).slice(0, 12);
    }
    let index = items.length > 0 ? 0 : -1;
    if (!q && current) {
      const i = items.findIndex((x) => x.value === current);
      if (i >= 0) index = i;
    }
    ui.combo = { items, index };
  }

  function renderCombo() {
    if (!ui.combo || ui.combo.items.length === 0) return null;
    return el(
      'div',
      { class: 'combo' },
      ui.combo.items.map((it, i) =>
        el('div', { class: `combo-item${i === ui.combo.index ? ' sel' : ''}` }, [
          el('span', { class: 'l', text: it.label }),
          it.detail ? el('span', { class: 'd', text: it.detail }) : null,
        ])
      )
    );
  }

  // ------------------------------------------------------------ カレンダー

  function renderCalendar() {
    const cur = ui.calendar.cursor;
    const d = parseDate(cur);
    if (!d) return null;
    const year = d.getFullYear();
    const month = d.getMonth();
    const first = new Date(year, month, 1);
    const lead = first.getDay();
    const lastDay = new Date(year, month + 1, 0).getDate();
    const busy = new Set(state.busyDates || []);
    const row = currentRow();

    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(el('div', { class: 'cal-day blank' }));
    for (let day = 1; day <= lastDay; day++) {
      const ds = fmtDate(new Date(year, month, day));
      const cls = ['cal-day'];
      if (ds === cur) cls.push('cursor');
      if (ds === state.today) cls.push('today');
      if (ds === state.baseDate) cls.push('base');
      if (row && ds === row.date) cls.push('value');
      const wd = new Date(year, month, day).getDay();
      if (wd === 0) cls.push('sun');
      if (wd === 6) cls.push('sat');
      cells.push(
        el('div', { class: cls.join(' ') }, [
          el('span', { class: 'n', text: String(day) }),
          busy.has(ds) ? el('span', { class: 'dot' }) : null,
        ])
      );
    }

    return el('div', { class: 'calendar' }, [
      el('div', { class: 'cal-head' }, [
        el('span', { class: 'ym', text: `${MONTHS[month]} ${year}` }),
        el('span', { class: 'sel', text: `${cur} ${WEEKDAY[d.getDay()]}` }),
      ]),
      el(
        'div',
        { class: 'cal-grid' },
        WEEKDAY.map((w, i) =>
          el('div', { class: `cal-wd${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}`, text: w })
        ).concat(cells)
      ),
      el('div', {
        class: 'cal-hint',
        text: 'arrows: day / week   PageUp-Down: month   Home: today   Enter: pick   Esc: cancel',
      }),
    ]);
  }

  // ------------------------------------------------------------ 重ね表示

  function renderOverlay() {
    overlay.replaceChildren();
    if (ui.calendar) {
      overlay.appendChild(el('div', { class: 'overlay-center' }, [renderCalendar()]));
      return;
    }
    if (ui.mode === 'edit' && COMBO_COLS[ui.col]) {
      const combo = renderCombo();
      if (!combo) return;
      const cell = document.querySelector('td.cursor-cell');
      if (!cell) return;
      const r = cell.getBoundingClientRect();
      const box = el('div', { class: 'overlay-anchor' }, [combo]);
      box.style.left = `${Math.max(4, r.left)}px`;
      box.style.top = `${r.bottom}px`;
      box.style.minWidth = `${Math.max(160, r.width)}px`;
      overlay.appendChild(box);
    }
  }

  // ------------------------------------------------------------ 描画

  function render() {
    if (!state) return;
    ensureCursor();
    // 描画で作り直すとスクロール位置が失われるので、覚えておいて戻す
    const old = app.querySelector('.tablewrap');
    const keep = old ? { left: old.scrollLeft, top: old.scrollTop } : null;
    app.replaceChildren(renderHead(), renderTable());
    if (keep) {
      const wrap = app.querySelector('.tablewrap');
      if (wrap) {
        wrap.scrollLeft = keep.left;
        wrap.scrollTop = keep.top;
      }
    }
    renderOverlay();
    if (ui.mode === 'edit') {
      const input = document.getElementById('cell-edit');
      if (input) {
        input.focus();
        try {
          // 候補のある列は打ち直しが多いので全選択、a で入ったときは末尾へ
          if (COMBO_COLS[ui.col] && !ui.caretToEnd) input.select();
          else input.setSelectionRange(input.value.length, input.value.length);
        } catch (e) {
          /* 数値入力などは選択範囲を持てない */
        }
      }
    }
    scrollCursorIntoView(false); // 縦だけ合わせる
  }

  // ------------------------------------------------------------ 編集の開始と確定

  function startEdit(caretToEnd) {
    const r = currentRow();
    if (!r) return;
    if (READONLY_COLS[ui.col]) return;
    ui.mode = 'edit';
    ui.draft = editValue(r, ui.col);
    ui.caretToEnd = !!caretToEnd;
    // 候補は全部出したうえで、いまの値を選択状態にしておく
    if (COMBO_COLS[ui.col]) buildCombo('', ui.draft);
    else ui.combo = null;
    render();
  }

  function cancelEdit() {
    ui.mode = 'normal';
    ui.combo = null;
    ui.draft = '';
    render();
  }

  /**
   * 入力内容を確定して拡張機能へ送る。
   * 手元の state も先に書き換えて、返事を待たずに表示が追いつくようにする
   * (月日と見積は拡張機能側で解釈するので、返ってきた state に任せる)。
   */
  function commitEdit() {
    const r = currentRow();
    if (!r) return;
    let value = ui.draft;
    if (COMBO_COLS[ui.col] && ui.combo && ui.combo.index >= 0 && ui.combo.items.length > 0) {
      value = ui.combo.items[ui.combo.index].value;
    }
    const patch = {};
    if (ui.col === 'date') {
      if (String(value).trim() === '') return; // 空欄なら変更しない
      patch.dateText = value;
    } else if (ui.col === 'due') {
      patch.dueText = value; // 空欄は「期限なし」に戻す指示
    } else if (ui.col === 'estimate') {
      patch.estimateText = value;
    } else if (ui.col === 'no') {
      patch.no = value;
      r.no = Number(value) || 0;
    } else if (ui.col === 'memo') {
      patch.notePath = value;
      r.notePath = value;
      r.hasNote = !!value;
    } else {
      patch[ui.col] = value;
      r[ui.col] = value;
      if (ui.col === 'name') r.displayName = `${r.fixedSection ? '【' + r.fixedSection + '】' : ''}${value}${r.repeat ? ' (repeats)' : ''}`;
      if (ui.col === 'mode') {
        const m = (state.config.modes || []).find((x) => x.name === value);
        r.modeColor = m ? m.color : '';
        r.modeTextColor = m ? m.textColor : '';
      }
    }
    post('patch', { id: r.id, patch });
  }

  // ------------------------------------------------------------ カレンダー操作

  /** 月日セルと期限セルの両方で使う */
  function openCalendar() {
    const r = currentRow();
    if (!r) return;
    const forDue = ui.col === 'due';
    ui.calendar = { cursor: forDue ? r.due || state.baseDate : r.date, field: forDue ? 'due' : 'date' };
    renderOverlay();
  }

  function closeCalendar() {
    ui.calendar = null;
    renderOverlay();
  }

  function calendarKey(e) {
    const k = e.key;
    const move = (n) => {
      ui.calendar.cursor = addDays(ui.calendar.cursor, n);
      renderOverlay();
    };
    if (k === 'ArrowLeft' || k === 'h') return move(-1), true;
    if (k === 'ArrowRight' || k === 'l') return move(1), true;
    if (k === 'ArrowUp' || k === 'k') return move(-7), true;
    if (k === 'ArrowDown' || k === 'j') return move(7), true;
    if (k === 'PageUp') {
      ui.calendar.cursor = addMonths(ui.calendar.cursor, -1);
      renderOverlay();
      return true;
    }
    if (k === 'PageDown') {
      ui.calendar.cursor = addMonths(ui.calendar.cursor, 1);
      renderOverlay();
      return true;
    }
    if (k === 'Home') {
      ui.calendar.cursor = state.today;
      renderOverlay();
      return true;
    }
    if (k === 'Enter') {
      const r = currentRow();
      const picked = ui.calendar.cursor;
      const field = ui.calendar.field === 'due' ? 'dueText' : 'dateText';
      closeCalendar();
      if (ui.mode === 'edit') cancelEdit();
      if (r) {
        const patch = {};
        patch[field] = picked;
        post('patch', { id: r.id, patch });
      }
      return true;
    }
    if (k === 'Escape') {
      closeCalendar();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ キー処理

  function editKey(e) {
    const k = e.key;
    const hasCombo = COMBO_COLS[ui.col] && ui.combo && ui.combo.items.length > 0;

    if (k === 'Escape') {
      if (hasCombo && ui.combo.index >= 0) {
        ui.combo.index = -1; // 一度目は候補の選択だけ外す
        renderOverlay();
        return true;
      }
      cancelEdit();
      return true;
    }
    if ((ui.col === 'date' || ui.col === 'due') && e.ctrlKey && (k === ' ' || e.code === 'Space')) {
      openCalendar();
      return true;
    }
    if (hasCombo && (k === 'ArrowDown' || (e.ctrlKey && k === 'n'))) {
      ui.combo.index = Math.min(ui.combo.items.length - 1, ui.combo.index + 1);
      renderOverlay();
      return true;
    }
    if (hasCombo && (k === 'ArrowUp' || (e.ctrlKey && k === 'p'))) {
      ui.combo.index = Math.max(0, ui.combo.index - 1);
      renderOverlay();
      return true;
    }
    if (k === 'Enter') {
      commitEdit();
      ui.mode = 'normal';
      ui.combo = null;
      render();
      return true;
    }
    if (k === 'Tab') {
      commitEdit();
      const cols = columns();
      const i = colIndex();
      let j = i + (e.shiftKey ? -1 : 1);
      while (j >= 0 && j < cols.length && READONLY_COLS[cols[j].key]) j += e.shiftKey ? -1 : 1;
      ui.combo = null;
      if (j >= 0 && j < cols.length) {
        ui.col = cols[j].key;
        startEdit(false); // 隣のセルの編集をそのまま続ける
      } else {
        ui.mode = 'normal';
        render();
      }
      return true;
    }
    return false; // それ以外は input にそのまま流す
  }

  function normalKey(e) {
    const k = e.key;
    const r = currentRow();

    // 移動
    if (k === 'h' || k === 'ArrowLeft') return moveCol(-1), true;
    if (k === 'l' || k === 'ArrowRight') return moveCol(1), true;
    if (k === 'j' || k === 'ArrowDown') return moveRow(1), true;
    if (k === 'k' || k === 'ArrowUp') return moveRow(-1), true;
    if (k === '0') {
      const cols = columns();
      if (cols.length) ui.col = cols[0].key;
      refreshCursor();
      return true;
    }
    if (k === '$') {
      const cols = columns();
      if (cols.length) ui.col = cols[cols.length - 1].key;
      refreshCursor();
      return true;
    }

    // 編集
    if (k === 'i') return startEdit(false), true;
    if (k === 'a') return startEdit(true), true;
    if (k === 'Enter') {
      if (!r) return true;
      if (ui.col === 'star') post('toggleStar', { id: r.id });
      else if (ui.col === 'date' || ui.col === 'due') openCalendar();
      else if (ui.col === 'memo') post('openNote', { id: r.id });
      else if (!READONLY_COLS[ui.col]) startEdit(false);
      return true;
    }
    if (e.ctrlKey && (k === ' ' || e.code === 'Space')) {
      if (r) openCalendar();
      return true;
    }

    // 打刻
    if (k === 's') return r && post('stamp', { id: r.id, field: 'start' }), true;
    if (k === 'e') return r && post('stamp', { id: r.id, field: 'end' }), true;
    if (k === 'S') return r && post('clearStamp', { id: r.id, field: 'start' }), true;
    if (k === 'E') return r && post('clearStamp', { id: r.id, field: 'end' }), true;
    if (k === 't') return r && post('carryStart', { id: r.id }), true;

    // 行の操作
    if (k === 'n') return post('add', { id: ui.rowId, position: 'above' }), true;
    if (k === 'N') return post('add', { id: ui.rowId, position: 'below' }), true;
    if (k === 'c') return r && post('duplicate', { id: r.id }), true;
    if (k === 'x') return r && post('delete', { id: r.id }), true;
    if (k === '*') return r && post('toggleStar', { id: r.id }), true;
    if (k === 'd') return r && post('changeDate', { id: r.id }), true;
    if (k === 'r') return r && post('repeatSettings', { id: r.id }), true;
    if (k === 'b') return r && post('fixedSection', { id: r.id }), true;
    if (k === '/') return r && post('searchName', { id: r.id }), true;
    if (k === 'm') return r && post('simulate', { id: r.id }), true;
    if (k === 'H') return r && post('editHint', { id: r.id }), true;
    if (k === 'o') return r && r.hintLink && post('openLink', { id: r.id }), true;
    if (k === 'O') return r && post('openNote', { id: r.id }), true;

    // 全体
    if (k === '1') return post('sort', { mode: 'fast' }), true;
    if (k === '2') return post('sort', { mode: 'normal' }), true;
    if (k === '3') return post('sort', { mode: 'full' }), true;
    if (k === ',') return post('shiftBaseDate', { delta: -1 }), true;
    if (k === '.') return post('shiftBaseDate', { delta: 1 }), true;
    if (k === 'T') return post('setBaseDate', { date: state.today }), true;
    if (k === 'g') return post('openDailyNote', { date: state.baseDate }), true;
    if (k === 'p') return post('togglePastDone'), true;

    // 絞り込み
    if (k === 'f') return post('toggleOnlyPending'), true;
    if (k === 'P') return post('filterBy', { field: 'project' }), true;
    if (k === 'M') return post('filterBy', { field: 'mode' }), true;
    if (k === 'F') return post('clearFilter'), true;

    if (k === 'C') return post('openConfig'), true;
    if (k === 'I') return post('addIdle', { id: ui.rowId }), true;
    if (k === '\\') {
      ui.showAllCols = !ui.showAllCols;
      render();
      return true;
    }
    if (k === 'F5') return post('reload'), true;
    if (k === '?') return showHelp(), true;
    return false;
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (!state) return;

      if (dialogEl.open) {
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === 'q') {
          dialogEl.close();
          e.preventDefault();
        }
        return;
      }

      if (ui.calendar) {
        if (calendarKey(e)) e.preventDefault();
        return;
      }

      // 行の入れ替えはどちらのモードでも
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'k' || e.key === 'j')) {
        if (ui.rowId) post('move', { id: ui.rowId, dir: e.key === 'ArrowUp' || e.key === 'k' ? 'up' : 'down' });
        e.preventDefault();
        return;
      }
      if (e.ctrlKey && (e.key === ':' || e.key === ';' || e.code === 'Semicolon' || e.code === 'Quote')) {
        const r = currentRow();
        if (r) post('stamp', { id: r.id, field: r.start ? 'end' : 'start' });
        e.preventDefault();
        return;
      }

      if (ui.mode === 'edit') {
        if (editKey(e)) e.preventDefault();
        return;
      }
      if (normalKey(e)) e.preventDefault();
    },
    true
  );

  // 画面のどこをクリックしてもキー入力が拾えるように、常に本体へ焦点を戻す
  document.addEventListener('mousedown', (e) => {
    if (ui.mode !== 'edit') e.preventDefault();
  });

  // ------------------------------------------------------------ ヘルプ

  function showHelp() {
    dialogBody.innerHTML = `
      <h3>Keyboard</h3>
      <pre>-- NORMAL mode -------------------------------------------
h j k l      move between cells / rows (arrow keys work too)
0 / $        first / last cell of the row
i / a        edit this cell (a puts the caret at the end)
Enter        edit. Calendar on Date/Due, toggle on Star,
             open the note on Note

s / e        stamp start / end        S / E   clear a stamp
Ctrl+:       stamp start, then end
t            carry the previous task's end time into start

n / N        add a task above / below   I   insert Idling
c / x        duplicate / delete         *   star
d            change-date dialog         Ctrl+Space  calendar
r / b        repeat settings / pin to a section
/            search input (pick from past task names)
m            estimate simulation
H / o        edit hint / open the hint link
O            open the note (.md). If there is none, pick a
             template and create it. Enter on the Note cell
             does the same. Edit the Note cell with i to
             relink, or clear it to unlink.

1 / 2 / 3    Quick / Normal / Full sort
, / . / T    base date: previous / next / today
g            daily note               C   config file
p            also show past completed \   show hidden columns
Alt+j / k    move the row up / down
F5           reload                   ?   this help

-- Filters -----------------------------------------------
f            show only today's pending tasks (toggle)
P            filter by Project        M   filter by Mode
F            clear every filter
Totals (Est / ETA / section summary) always cover the whole
day, even while a filter is on, so you never misread how
much work is really left.

-- EDIT mode ---------------------------------------------
Enter        commit and go back to NORMAL
Tab          commit and move right (Shift+Tab moves left)
Esc          cancel. With suggestions open, the first Esc
             only clears the highlighted suggestion
Up / Down    move through suggestions (Ctrl+p / Ctrl+n too)

-- Date and Due cells ------------------------------------
9/7  0907    Sep 7          7      the 7th of this month
+1  -1       tomorrow / yesterday   0   base date
w  w2        in 1 / 2 weeks   m  y     in a month / a year
tue          next Tuesday     tomorrow, today
2026-09-07   that exact date
On the Due cell only, committing an empty value clears it.

-- Due colors --------------------------------------------
red bold  overdue          red    due today
orange    within 2 days    grey   completed
Due is "by when", Date is "when I will do it".

-- Estimate cell -----------------------------------------
90           90 minutes     1.5h   90 minutes
1:30         90 minutes     45m    45 minutes

-- Section summary colors --------------------------------
blue   fits inside the section
red    over the limit, or a finished section still has
       pending tasks
grey   finished, nothing left
filled the section you are in right now</pre>`;
    dialogEl.showModal();
  }

  // ------------------------------------------------------------ 受信

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;

    if (msg.type === 'state') {
      const wasEditing = ui.mode === 'edit';
      state = msg.payload;
      if (wasEditing) {
        // 編集中に定期更新が来た。入力欄を壊さないようヘッダだけ差し替える
        const head = app.querySelector('.head');
        if (head) head.replaceWith(renderHead());
        return;
      }
      render();
      return;
    }

    if (msg.type === 'editCell') {
      ui.rowId = msg.id;
      ui.col = msg.col || 'name';
      ensureCursor();
      startEdit(false);
      return;
    }

    if (msg.type === 'simulation') {
      const p = msg.payload;
      dialogBody.replaceChildren(
        el('h3', { text: 'Estimate simulation' }),
        el('div', {
          class: 'big',
          text: `${p.target.name || '(untitled)'}: expected ${p.target.start} - ${p.target.end}`,
        }),
        el('pre', { text: `From ${p.base}\n\n${p.lines.join('\n')}` })
      );
      dialogEl.showModal();
      return;
    }
  });

  post('ready');
})();

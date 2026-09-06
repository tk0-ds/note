// @ts-check
'use strict';
/**
 * TaskChute のメイン画面 (Webview パネル)。
 * データはすべてこちら側 (拡張機能ホスト) が持ち、Webview には表示用の状態だけ渡す。
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const M = require('./model');
const { Store, COLUMN_ORDER } = require('./store');
const taskNote = require('./taskNote');
const daily = require('./dailyNote');

class TaskChutePanel {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {Store} store
   * @param {(dateStr:string)=>Promise<void>} openDailyNote
   */
  constructor(context, store, openDailyNote) {
    this.context = context;
    this.store = store;
    this.openDailyNote = openDailyNote;
    /** @type {vscode.WebviewPanel|null} */
    this.panel = null;
    this.baseDate = M.todayStr();
    this.tasks = [];
    this.loadedDates = [];
    this.showPastDone = false;
    /**
     * 表示の絞り込み。集計 (見積・終了予定時刻・節別サマリー) には影響させない。
     * 絞り込んだせいで一日の総量が小さく見えると、判断を誤るため。
     */
    this.filter = { onlyPending: false, project: '', mode: '' };
    this.tick = null;
  }

  dispose() {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    this.panel = null;
  }

  reveal() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const mediaRoot = vscode.Uri.file(path.join(this.context.extensionPath, 'media'));
    this.panel = vscode.window.createWebviewPanel('taskchute', 'TaskChute', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    });
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.context.subscriptions);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.context.subscriptions);
    this.load();
    // 終了予定時刻と実行中タスクの経過時間を動かすため、定期的に送り直す
    this.tick = setInterval(() => this.postState(), 20000);
  }

  // -------------------------------------------------------------- データ

  rangeDates() {
    const cfg = this.store.loadConfig();
    const past = Number((cfg.view && cfg.view.pastDays) || 7);
    const future = Number((cfg.view && cfg.view.futureDays) || 10);
    const from = M.addDays(this.baseDate, -past);
    const to = M.addDays(this.baseDate, future);
    const dates = [];
    let d = from;
    while (M.diffDays(d, to) >= 0) {
      dates.push(d);
      d = M.addDays(d, 1);
    }
    return dates;
  }

  load() {
    try {
      this.loadedDates = this.rangeDates();
      this.tasks = [];
      for (const d of this.loadedDates) this.tasks.push(...this.store.loadDay(d));
      this.regroup();
      this.postState();
    } catch (e) {
      vscode.window.showErrorMessage(`TaskChute: failed to load - ${e.message}`);
    }
  }

  /** 日付ごとにまとめ直す (日付内の順序は保つ) */
  regroup() {
    this.tasks = this.tasks
      .map((t, i) => ({ t, i }))
      .sort((a, b) => (a.t.date === b.t.date ? a.i - b.i : a.t.date < b.t.date ? -1 : 1))
      .map((x) => x.t);
  }

  save() {
    try {
      this.store.saveTasks(this.tasks, this.loadedDates);
    } catch (e) {
      vscode.window.showErrorMessage(`TaskChute: failed to save - ${e.message}`);
    }
  }

  find(id) {
    return this.tasks.find((t) => t.id === id) || null;
  }

  /** 絞り込みをかける前の、表に出しうるタスク */
  listedTasks() {
    return this.tasks.filter((t) => {
      const d = M.diffDays(this.baseDate, t.date);
      if (d < 0 && M.isDone(t) && !this.showPastDone) return false;
      return true;
    });
  }

  /** 絞り込みまで適用した表示対象 */
  visibleTasks() {
    const f = this.filter;
    if (!this.filterActive()) return this.listedTasks();
    return this.listedTasks().filter((t) => {
      // 「未完了だけ」= 完了と翌日以降を隠す。積み残しは終了予定時刻に効くので残す
      if (f.onlyPending && (M.isDone(t) || M.diffDays(this.baseDate, t.date) > 0)) return false;
      if (f.project && (t.project || '(none)') !== f.project) return false;
      if (f.mode && (t.mode || '(none)') !== f.mode) return false;
      return true;
    });
  }

  filterActive() {
    const f = this.filter;
    return !!(f.onlyPending || f.project || f.mode);
  }

  postState() {
    if (!this.panel) return;
    const cfg = this.store.loadConfig();
    const now = new Date();
    const nowMinute = M.nowMin(now);
    const list = this.visibleTasks();
    const modeMap = new Map((cfg.modes || []).map((m) => [m.name, m]));

    const rows = list.map((t) => {
      const mode = modeMap.get(t.mode) || null;
      const startMin = M.hhmmToMin(t.start);
      const running = startMin !== null && !M.isDone(t);
      let elapsedMin = null;
      if (running) {
        elapsedMin = nowMinute - startMin;
        if (elapsedMin < 0) elapsedMin += 24 * 60;
      }
      return {
        id: t.id,
        date: t.date,
        dateLabel: `${t.date.slice(5).replace('-', '/')} ${M.weekdayEn(t.date)}`,
        weekday: M.weekdayJa(t.date),
        due: t.due || '',
        dueLabel: t.due ? `${t.due.slice(5).replace('-', '/')} ${M.weekdayEn(t.due)}` : '',
        dueState: M.dueState(t, this.baseDate),
        notePath: t.notePath || '',
        hasNote: !!t.notePath,
        status: M.statusMark(t, this.baseDate),
        running,
        elapsedMin,
        section: t.section || '',
        no: t.no || 0,
        star: !!t.star,
        project: t.project || '',
        mode: t.mode || '',
        modeColor: mode ? mode.color : '',
        modeTextColor: mode ? mode.textColor : '',
        name: t.name || '',
        displayName: M.displayName(t),
        estimateMin: t.estimateMin === null || t.estimateMin === undefined ? '' : t.estimateMin,
        actualMin: M.actualMin(t),
        start: t.start || '',
        end: t.end || '',
        sectionSort: t.sectionSort || '',
        hint: t.hint || '',
        hintLink: t.hintLink || '',
        comment: t.comment || '',
        repeat: t.repeat || null,
        repeatLabel: M.repeatLabel(t.repeat),
        fixedSection: t.fixedSection || '',
        done: M.isDone(t),
        isToday: t.date === this.baseDate,
        isDivider: t.project === (cfg.dividerProject || '区切り'),
      };
    });

    this.panel.webview.postMessage({
      type: 'state',
      payload: {
        baseDate: this.baseDate,
        baseWeekday: M.weekdayEn(this.baseDate),
        today: M.todayStr(),
        nowMin: nowMinute,
        nowHhmm: M.minToHhmm(nowMinute),
        showPastDone: this.showPastDone,
        config: {
          sections: cfg.sections || [],
          projects: cfg.projects || [],
          modes: cfg.modes || [],
          dividerProject: cfg.dividerProject || '区切り',
          idleTaskName: cfg.idleTaskName || 'アイドリング',
        },
        columns: COLUMN_ORDER.map((key) => Object.assign({ key }, (cfg.columns || {})[key] || {})),
        currentSection: M.currentSectionInfo(cfg, nowMinute),
        filter: {
          onlyPending: this.filter.onlyPending,
          project: this.filter.project,
          mode: this.filter.mode,
          active: this.filterActive(),
          shown: list.length,
          total: this.listedTasks().length,
        },
        dueAlert: M.dueAlertCount(this.tasks, this.baseDate),
        rows,
        summary: M.daySummary(this.tasks, this.baseDate, nowMinute),
        sections: M.sectionSummary(this.tasks, cfg, this.baseDate, nowMinute),
        forecast: M.forecast(this.tasks, this.baseDate, Number((cfg.view && cfg.view.forecastDays) || 10)),
        names: this.store.nameIndex().slice(0, 400).map((n) => n.name),
        busyDates: this.store.datesWithTasks(),
      },
    });
  }

  // -------------------------------------------------------------- 操作

  async onMessage(msg) {
    if (!msg || !msg.type) return;
    try {
      await this.handle(msg);
    } catch (e) {
      vscode.window.showErrorMessage(`TaskChute: ${e.message}`);
    }
  }

  async handle(msg) {
    const cfg = this.store.loadConfig();
    switch (msg.type) {
      case 'ready':
        this.postState();
        return;

      case 'reload':
        this.store.invalidate();
        this.load();
        return;

      case 'patch': {
        const t = this.find(msg.id);
        if (!t) return;
        const before = { end: t.end, date: t.date };
        Object.assign(t, this.normalizePatch(msg.patch, t));
        if (!before.end && t.end) await this.onCompleted(t);
        if (before.date !== t.date) {
          // 日付が変わったら表示範囲の外に出ることがあるので読み直す
          this.regroup();
          this.renumberDate(t.date);
          this.save();
          this.load();
          return;
        }
        this.save();
        this.postState();
        return;
      }

      case 'stamp': {
        const t = this.find(msg.id);
        if (!t) return;
        const hhmm = M.nowHhmm();
        if (msg.field === 'start') {
          t.start = hhmm;
        } else {
          if (!t.start) t.start = hhmm;
          t.end = hhmm;
          await this.onCompleted(t);
        }
        this.save();
        this.postState();
        return;
      }

      case 'clearStamp': {
        const t = this.find(msg.id);
        if (!t) return;
        if (msg.field === 'start') t.start = '';
        else t.end = '';
        this.save();
        this.postState();
        return;
      }

      case 'carryStart': {
        // 直前のタスクの終了時刻を、このタスクの開始時刻に転記する (Ctrl+T 相当)
        const idx = this.tasks.findIndex((x) => x.id === msg.id);
        if (idx < 0) return;
        let src = null;
        for (let i = idx - 1; i >= 0; i--) {
          if (this.tasks[i].end) {
            src = this.tasks[i];
            break;
          }
        }
        if (!src) {
          vscode.window.showWarningMessage('No preceding task has an end time.');
          return;
        }
        this.tasks[idx].start = src.end;
        this.save();
        this.postState();
        return;
      }

      case 'add': {
        const anchor = msg.id ? this.find(msg.id) : null;
        const date = (anchor && anchor.date) || this.baseDate;
        // 絞り込み中に足したタスクがその場で消えないよう、条件を引き継ぐ
        const keep = (v) => (v && v !== '(none)' ? v : '');
        const t = M.newTask(date, {
          section: anchor ? anchor.section : this.currentSectionKey(cfg),
          project: msg.project || keep(this.filter.project),
          mode: keep(this.filter.mode),
          name: msg.name || '',
          estimateMin: msg.estimateMin === undefined ? null : msg.estimateMin,
          start: msg.start || '',
          end: msg.end || '',
        });
        const idx = anchor ? this.tasks.findIndex((x) => x.id === anchor.id) : this.tasks.length;
        const at = msg.position === 'below' ? idx + 1 : idx;
        this.tasks.splice(at < 0 ? this.tasks.length : at, 0, t);
        this.renumberDate(date);
        this.regroup();
        this.save();
        this.postState();
        this.panel.webview.postMessage({ type: 'editCell', id: t.id, col: 'name' });
        return;
      }

      case 'addIdle': {
        // 使途不明時間を埋めるタスク。見積 0 で選択行の上に入れる
        const anchor = msg.id ? this.find(msg.id) : null;
        const date = (anchor && anchor.date) || this.baseDate;
        const t = M.newTask(date, {
          section: anchor ? anchor.section : this.currentSectionKey(cfg),
          name: cfg.idleTaskName || 'アイドリング',
          estimateMin: 0,
        });
        const idx = anchor ? this.tasks.findIndex((x) => x.id === anchor.id) : this.tasks.length;
        this.tasks.splice(idx < 0 ? this.tasks.length : idx, 0, t);
        this.renumberDate(date);
        this.regroup();
        this.save();
        this.postState();
        this.panel.webview.postMessage({ type: 'editCell', id: t.id, col: 'start' });
        return;
      }

      case 'delete': {
        const t = this.find(msg.id);
        if (!t) return;
        const label = t.name || '(untitled)';
        const ok = await vscode.window.showWarningMessage(
          `Delete "${label}"?`,
          { modal: true },
          'Delete'
        );
        if (ok !== 'Delete') return;
        this.tasks = this.tasks.filter((x) => x.id !== msg.id);
        this.save();
        this.postState();
        return;
      }

      case 'duplicate': {
        const t = this.find(msg.id);
        if (!t) return;
        const c = M.newTask(t.date, {
          section: t.section,
          project: t.project,
          mode: t.mode,
          name: t.name,
          estimateMin: t.estimateMin,
          sectionSort: t.sectionSort,
          hint: t.hint,
          hintLink: t.hintLink,
          fixedSection: t.fixedSection,
        });
        const idx = this.tasks.findIndex((x) => x.id === t.id);
        this.tasks.splice(idx + 1, 0, c);
        this.renumberDate(t.date);
        this.save();
        this.postState();
        return;
      }

      case 'move': {
        // 表示上の 1 行だけ上/下に動かす (同じ日付の中でのみ)
        const idx = this.tasks.findIndex((x) => x.id === msg.id);
        if (idx < 0) return;
        const dir = msg.dir === 'up' ? -1 : 1;
        const j = idx + dir;
        if (j < 0 || j >= this.tasks.length) return;
        if (this.tasks[j].date !== this.tasks[idx].date) return;
        const tmp = this.tasks[idx];
        this.tasks[idx] = this.tasks[j];
        this.tasks[j] = tmp;
        this.renumberDate(tmp.date);
        this.save();
        this.postState();
        return;
      }

      case 'toggleStar': {
        const t = this.find(msg.id);
        if (!t) return;
        t.star = !t.star;
        this.save();
        this.postState();
        return;
      }

      case 'setBaseDate': {
        const d = M.parseDateStr(msg.date) ? msg.date : M.todayStr();
        this.baseDate = d;
        this.load();
        return;
      }

      case 'shiftBaseDate': {
        this.baseDate = M.addDays(this.baseDate, Number(msg.delta || 0));
        this.load();
        return;
      }

      case 'togglePastDone':
        this.showPastDone = !this.showPastDone;
        this.postState();
        return;

      case 'toggleOnlyPending':
        this.filter.onlyPending = !this.filter.onlyPending;
        this.postState();
        return;

      case 'clearFilter':
        this.filter = { onlyPending: false, project: '', mode: '' };
        this.postState();
        return;

      case 'filterBy': {
        const field = msg.field === 'mode' ? 'mode' : 'project';
        const label = field === 'mode' ? 'Mode' : 'Project';
        const listed = this.listedTasks();
        const values = new Set();
        for (const t of listed) values.add(t[field] || '(none)');
        const candidates = field === 'mode' ? (cfg.modes || []).map((m) => m.name) : cfg.projects || [];
        for (const v of candidates) values.add(v);
        const items = [{ label: 'Show all (clear this filter)', value: '' }].concat(
          Array.from(values)
            .sort()
            .map((v) => ({
              label: v,
              value: v,
              description: `${listed.filter((t) => (t[field] || '(none)') === v).length} tasks`,
            }))
        );
        const pick = await vscode.window.showQuickPick(items, {
          title: `Filter by ${label}`,
          placeHolder: this.filter[field] ? `Current: ${this.filter[field]}` : 'Current: no filter',
        });
        if (!pick) return;
        this.filter[field] = pick.value;
        this.postState();
        return;
      }

      case 'changeDate':
        await this.changeDate(msg.id);
        return;

      case 'sort':
        this.sort(msg.mode || 'normal');
        return;

      case 'repeatSettings':
        await this.repeatSettings(msg.id);
        return;

      case 'fixedSection':
        await this.fixedSection(msg.id);
        return;

      case 'searchName':
        await this.searchName(msg.id);
        return;

      case 'simulate':
        this.simulate(msg.id);
        return;

      case 'editHint':
        await this.editHint(msg.id);
        return;

      case 'openLink': {
        const t = this.find(msg.id);
        if (!t || !t.hintLink) return;
        await this.openLink(t.hintLink);
        return;
      }

      case 'openNote': {
        const t = this.find(msg.id);
        if (!t) return;
        await this.openTaskNote(t);
        return;
      }

      case 'openDailyNote':
        await this.openDailyNote(msg.date || this.baseDate);
        return;

      case 'openConfig': {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.store.configPath()));
        await vscode.window.showTextDocument(doc);
        return;
      }

      default:
        return;
    }
  }

  normalizePatch(patch, task) {
    const out = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === 'estimateMin') {
        const n = v === '' || v === null ? null : Number(v);
        out[k] = Number.isFinite(n) ? n : null;
      } else if (k === 'estimateText') {
        // '90' '1.5h' '1:30' などを分に直す。空欄は未設定に戻す
        out.estimateMin = String(v || '').trim() === '' ? null : M.estimateInput(v);
        if (out.estimateMin === null && String(v || '').trim() !== '') delete out.estimateMin;
      } else if (k === 'estimateHour') {
        const n = v === '' || v === null ? null : Number(v);
        out.estimateMin = Number.isFinite(n) ? Math.round(n * 60) : null;
      } else if (k === 'dateText') {
        // '9/7' '+1' 'w' '火' などの短縮入力
        const d = M.parseDateInput(v, (task && task.date) || this.baseDate, this.baseDate);
        if (d) out.date = d;
      } else if (k === 'dueText') {
        // 期限。空欄にすると期限なしに戻す
        const s = String(v === undefined || v === null ? '' : v).trim();
        if (s === '') {
          out.due = '';
        } else {
          const d = M.parseDateInput(s, (task && task.due) || this.baseDate, this.baseDate);
          if (d) out.due = d;
        }
      } else if (k === 'start' || k === 'end') {
        const min = M.hhmmToMin(v);
        out[k] = min === null ? '' : M.minToHhmm(min);
      } else if (k === 'star') {
        out[k] = !!v;
      } else if (k === 'no') {
        out[k] = Number(v) || 0;
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  currentSectionKey(cfg) {
    const s = M.sectionAtMinute(cfg, M.nowMin());
    return s ? s.key : '';
  }

  renumberDate(dateStr) {
    let n = 0;
    for (const t of this.tasks) {
      if (t.date !== dateStr) continue;
      n += 10;
      t.no = n;
    }
  }

  /** 完了した (終了時刻が入った) ときの後処理: 繰り返しタスクを次回分に複製する */
  async onCompleted(task) {
    if (!task.repeat) return;
    const clone = M.cloneForNextOccurrence(task);
    if (!clone) return;
    const seriesId = task.seriesId || task.id;
    clone.seriesId = seriesId;
    if (!task.seriesId) task.seriesId = seriesId;
    // 同じ系列が既にその日にあるなら作らない
    const inMemory = this.tasks.some((t) => t.date === clone.date && (t.seriesId || t.id) === seriesId);
    if (inMemory) return;
    if (this.loadedDates.includes(clone.date)) {
      this.tasks.push(clone);
      this.regroup();
      this.renumberDate(clone.date);
    } else {
      if (this.store.hasSeriesOn(clone.date, seriesId)) return;
      this.store.appendToDay(clone.date, clone);
    }
    vscode.window.setStatusBarMessage(`TaskChute: copied "${task.name}" to ${clone.date}`, 4000);
  }

  async changeDate(id) {
    const t = this.find(id);
    if (!t) return;
    const input = await vscode.window.showInputBox({
      title: `Change date: ${t.name || '(untitled)'}`,
      prompt: 'empty = tomorrow / 2 = in 2 days / -1 = yesterday / 0 = base date / w, m, y / 2/3 / 2026-02-03',
      value: '',
      placeHolder: 'tomorrow',
    });
    if (input === undefined) return;
    const next = M.applyDateChange(t.date, input, this.baseDate);
    t.date = next;
    t.start = '';
    t.end = '';
    this.regroup();
    this.renumberDate(next);
    this.save();
    this.load();
    vscode.window.setStatusBarMessage(`TaskChute: moved to ${next}`, 3000);
  }

  sort(mode) {
    const cfg = this.store.loadConfig();
    const nowMinute = M.nowMin();
    let moved = [];
    if (mode !== 'fast') {
      moved = M.pushDividers(this.tasks, cfg, this.baseDate, nowMinute);
    }
    const decorated = this.tasks.map((t, i) => ({ t, i }));
    decorated.sort((a, b) => {
      const c = M.compareTasks(a.t, b.t, cfg, this.baseDate);
      return c !== 0 ? c : a.i - b.i;
    });
    this.tasks = decorated.map((x) => x.t);
    M.renumber(this.tasks);
    this.save();
    this.load();
    const label = mode === 'fast' ? 'Quick' : mode === 'full' ? 'Full' : 'Normal';
    const extra = moved.length ? ` / ${moved.length} divider(s) pushed to tomorrow` : '';
    vscode.window.setStatusBarMessage(`TaskChute: ${label} sort${extra}`, 3000);
  }

  async repeatSettings(id) {
    const t = this.find(id);
    if (!t) return;
    const items = [
      { label: '$(circle-slash) Clear repeat', kind: 'none' },
      { label: 'Every day', kind: 'daily', interval: 1 },
      { label: 'Every N days...', kind: 'interval' },
      { label: 'Weekdays (Mon-Fri)', kind: 'weekdays' },
      { label: 'Pick weekdays...', kind: 'weekly' },
      { label: 'Monthly, same day', kind: 'monthly', interval: 1 },
      { label: 'Yearly, same day', kind: 'yearly', interval: 1 },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: `Repeat: ${t.name || '(untitled)'}`,
      placeHolder: t.repeat ? `Current: ${M.repeatLabel(t.repeat)}` : 'Current: no repeat',
    });
    if (!pick) return;
    if (pick.kind === 'none') {
      t.repeat = null;
    } else if (pick.kind === 'interval') {
      const v = await vscode.window.showInputBox({ title: 'Every how many days?', value: '2', validateInput: (s) => (/^\d+$/.test(s) && Number(s) > 0 ? null : 'Enter a number of 1 or more') });
      if (v === undefined) return;
      t.repeat = { kind: 'interval', interval: Number(v) };
    } else if (pick.kind === 'weekly') {
      const days = await vscode.window.showQuickPick(
        M.WEEKDAY_EN.map((w, i) => ({ label: w, index: i })),
        { canPickMany: true, title: 'Repeat on which weekdays' }
      );
      if (!days || days.length === 0) return;
      t.repeat = { kind: 'weekly', weekdays: days.map((d) => d.index) };
    } else if (pick.kind === 'monthly') {
      const d = M.parseDateStr(t.date);
      t.repeat = { kind: 'monthly', interval: 1, monthDay: d ? d.getDate() : 1 };
    } else {
      t.repeat = { kind: pick.kind, interval: pick.interval || 1 };
    }
    if (t.repeat && !t.seriesId) t.seriesId = t.id;
    this.save();
    this.postState();
  }

  async fixedSection(id) {
    const t = this.find(id);
    if (!t) return;
    const cfg = this.store.loadConfig();
    const items = [{ label: 'Z: clear', key: '' }].concat(
      (cfg.sections || []).map((s) => ({ label: `${s.key}: ${s.label || ''} ${s.start}-${s.end}`, key: s.key }))
    );
    const pick = await vscode.window.showQuickPick(items, {
      title: `Pin repeating task to a section: ${t.name || ''}`,
      placeHolder: t.fixedSection ? `Current: ${t.fixedSection}` : 'Current: none',
    });
    if (!pick) return;
    t.fixedSection = pick.key;
    this.save();
    this.postState();
  }

  async searchName(id) {
    const t = this.find(id);
    if (!t) return;
    const index = this.store.nameIndex();
    if (index.length === 0) {
      vscode.window.showInformationMessage('No past tasks yet.');
      return;
    }
    const items = index.map((n) => {
      const avg = n.actualCount > 0 ? Math.round(n.actualSum / n.actualCount) : null;
      const detail = [
        n.project ? `Project: ${n.project}` : '',
        n.mode ? `Mode: ${n.mode}` : '',
        n.estimateMin ? `Est ${n.estimateMin}m` : '',
        avg !== null ? `avg actual ${avg}m` : '',
      ]
        .filter(Boolean)
        .join(' / ');
      return { label: n.name, description: `${n.lastDate} · ${n.count}x`, detail, entry: n };
    });
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Search input: pick from past tasks',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!pick) return;
    const n = pick.entry;
    t.name = n.name;
    if (!t.project) t.project = n.project || '';
    if (!t.mode) t.mode = n.mode || '';
    if (t.estimateMin === null || t.estimateMin === undefined || t.estimateMin === '') {
      t.estimateMin = n.actualCount > 0 ? Math.round(n.actualSum / n.actualCount) : n.estimateMin;
    }
    this.save();
    this.postState();
  }

  simulate(id) {
    const sorted = this.visibleTasks();
    const r = M.simulate(sorted, id, this.baseDate, M.nowMin());
    if (!r.target) {
      vscode.window.showWarningMessage('Cannot simulate: this task is not among the pending ones.');
      return;
    }
    const lines = r.chain.map((c) => `${M.minToHhmm(c.from)} - ${M.minToHhmm(c.to)}  ${c.name || '(untitled)'} (${c.estMin}m)`);
    this.panel.webview.postMessage({
      type: 'simulation',
      payload: {
        base: M.minToHhmm(r.base),
        target: { name: r.target.name, start: M.minToHhmm(r.target.startMin), end: M.minToHhmm(r.target.endMin) },
        lines,
      },
    });
  }

  async editHint(id) {
    const t = this.find(id);
    if (!t) return;
    const memo = await vscode.window.showInputBox({
      title: `Hint before starting: ${t.name || ''}`,
      prompt: 'A note that helps you run this task',
      value: t.hint || '',
    });
    if (memo === undefined) return;
    const link = await vscode.window.showInputBox({
      title: 'Link (optional)',
      prompt: 'A file/folder path, or an http(s):// URL',
      value: t.hintLink || '',
    });
    if (link === undefined) return;
    t.hint = memo;
    t.hintLink = link;
    this.save();
    this.postState();
  }

  /** VS Code の設定から、メモまわりの置き場所を読む */
  noteConfig() {
    const c = vscode.workspace.getConfiguration('taskchute');
    return {
      folder: String(c.get('taskNote.folder') || 'notes'),
      templateFolder: String(c.get('taskNote.templateFolder') || '80_tamplate/task'),
      daily: {
        folder: String(c.get('dailyNote.folder') || '20_daily'),
        format: String(c.get('dailyNote.format') || 'YYYY/MM/DD'),
      },
    };
  }

  /**
   * タスクに紐づいたメモを開く。無ければテンプレートを選んで作る。
   * メモは任意なので、作らずに抜けても構わない。
   */
  async openTaskNote(task) {
    const cfgN = this.noteConfig();
    const root = this.store.root;

    // 既に紐づいているなら開くだけ
    if (task.notePath) {
      const p = path.join(root, task.notePath);
      if (fs.existsSync(p)) {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p));
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Note not found: ${task.notePath}`,
        { modal: true },
        'Recreate',
        'Unlink'
      );
      if (answer === 'Unlink') {
        task.notePath = '';
        this.save();
        this.postState();
        return;
      }
      if (answer !== 'Recreate') return;
    }

    // テンプレートを選ぶ
    const tplDir = path.join(root, cfgN.templateFolder);
    const created = taskNote.ensureTemplates(tplDir);
    if (created) {
      vscode.window.setStatusBarMessage(`TaskChute: sample templates created in ${cfgN.templateFolder}`, 5000);
    }
    const templates = taskNote.listTemplates(tplDir);
    let tplPath = null;
    if (templates.length === 1) {
      tplPath = templates[0].fsPath;
    } else if (templates.length > 1) {
      const pick = await vscode.window.showQuickPick(
        templates.map((t) => ({ label: t.name, description: cfgN.templateFolder, fsPath: t.fsPath })),
        { title: `Pick a note template: ${task.name || '(untitled)'}` }
      );
      if (!pick) return; // Esc で中止。メモは作らない
      tplPath = pick.fsPath;
    }

    const dailyPath = daily.notePathFor(root, cfgN.daily, task.date);
    const note = taskNote.createNote(root, cfgN, task, tplPath, dailyPath);
    task.notePath = note.rel;
    this.save();
    this.postState();
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(note.fsPath));
  }

  async openLink(link) {
    const s = String(link).trim();
    if (!s) return;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      await vscode.env.openExternal(vscode.Uri.parse(s));
      return;
    }
    const p = path.isAbsolute(s) ? s : path.join(this.store.root, s);
    if (!fs.existsSync(p)) {
      vscode.window.showWarningMessage(`Not found: ${p}`);
      return;
    }
    if (fs.statSync(p).isDirectory()) {
      await vscode.env.openExternal(vscode.Uri.file(p));
    } else {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p));
    }
  }

  // -------------------------------------------------------------- HTML

  html() {
    const w = this.panel.webview;
    const media = (f) => w.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', f)));
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const csp = `default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${media('main.css')}" rel="stylesheet">
<title>TaskChute</title>
</head>
<body>
<div id="app"></div>
<div id="overlay"></div>
<dialog id="dialog"><div id="dialog-body"></div><div class="dialog-foot">Esc または Enter で閉じる</div></dialog>
<script nonce="${nonce}" src="${media('main.js')}"></script>
</body>
</html>`;
  }
}

module.exports = { TaskChutePanel };

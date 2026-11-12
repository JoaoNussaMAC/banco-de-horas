/* Banco de Horas: app de ponto pessoal. Tudo fica gravado no próprio aparelho (IndexedDB). */
(function () {
  'use strict';

  // ---------- Armazenamento ----------
  var DB_NAME = 'banco-de-horas';
  var STORE = 'kv';
  var KEY = 'state';

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  var dbPromise = openDb();

  function dbGet() {
    return dbPromise.then(function (db) {
      return new Promise(function (resolve, reject) {
        var r = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }
  function dbPut(value) {
    return dbPromise.then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, KEY);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function emptyState() {
    return {
      v: 1,
      days: {},      // 'AAAA-MM-DD': { in: 'HH:MM', out: 'HH:MM' | null, lunch: true }
      notes: {},     // 'AAAA-MM-DD': 'texto'
      settings: { goal: 100, low: 70, lunchMin: 60 },
      meta: { lastBackup: null, goalShown: {}, lowShown: {} }
    };
  }
  function normalize(s) {
    var base = emptyState();
    s = s && typeof s === 'object' ? s : {};
    return {
      v: 1,
      days: s.days || {},
      notes: s.notes || {},
      settings: Object.assign(base.settings, s.settings || {}),
      meta: Object.assign(base.meta, s.meta || {})
    };
  }

  var state = emptyState();
  function save() {
    return dbPut(state).catch(function () { toast('Não consegui salvar. Tente de novo.'); });
  }

  // ---------- Datas e horas ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function keyOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseKey(k) { var p = k.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function ymOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function hhmm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function toMin(t) { var p = t.split(':'); return (+p[0]) * 60 + (+p[1]); }
  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function fmt(min) {
    min = Math.max(0, Math.round(min));
    return Math.floor(min / 60) + 'h ' + pad(min % 60);
  }
  function fmtLong(min) {
    min = Math.max(0, Math.round(min));
    var h = Math.floor(min / 60), m = min % 60;
    if (!m) return h + 'h';
    return h + 'h ' + pad(m) + 'min';
  }
  function fmtShort(min) { // para as células do calendário
    min = Math.max(0, Math.round(min));
    return Math.floor(min / 60) + 'h' + pad(min % 60);
  }
  var MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  var WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

  // Minutos brutos (sem descontar almoço) de um dia. Dia em aberto conta até agora.
  function grossMin(key, now) {
    var d = state.days[key];
    if (!d || !d.in) return 0;
    var start = toMin(d.in);
    var end;
    if (d.out) {
      end = toMin(d.out);
      if (end < start) end += 1440; // virou a meia-noite
    } else {
      if (!isOpen(key, now)) return 0;
      var base = parseKey(key);
      end = Math.floor((now - base) / 60000);
    }
    return Math.max(0, end - start);
  }
  function lunchFor(key, now) {
    var d = state.days[key];
    if (!d || !d.in || d.lunch === false) return 0;
    return Math.min(state.settings.lunchMin, grossMin(key, now));
  }
  // Horas lançadas à mão (sem horário de entrada/saída), em minutos.
  function manualMin(key) { var d = state.days[key]; return d && d.manual ? d.manual : 0; }
  function netMin(key, now) { return grossMin(key, now) - lunchFor(key, now) + manualMin(key); }
  function worked(key, now) { return grossMin(key, now) > 0 || manualMin(key) > 0; }
  function parseHM(v) { // "17:30", "17h30", "17,5" ou "17" → minutos
    v = String(v || '').trim().replace(/\s/g, '').toLowerCase();
    if (!v) return 0;
    var m = v.match(/^(\d{1,3})(?:[:h](\d{1,2})?)?(?:min)?$/);
    if (m) return (+m[1]) * 60 + (+(m[2] || 0));
    var f = parseFloat(v.replace(',', '.'));
    return isFinite(f) && f >= 0 ? Math.round(f * 60) : NaN;
  }

  // Um ponto em aberto só vale para hoje ou ontem (turno que passa da meia-noite).
  function isOpen(key, now) {
    var d = state.days[key];
    if (!d || !d.in || d.out) return false;
    var diff = Math.round((parseKey(keyOf(now)) - parseKey(key)) / 86400000);
    return diff === 0 || diff === 1;
  }
  function openKey(now) {
    var t = keyOf(now);
    if (isOpen(t, now)) return t;
    var y = new Date(now); y.setDate(y.getDate() - 1);
    var yk = keyOf(y);
    if (isOpen(yk, now) && !(state.days[t] && state.days[t].in)) return yk;
    return null;
  }

  function monthStats(y, m, now) {
    var total = 0, lunch = 0, days = 0;
    var n = daysInMonth(y, m);
    for (var i = 1; i <= n; i++) {
      var k = y + '-' + pad(m + 1) + '-' + pad(i);
      if (worked(k, now)) { days++; total += netMin(k, now); lunch += lunchFor(k, now); }
    }
    return { total: total, lunch: lunch, days: days };
  }

  // ---------- Utilidades de interface ----------
  function $(id) { return document.getElementById(id); }
  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2200);
  }
  function setBar(el, pct, cls) {
    el.className = 'bar' + (cls ? ' ' + cls : '');
    el.firstElementChild.style.width = Math.min(100, Math.max(0, pct)) + '%';
  }

  var ICON_WARN = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
  var ICON_OK = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>';

  var alertQueue = [];
  function showAlert(a) {
    alertQueue.push(a);
    if (alertQueue.length === 1) renderAlert();
  }
  function renderAlert() {
    var a = alertQueue[0];
    if (!a) { $('alert').hidden = true; return; }
    var ic = $('alert-ic');
    ic.innerHTML = a.kind === 'ok' ? ICON_OK : ICON_WARN;
    ic.style.background = a.kind === 'ok' ? 'var(--ok-bg)' : 'var(--warn-bg)';
    $('alert-title').textContent = a.title;
    $('alert-text').innerHTML = a.html;
    setBar($('alert-bar'), a.pct, a.kind === 'ok' ? 'done' : 'low');
    $('alert-ok').textContent = a.kind === 'ok' ? 'Show!' : 'Entendi';
    $('alert-ok').style.background = a.kind === 'ok' ? 'var(--ok)' : '';
    $('alert-ok').style.color = a.kind === 'ok' ? '#fff' : '';
    $('alert').hidden = false;
  }
  $('alert-ok').addEventListener('click', function () { alertQueue.shift(); renderAlert(); });

  // Avisos da meta
  function checkGoalReached(now) {
    var ym = ymOf(now);
    var st = monthStats(now.getFullYear(), now.getMonth(), now);
    var goalMin = state.settings.goal * 60;
    if (st.total >= goalMin && !state.meta.goalShown[ym]) {
      state.meta.goalShown[ym] = true;
      save();
      showAlert({
        kind: 'ok', title: 'Meta batida!', pct: 100,
        html: 'Você completou as <strong>' + state.settings.goal + 'h</strong> de ' + MONTHS[now.getMonth()] +
          '. O que passar disso aparece como hora extra no relatório.'
      });
    }
  }
  function checkLowOnOpen(now) {
    var y = now.getFullYear(), m = now.getMonth();
    var remaining = daysInMonth(y, m) - now.getDate() + 1; // dias que faltam, contando hoje
    if (remaining > 14) return;
    var st = monthStats(y, m, now);
    var lowMin = state.settings.low * 60, goalMin = state.settings.goal * 60;
    var tk = keyOf(now);
    if (st.total < lowMin && !state.meta.lowShown[tk]) {
      state.meta.lowShown[tk] = true;
      save();
      showAlert({
        kind: 'warn', title: 'Atenção com a meta', pct: st.total / goalMin * 100,
        html: 'Falta' + (remaining > 1 ? 'm ' + remaining + ' dias' : ' 1 dia') + ' para acabar ' + MONTHS[m] +
          ' e você está com <strong>' + fmtLong(st.total) + '</strong>. Ainda faltam <strong>' +
          fmtLong(goalMin - st.total) + '</strong> para chegar às ' + state.settings.goal + 'h.'
      });
    }
  }

  // ---------- Abas ----------
  var tab = 'ponto';
  function setTab(t) {
    tab = t;
    $('s-ponto').hidden = t !== 'ponto';
    $('s-cal').hidden = t !== 'cal';
    $('s-rel').hidden = t !== 'rel';
    document.querySelectorAll('nav.tabs button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === t);
      if (b.getAttribute('data-tab') === t) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    render();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('nav.tabs button').forEach(function (b) {
    b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
  });

  // ---------- Tela: Ponto ----------
  function renderPonto(now) {
    var h = now.getHours();
    $('greet').textContent = h < 12 ? 'Bom dia' : (h < 18 ? 'Boa tarde' : 'Boa noite');
    $('today-label').textContent = cap(WEEKDAYS[now.getDay()]) + ', ' + now.getDate() + ' de ' + MONTHS[now.getMonth()];

    var ok = openKey(now);
    var tk = keyOf(now);
    var shownKey = ok || tk;
    var d = state.days[shownKey] || {};
    var doneToday = !ok && d.in && d.out;

    var pill = $('status-pill');
    var btn = $('punch-btn');
    if (ok) {
      pill.className = 'pill on';
      pill.textContent = 'Trabalhando desde ' + d.in;
      btn.className = 'punch-btn out';
      $('punch-label').textContent = 'Bater saída';
      btn.disabled = false;
      $('punch-hint').textContent = 'Toque para registrar a saída. Dá para corrigir no Calendário.';
    } else if (doneToday) {
      pill.className = 'pill';
      pill.textContent = 'Expediente encerrado';
      btn.className = 'punch-btn';
      $('punch-label').textContent = 'Ponto batido';
      btn.disabled = true;
      $('punch-hint').textContent = 'Precisa ajustar? Abra o dia no Calendário.';
    } else {
      pill.className = 'pill';
      pill.textContent = 'Fora do expediente';
      btn.className = 'punch-btn';
      $('punch-label').textContent = 'Bater entrada';
      btn.disabled = false;
      $('punch-hint').textContent = 'Toque uma vez para registrar. Dá para corrigir o horário no Calendário.';
    }

    $('today-total').textContent = fmt(netMin(shownKey, now));
    $('t-in').textContent = d.in || '—';
    $('t-out').textContent = d.out || '—';
    $('t-lunch').textContent = d.lunch === false ? 'não descontado' : '−1h';

    var st = monthStats(now.getFullYear(), now.getMonth(), now);
    var goalMin = state.settings.goal * 60;
    $('goal-title').textContent = 'Meta de ' + MONTHS[now.getMonth()];
    $('goal-done').textContent = fmtLong(st.total);
    $('goal-of').textContent = 'de ' + state.settings.goal + 'h';
    $('goal-left').textContent = st.total >= goalMin
      ? (st.total > goalMin ? '+' + fmtLong(st.total - goalMin) + ' de extra' : 'meta batida')
      : 'faltam ' + fmtLong(goalMin - st.total);
    setBar($('goal-bar'), st.total / goalMin * 100, st.total >= goalMin ? 'done' : '');
  }

  $('punch-btn').addEventListener('click', function () {
    var now = new Date();
    var ok = openKey(now);
    if (ok) {
      state.days[ok].out = hhmm(now);
      toast('Saída registrada às ' + state.days[ok].out);
    } else {
      var tk = keyOf(now);
      var prev = state.days[tk];
      state.days[tk] = { in: hhmm(now), out: null, lunch: prev && prev.lunch === false ? false : true };
      toast('Entrada registrada às ' + state.days[tk].in);
    }
    if (navigator.vibrate) navigator.vibrate(15);
    save();
    render();
    checkGoalReached(now);
  });

  // ---------- Tela: Calendário ----------
  var calY, calM, selKey;
  function renderCal(now) {
    $('cal-title').textContent = MONTHS[calM] + ' ' + calY;
    var first = new Date(calY, calM, 1).getDay();
    var n = daysInMonth(calY, calM);
    var tk = keyOf(now);
    var html = '';
    for (var b = 0; b < first; b++) html += '<span class="day blank" aria-hidden="true"></span>';
    for (var i = 1; i <= n; i++) {
      var k = calY + '-' + pad(calM + 1) + '-' + pad(i);
      var wd = (first + i - 1) % 7;
      var g = worked(k, now) ? 1 : 0;
      var net = netMin(k, now);
      var hasNote = !!(state.notes[k] && state.notes[k].trim());
      var cls = 'day' + (wd === 0 || wd === 6 ? ' we' : '') + (k === tk ? ' today' : '') + (k === selKey ? ' sel' : '');
      var hTxt = g > 0 ? fmtShort(net) : '';
      var label = i + ' de ' + MONTHS[calM] + (g > 0 ? ', ' + fmtLong(net) + ' trabalhadas' : '') + (hasNote ? ', tem anotação' : '');
      html += '<button type="button" class="' + cls + '" data-k="' + k + '" aria-label="' + label + '">' +
        '<span class="n">' + i + '</span><span class="h">' + hTxt + '</span>' +
        '<span class="dot' + (hasNote ? ' on' : '') + '"></span></button>';
    }
    $('cal-grid').innerHTML = html;

    // Detalhes do dia selecionado
    var sd = parseKey(selKey);
    var d = state.days[selKey] || {};
    $('day-title').textContent = (selKey === tk ? 'Hoje, ' : cap(WEEKDAYS[sd.getDay()]).split('-')[0] + ', ') + sd.getDate() + ' de ' + MONTHS[sd.getMonth()];
    var g2 = grossMin(selKey, now);
    $('day-total').textContent = isOpen(selKey, now) ? d.in + ' → em andamento' : (worked(selKey, now) ? fmtLong(netMin(selKey, now)) + ' no dia' : 'sem ponto');
    if (document.activeElement !== $('d-manual')) $('d-manual').value = d.manual ? Math.floor(d.manual / 60) + ':' + pad(d.manual % 60) : '';
    if (document.activeElement !== $('d-in')) $('d-in').value = d.in || '';
    if (document.activeElement !== $('d-out')) $('d-out').value = d.out || '';
    $('d-lunch').checked = d.lunch !== false;
    if (document.activeElement !== $('d-note')) $('d-note').value = state.notes[selKey] || '';
    $('d-clear').hidden = !d.in && !d.manual;

    // Próximas anotações
    var ups = Object.keys(state.notes).filter(function (k) { return k > tk && state.notes[k] && state.notes[k].trim(); }).sort().slice(0, 5);
    $('up-wrap').hidden = ups.length === 0;
    $('up-list').innerHTML = ups.map(function (k) {
      var dd = parseKey(k);
      return '<button type="button" class="upnote" data-k="' + k + '"><b>' + dd.getDate() + ' ' + MONTHS[dd.getMonth()].slice(0, 3) +
        '</b><span></span></button>';
    }).join('');
    Array.prototype.forEach.call($('up-list').children, function (el, idx) {
      el.querySelector('span').textContent = state.notes[ups[idx]];
    });
    void g2;
  }
  function selectDay(k) {
    selKey = k;
    var d = parseKey(k);
    calY = d.getFullYear(); calM = d.getMonth();
    render();
  }
  $('cal-grid').addEventListener('click', function (e) {
    var b = e.target.closest('.day');
    if (b && b.getAttribute('data-k')) selectDay(b.getAttribute('data-k'));
  });
  $('up-list').addEventListener('click', function (e) {
    var b = e.target.closest('.upnote');
    if (b) { selectDay(b.getAttribute('data-k')); $('day-card').scrollIntoView({ behavior: 'smooth' }); }
  });
  $('cal-prev').addEventListener('click', function () { calM--; if (calM < 0) { calM = 11; calY--; } render(); });
  $('cal-next').addEventListener('click', function () { calM++; if (calM > 11) { calM = 0; calY++; } render(); });

  function onTimeChange() {
    var vin = $('d-in').value, vout = $('d-out').value;
    var prev = state.days[selKey] || {};
    if (!vin) {
      if (vout) { toast('Preencha a entrada primeiro.'); $('d-out').value = ''; }
      if (prev.manual) state.days[selKey] = { manual: prev.manual, lunch: prev.lunch !== false };
      else delete state.days[selKey];
    } else {
      state.days[selKey] = { in: vin, out: vout || null, lunch: prev.lunch !== false };
      if (prev.manual) state.days[selKey].manual = prev.manual;
    }
    save();
    render();
    checkGoalReached(new Date());
  }
  $('d-in').addEventListener('change', onTimeChange);
  $('d-out').addEventListener('change', onTimeChange);
  $('d-manual').addEventListener('change', function () {
    var v = parseHM($('d-manual').value);
    if (isNaN(v)) { toast('Use o formato 17:30'); $('d-manual').value = ''; return; }
    var d = state.days[selKey] || { lunch: true };
    if (v > 0) d.manual = v; else delete d.manual;
    if (!d.in && !d.manual) delete state.days[selKey]; else state.days[selKey] = d;
    save(); render();
    checkGoalReached(new Date());
  });
  $('d-lunch').addEventListener('change', function () {
    var d = state.days[selKey];
    if (!d || !d.in) { toast('Registre a entrada desse dia primeiro.'); $('d-lunch').checked = true; return; }
    d.lunch = $('d-lunch').checked;
    save(); render();
  });
  var noteTimer;
  $('d-note').addEventListener('input', function () {
    var k = selKey, v = $('d-note').value;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(function () {
      if (v.trim()) state.notes[k] = v; else delete state.notes[k];
      save(); render();
    }, 400);
  });
  $('d-clear').addEventListener('click', function () {
    if (!confirm('Apagar os horários e as horas lançadas deste dia? A anotação continua.')) return;
    delete state.days[selKey];
    save(); render();
  });

  // ---------- Tela: Relatórios ----------
  var repY, repM;
  function renderRel(now) {
    var chips = '';
    for (var i = 0; i < 12; i++) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      var on = d.getFullYear() === repY && d.getMonth() === repM;
      var lbl = MONTHS[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '');
      chips += '<button type="button" class="chip' + (on ? ' on' : '') + '" data-y="' + d.getFullYear() + '" data-m="' + d.getMonth() + '"' +
        (on ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' + lbl + '</button>';
    }
    $('chips').innerHTML = chips;

    var st = monthStats(repY, repM, now);
    var goalMin = state.settings.goal * 60;
    $('r-days').textContent = st.days;
    $('r-total').textContent = fmt(st.total);
    $('r-lunch').textContent = fmt(st.lunch);
    if (st.total >= goalMin) {
      $('r-diff-l').textContent = 'Horas extras';
      $('r-diff').textContent = '+' + fmt(st.total - goalMin);
      $('r-diff').style.color = 'var(--ok)';
    } else {
      $('r-diff-l').textContent = 'Falta para ' + state.settings.goal + 'h';
      $('r-diff').textContent = fmt(goalMin - st.total);
      $('r-diff').style.color = 'var(--warn)';
    }
    $('r-xlsx-l').textContent = 'Gerar planilha de ' + MONTHS[repM];
    var lb = state.meta.lastBackup;
    $('b-last').textContent = lb ? 'Último: ' + new Date(lb).toLocaleDateString('pt-BR') : 'Nenhum backup ainda';
    if (document.activeElement !== $('set-goal')) $('set-goal').value = state.settings.goal;
    if (document.activeElement !== $('set-low')) $('set-low').value = state.settings.low;
  }
  $('chips').addEventListener('click', function (e) {
    var b = e.target.closest('.chip');
    if (!b) return;
    repY = +b.getAttribute('data-y'); repM = +b.getAttribute('data-m');
    render();
  });
  function numSetting(id, key, min) {
    $(id).addEventListener('change', function () {
      var v = Math.round(+$(id).value);
      if (!isFinite(v) || v < min) { $(id).value = state.settings[key]; return; }
      state.settings[key] = v;
      save(); render();
      toast('Salvo');
    });
  }
  numSetting('set-goal', 'goal', 1);
  numSetting('set-low', 'low', 0);

  function shareOrDownload(blob, filename, title) {
    var file;
    try { file = new File([blob], filename, { type: blob.type }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: title }).then(function () { return true; }, function (err) {
        if (err && err.name === 'AbortError') return false;
        download(blob, filename); return true;
      });
    }
    download(blob, filename);
    return Promise.resolve(true);
  }
  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  $('r-xlsx').addEventListener('click', function () {
    if (!window.XLSX) { toast('Não consegui carregar o gerador de planilhas.'); return; }
    var now = new Date();
    var n = daysInMonth(repY, repM);
    var rows = [['Data', 'Dia da semana', 'Entrada', 'Saída', 'Almoço', 'Lançado à mão', 'Total', 'Horas (decimal)', 'Anotação']];
    for (var i = 1; i <= n; i++) {
      var k = repY + '-' + pad(repM + 1) + '-' + pad(i);
      var dt = parseKey(k);
      var d = state.days[k] || {};
      var g = grossMin(k, now);
      var w = worked(k, now);
      var net = netMin(k, now);
      rows.push([
        pad(i) + '/' + pad(repM + 1) + '/' + repY,
        cap(WEEKDAYS[dt.getDay()]),
        d.in || '',
        d.out || (d.in && isOpen(k, now) ? 'em andamento' : ''),
        g > 0 ? (d.lunch === false ? '0h 00' : fmt(lunchFor(k, now))) : '',
        d.manual ? fmt(d.manual) : '',
        w ? fmt(net) : '',
        w ? Math.round(net / 60 * 100) / 100 : '',
        state.notes[k] || ''
      ]);
    }
    var st = monthStats(repY, repM, now);
    var goalMin = state.settings.goal * 60;
    rows.push([]);
    rows.push(['Resumo de ' + MONTHS[repM] + ' ' + repY]);
    rows.push(['Dias trabalhados', st.days]);
    rows.push(['Horas no mês', fmt(st.total), '', '', '', '', '', Math.round(st.total / 60 * 100) / 100]);
    rows.push(['Almoço descontado', fmt(st.lunch)]);
    rows.push(['Meta', state.settings.goal + 'h']);
    if (st.total >= goalMin) rows.push(['Horas extras', fmt(st.total - goalMin), '', '', '', '', '', Math.round((st.total - goalMin) / 60 * 100) / 100]);
    else rows.push(['Falta para a meta', fmt(goalMin - st.total), '', '', '', '', '', Math.round((goalMin - st.total) / 60 * 100) / 100]);

    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 12 }, { wch: 15 }, { wch: 9 }, { wch: 13 }, { wch: 9 }, { wch: 13 }, { wch: 9 }, { wch: 15 }, { wch: 45 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, cap(MONTHS[repM]).slice(0, 31));
    var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    var blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    shareOrDownload(blob, 'Ponto-' + repY + '-' + pad(repM + 1) + '.xlsx', 'Planilha de ponto');
  });

  $('b-backup').addEventListener('click', function () {
    var data = JSON.stringify({ app: 'banco-de-horas', exportedAt: new Date().toISOString(), state: state }, null, 2);
    var blob = new Blob([data], { type: 'application/json' });
    var today = keyOf(new Date());
    shareOrDownload(blob, 'backup-ponto-' + today + '.json', 'Backup do ponto').then(function (done) {
      if (!done) return;
      state.meta.lastBackup = new Date().toISOString();
      save(); render();
      toast('Backup gerado');
    });
  });
  $('b-restore').addEventListener('click', function () { $('restore-file').click(); });
  $('restore-file').addEventListener('change', function () {
    var f = $('restore-file').files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var parsed = JSON.parse(r.result);
        var s = parsed && parsed.state ? parsed.state : parsed;
        if (!s || typeof s.days !== 'object') throw new Error('formato');
        var n = Object.keys(s.days).length;
        if (!confirm('Restaurar este backup com ' + n + ' dias de ponto? Os dados atuais serão substituídos.')) return;
        state = normalize(s);
        save(); render();
        toast('Backup restaurado');
      } catch (e) {
        toast('Esse arquivo não é um backup válido.');
      }
      $('restore-file').value = '';
    };
    r.readAsText(f);
  });

  // ---------- Renderização ----------
  function render() {
    var now = new Date();
    if (tab === 'ponto') renderPonto(now);
    else if (tab === 'cal') renderCal(now);
    else renderRel(now);
  }

  // ---------- Início ----------
  function start(loaded) {
    state = normalize(loaded);
    var now = new Date();
    calY = now.getFullYear(); calM = now.getMonth(); selKey = keyOf(now);
    repY = now.getFullYear(); repM = now.getMonth();
    render();
    checkGoalReached(now);
    checkLowOnOpen(now);
  }
  dbGet().then(start, function () { start(null); toast('Não consegui abrir os dados salvos.'); });

  // Atualiza o contador enquanto o app está aberto.
  setInterval(function () { if (tab === 'ponto' || tab === 'cal') render(); }, 30000);
  // Ao voltar para o app: atualiza e verifica os avisos.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    var now = new Date();
    render();
    checkGoalReached(now);
    checkLowOnOpen(now);
  });

  // Pede ao iOS para não apagar os dados e ativa o modo offline.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js'); });
  }
})();

/* Odjezdy MHD - IDS JMK
 * Prime spoje Odkud -> Kam, zive zpozdeni z proudu vozidel KORDIS (gis.brno.cz),
 * jizdni rad z data.json (generuje scripts/build_data.py).
 */
"use strict";

// ============================================================
// 1. NASTAVENI
// ============================================================
var CFG = {
  DATA_URL: "data.json",
  WS_URL: "wss://gis.brno.cz/geoevent/ws/services/Kordis_stream/StreamServer/subscribe",
  HORIZON_MIN: 180,        // jak daleko dopredu hledat odjezdy
  MAX_ROWS: 12,            // kolik odjezdu zobrazit
  KEEP_UNMATCHED_MIN: 2,   // jak dlouho po case odjezdu drzet spoj bez zivych dat
  VEHICLE_TTL_MS: 120000,  // po jake dobe bez zpravy vuz zahodit
  RENDER_MS: 5000,
  STORE_KEY: "odjezdy.v1"
};

// ============================================================
// 2. JADRO (bez DOM - da se testovat v Node)
// ============================================================
var Core = (function () {
  var D = null;            // nactena data
  var byNode = [];         // index zastavky -> [[vzor, pozice], ...]
  var norm = [];           // normalizovana jmena pro hledani
  var weight = [];         // pocet vzoru na zastavce (razeni vysledku)

  // ---- 2.1 Pomocne ----
  function normalize(s) {
    return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, " ").trim();
  }

  // Cas v Praze: {ymd:"2026-11-11", min: minuty od pulnoci (desetinne)}
  function pragueNow(dateObj) {
    var f = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    });
    var p = {};
    f.formatToParts(dateObj).forEach(function (x) { p[x.type] = x.value; });
    return {
      ymd: p.year + "-" + p.month + "-" + p.day,
      min: (+p.hour) * 60 + (+p.minute) + (+p.second) / 60
    };
  }

  function dayDiff(ymdA, ymdB) {   // A - B ve dnech
    var a = Date.UTC(+ymdA.slice(0, 4), +ymdA.slice(5, 7) - 1, +ymdA.slice(8, 10));
    var b = Date.UTC(+ymdB.slice(0, 4), +ymdB.slice(5, 7) - 1, +ymdB.slice(8, 10));
    return Math.round((a - b) / 86400000);
  }

  // ---- 2.2 Nacteni dat ----
  function load(data) {
    D = data;
    byNode = D.stops.map(function () { return []; });
    D.pat.forEach(function (p, pi) {
      p[2].forEach(function (n, pos) { byNode[n].push([pi, pos]); });
    });
    norm = D.stops.map(function (s) { return normalize(s[1]); });
    weight = byNode.map(function (l) { return l.length; });
  }

  // ---- 2.3 Zastavky dosazitelne primym spojem z dane zastavky ----
  function reachable(fromIdx) {
    var set = {};
    byNode[fromIdx].forEach(function (e) {
      var p = D.pat[e[0]], fl = p[6];
      if (fl && (fl[e[1]] & 1)) return;
      for (var j = e[1] + 1; j < p[2].length; j++) {
        if (fl && (fl[j] & 2)) continue;
        if (p[2][j] !== fromIdx) set[p[2][j]] = 1;
      }
    });
    return set;
  }

  // ---- 2.4 Hledani zastavky podle jmena ----
  function search(q, limit, onlySet) {
    var nq = normalize(q);
    if (!nq) return [];
    var toks = nq.split(" ");
    var res = [];
    for (var i = 0; i < norm.length; i++) {
      if (onlySet && !onlySet[i]) continue;
      var name = norm[i], ok = true, score = 0;
      for (var t = 0; t < toks.length; t++) {
        // kazde slovo dotazu musi byt zacatkem nektereho slova v nazvu
        if (name.indexOf(toks[t]) === 0) score += 4;
        else if (name.indexOf(" " + toks[t]) >= 0) score += 2;
        else { ok = false; break; }
      }
      if (name.indexOf(nq) === 0) score += 3;
      if (!ok) continue;
      if (name === nq) score += 10;
      var z = D.stops[i][2];
      if (z === "100" || z === "101") score += 3;      // Brno prednostne
      score += Math.min(weight[i], 400) / 200;
      res.push([score, i]);
    }
    res.sort(function (a, b) { return b[0] - a[0] || norm[a[1]].localeCompare(norm[b[1]]); });
    return res.slice(0, limit || 8).map(function (r) { return r[1]; });
  }

  // ---- 2.5 Kandidati odjezdu podle jizdniho radu ----
  // vraci spoje s casem v minutach od dnesni pulnoci (Praha)
  function candidates(fromIdx, toIdx, now) {
    var out = [], seen = {};
    var todayIdx = dayDiff(now.ymd, D.base);
    byNode[toIdx].forEach(function (e) {
      var pi = e[0], j = e[1], p = D.pat[pi], nodes = p[2], fl = p[6];
      if (fl && (fl[j] & 2)) return;
      // nejblizsi predchozi vyskyt vychozi zastavky
      var i = -1;
      for (var k = j - 1; k >= 0; k--) {
        if (nodes[k] === fromIdx && !(fl && (fl[k] & 1))) { i = k; break; }
      }
      if (i < 0) return;
      var dep = p[4], arr = p[5] || p[4], tr = p[7];
      for (var off = -1; off <= 1; off++) {
        var di = todayIdx + off;
        if (di < 0) continue;
        for (var t = 0; t < tr.length; t += 2) {
          var mask = D.svc[tr[t + 1]];
          if (mask.charAt(di) !== "1") continue;
          var t0 = off * 1440 + tr[t];
          var sched = t0 + dep[i];
          if (sched < now.min - 45 || sched > now.min + CFG.HORIZON_MIN) continue;
          var key = pi + ":" + t0 + ":" + i;
          if (seen[key]) continue;
          seen[key] = 1;
          out.push({
            pat: pi, t0: t0, i: i, j: j,
            sched: sched, schedArr: t0 + arr[j],
            route: p[0], headsign: p[1], post: p[3][i],
            request: !!(fl && (fl[i] & 4))
          });
        }
      }
    });
    out.sort(function (a, b) { return a.sched - b.sched; });
    return out;
  }

  // ---- 2.6 Prirazeni vozidel ke spojum ----
  // vehicles: pole {id, line, fin, last, delay}
  function matchVehicles(cands, vehicles, nowMin) {
    var byLine = {};
    vehicles.forEach(function (v) {
      (byLine[v.line] = byLine[v.line] || []).push(v);
    });
    var pairs = [];
    cands.forEach(function (c, ci) {
      var p = D.pat[c.pat], nodes = p[2], dep = p[4], arr = p[5] || p[4];
      var lineId = D.routes[p[0]][4];
      var finNode = D.stops[nodes[nodes.length - 1]][0];
      var list = byLine[lineId];
      if (!list) return;
      list.forEach(function (v) {
        if (v.fin !== finNode) return;
        var pos = nowMin - v.delay;          // kde by vuz mel byt podle radu
        for (var k = 0; k < nodes.length; k++) {
          if (D.stops[nodes[k]][0] !== v.last) continue;
          var lo = c.t0 + dep[k] - 1.5;
          var hi = c.t0 + (k + 1 < nodes.length ? arr[k + 1] : dep[k]) + 1.5;
          var score;
          if (pos >= lo && pos <= hi) {
            score = Math.abs(pos - (lo + hi) / 2);
          } else if (k === 0 && pos < lo && pos >= c.t0 - 20) {
            score = 5 + (lo - pos);          // vuz ceka na konecne pred odjezdem
          } else {
            continue;
          }
          pairs.push([score, ci, v, k]);
        }
      });
    });
    pairs.sort(function (a, b) { return a[0] - b[0]; });
    var usedC = {}, usedV = {};
    pairs.forEach(function (pr) {
      if (usedC[pr[1]] || usedV[pr[2].id]) return;
      usedC[pr[1]] = 1; usedV[pr[2].id] = 1;
      cands[pr[1]].veh = pr[2];
      cands[pr[1]].vehPos = pr[3];
    });
  }

  // ---- 2.7 Vysledny seznam odjezdu ----
  function departures(fromIdx, toIdx, dateObj, vehicles, walkMin) {
    var now = pragueNow(dateObj);
    var cands = candidates(fromIdx, toIdx, now);
    if (vehicles && vehicles.length) matchVehicles(cands, vehicles, now.min);
    var rows = [];
    cands.forEach(function (c) {
      var live = !!c.veh, delay = live ? c.veh.delay : 0;
      if (live && c.vehPos > c.i) return;                      // vuz uz zastavku projel
      if (!live && c.sched < now.min - CFG.KEEP_UNMATCHED_MIN) return;
      var dep = c.sched + delay;
      var atStop = live && c.vehPos === c.i;
      if (atStop && dep < now.min) dep = now.min;
      if (live && !atStop && dep < now.min - 1) dep = now.min; // zpozdeni mezitim naroslo
      var r = D.routes[c.route];
      var platMap = D.plat[fromIdx];
      rows.push({
        line: r[0], type: r[1], color: r[2], textColor: r[3],
        headsign: c.headsign,
        platform: platMap && platMap[c.post] ? platMap[c.post] : "",
        sched: c.sched, dep: dep, arr: c.schedArr + delay,
        delay: delay, live: live, atStop: atStop, request: c.request,
        inMin: dep - now.min,
        leaveIn: dep - now.min - (walkMin || 0)
      });
    });
    rows.sort(function (a, b) { return a.dep - b.dep; });
    return { now: now, rows: rows };
  }

  function fmtTime(min) {
    var m = Math.round(min);
    m = ((m % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60), mm = m % 60;
    return h + ":" + (mm < 10 ? "0" : "") + mm;
  }

  return {
    load: load, search: search, reachable: reachable, departures: departures,
    fmtTime: fmtTime, pragueNow: pragueNow, normalize: normalize,
    data: function () { return D; },
    stop: function (i) { return D.stops[i]; },
    findById: function (nodeId) {
      for (var i = 0; i < D.stops.length; i++) if (D.stops[i][0] === nodeId) return i;
      return -1;
    }
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = { Core: Core, CFG: CFG };
}

// ============================================================
// 3. ZIVA DATA (WebSocket proud vozidel)
// ============================================================
var Live = (function () {
  var ws = null, vehicles = {}, status = "off", retryTimer = null, wanted = false, lastMsg = 0;

  function connect() {
    if (!wanted || ws) return;
    status = "connecting";
    try { ws = new WebSocket(CFG.WS_URL); } catch (e) { ws = null; schedule(); return; }
    ws.onopen = function () { status = "on"; };
    ws.onmessage = function (ev) {
      try {
        var a = JSON.parse(ev.data).attributes;
        if (!a || a.ID == null) return;
        if (String(a.IsInactive) === "true") { delete vehicles[a.ID]; return; }
        vehicles[a.ID] = {
          id: a.ID, line: a.LineID, fin: a.FinalStopID, last: a.LastStopID,
          delay: +a.Delay || 0, t: Date.now()
        };
        lastMsg = Date.now();
      } catch (e) { /* vadna zprava - preskocit */ }
    };
    ws.onclose = function () { ws = null; status = "off"; schedule(); };
    ws.onerror = function () { try { ws.close(); } catch (e) { } };
  }
  function schedule() {
    if (!wanted || retryTimer) return;
    retryTimer = setTimeout(function () { retryTimer = null; connect(); }, 5000);
  }
  function start() { wanted = true; connect(); }
  function stop() {
    wanted = false;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (ws) { try { ws.close(); } catch (e) { } ws = null; }
    status = "off";
  }
  function list() {
    var now = Date.now(), out = [];
    for (var id in vehicles) {
      if (now - vehicles[id].t > CFG.VEHICLE_TTL_MS) delete vehicles[id];
      else out.push(vehicles[id]);
    }
    return out;
  }
  function state() {
    var fresh = lastMsg && (Date.now() - lastMsg < 30000);
    return { status: status, ok: status === "on" && fresh, count: Object.keys(vehicles).length };
  }
  return { start: start, stop: stop, list: list, state: state };
})();

// ============================================================
// 4. UZIVATELSKE ROZHRANI
// ============================================================
(function () {
  if (typeof document === "undefined") return;

  var S = { from: null, to: null, walk: 5, favs: [] };   // from/to = id uzlu
  var fromIdx = -1, toIdx = -1, reach = null;
  var $ = function (id) { return document.getElementById(id); };

  // ---- 4.1 Ulozeni stavu ----
  function save() {
    try { localStorage.setItem(CFG.STORE_KEY, JSON.stringify(S)); } catch (e) { }
  }
  function restore() {
    try {
      var o = JSON.parse(localStorage.getItem(CFG.STORE_KEY) || "null");
      if (o && typeof o === "object") {
        S.from = o.from != null ? o.from : null;
        S.to = o.to != null ? o.to : null;
        S.walk = typeof o.walk === "number" ? o.walk : 5;
        S.favs = Array.isArray(o.favs) ? o.favs : [];
      }
    } catch (e) { }
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function stopLabel(idx) {
    var s = Core.stop(idx);
    return s[1];
  }

  // ---- 4.2 Vyber zastavky (naseptavac) ----
  function setupPicker(inputId, listId, which) {
    var inp = $(inputId), box = $(listId);
    function close() { box.hidden = true; box.innerHTML = ""; }
    function show() {
      var only = (which === "to" && fromIdx >= 0) ? reach : null;
      var res = Core.search(inp.value, 8, only);
      if (!inp.value.trim()) { close(); return; }
      if (!res.length) {
        box.innerHTML = '<div class="sug none">' +
          (only ? "Žádná zastávka s přímým spojem" : "Zastávka nenalezena") + "</div>";
        box.hidden = false;
        return;
      }
      box.innerHTML = res.map(function (i) {
        var s = Core.stop(i);
        return '<button type="button" class="sug" data-i="' + i + '">' + esc(s[1]) +
          '<span class="zone">zóna ' + esc(s[2]) + "</span></button>";
      }).join("");
      box.hidden = false;
    }
    inp.addEventListener("input", show);
    inp.addEventListener("focus", function () { inp.select(); show(); });
    inp.addEventListener("blur", function () {
      setTimeout(function () { close(); syncInputs(); }, 200);
    });
    box.addEventListener("pointerdown", function (ev) {
      var b = ev.target.closest(".sug[data-i]");
      if (!b) return;
      ev.preventDefault();
      choose(which, +b.getAttribute("data-i"));
      close();
      inp.blur();
    });
  }

  function choose(which, idx) {
    if (which === "from") {
      fromIdx = idx; S.from = Core.stop(idx)[0];
      reach = Core.reachable(idx);
      if (toIdx >= 0 && !reach[toIdx]) { toIdx = -1; S.to = null; }
    } else {
      toIdx = idx; S.to = Core.stop(idx)[0];
    }
    save(); syncInputs(); render();
    if (which === "from" && toIdx < 0) $("inTo").focus();
  }

  function syncInputs() {
    if (document.activeElement !== $("inFrom")) $("inFrom").value = fromIdx >= 0 ? stopLabel(fromIdx) : "";
    if (document.activeElement !== $("inTo")) $("inTo").value = toIdx >= 0 ? stopLabel(toIdx) : "";
    $("walkVal").textContent = S.walk;
  }

  function setPair(fromId, toId, walk) {
    fromIdx = fromId != null ? Core.findById(fromId) : -1;
    toIdx = toId != null ? Core.findById(toId) : -1;
    S.from = fromIdx >= 0 ? fromId : null;
    S.to = toIdx >= 0 ? toId : null;
    if (typeof walk === "number") S.walk = walk;
    reach = fromIdx >= 0 ? Core.reachable(fromIdx) : null;
    save(); syncInputs(); render();
  }

  // ---- 4.3 Oblibene dvojice ----
  function favIndex() {
    for (var i = 0; i < S.favs.length; i++) {
      if (S.favs[i].from === S.from && S.favs[i].to === S.to) return i;
    }
    return -1;
  }
  function renderFavs() {
    var el = $("favs");
    var html = S.favs.map(function (f, i) {
      var a = Core.findById(f.from), b = Core.findById(f.to);
      if (a < 0 || b < 0) return "";
      var act = (f.from === S.from && f.to === S.to) ? " active" : "";
      return '<button type="button" class="chip' + act + '" data-f="' + i + '">' +
        esc(stopLabel(a)) + " → " + esc(stopLabel(b)) + "</button>";
    }).join("");
    el.innerHTML = html;
    el.hidden = !html;
    var star = $("btnFav");
    var has = favIndex() >= 0;
    star.disabled = !(fromIdx >= 0 && toIdx >= 0);
    star.textContent = has ? "★ Uloženo" : "☆ Uložit trasu";
    star.setAttribute("aria-pressed", has ? "true" : "false");
  }

  // ---- 4.4 Vykresleni odjezdu ----
  function minutesText(m) {
    if (m < 0.5) return "teď";
    var r = Math.floor(m + 0.25);
    if (r < 1) r = 1;
    if (r >= 60) return Math.floor(r / 60) + " h " + (r % 60) + " min";
    return r + " min";
  }

  function render() {
    renderFavs();
    var list = $("list"), info = $("info");
    if (fromIdx < 0 || toIdx < 0) {
      list.innerHTML = "";
      info.textContent = fromIdx < 0 ? "Zadejte zastávku, odkud jedete." : "Zadejte cílovou zastávku.";
      info.hidden = false;
      renderStatus();
      return;
    }
    var res = Core.departures(fromIdx, toIdx, new Date(), Live.list(), S.walk);
    var rows = res.rows.slice(0, CFG.MAX_ROWS);
    if (!rows.length) {
      list.innerHTML = "";
      info.textContent = "V příštích " + (CFG.HORIZON_MIN / 60) + " hodinách odtud do cíle nejede žádný přímý spoj.";
      info.hidden = false;
      renderStatus();
      return;
    }
    info.hidden = true;
    var firstOk = true;
    list.innerHTML = rows.map(function (r) {
      var miss = r.leaveIn < -0.5;
      var cls = "row" + (miss ? " miss" : "");
      var bg = r.color ? "#" + r.color : "#555";
      var fg = r.textColor ? "#" + r.textColor : (isLight(r.color) ? "#000" : "#fff");
      var leave;
      if (miss) leave = "nestihnete";
      else if (r.leaveIn < 1) leave = "vyrazit hned";
      else leave = "vyrazit za " + minutesText(r.leaveIn);
      var hot = !miss && firstOk;
      if (hot) firstOk = false;
      var d = Math.round(r.delay);
      var timeTxt = Core.fmtTime(r.sched) +
        (r.live ? (d > 0 ? ' <span class="late">+' + d + "</span>" : (d < 0 ? ' <span class="early">' + d + "</span>" : ' <span class="ontime">včas</span>')) : "");
      var meta = [];
      if (r.platform) meta.push("nást. " + esc(r.platform));
      meta.push("v cíli " + Core.fmtTime(r.arr));
      if (r.request) meta.push("na znamení");
      return '<li class="' + cls + (hot ? " hot" : "") + '">' +
        '<span class="badge" style="background:' + bg + ";color:" + fg + '">' + esc(r.line) + "</span>" +
        '<span class="mid"><span class="head">' + esc(r.headsign) + "</span>" +
        '<span class="meta">' + meta.join(" · ") + "</span></span>" +
        '<span class="right"><span class="in">' + (r.atStop ? "v zastávce" : minutesText(r.inMin)) + "</span>" +
        '<span class="time"><span class="dot ' + (r.live ? "live" : "plan") + '" title="' +
        (r.live ? "živá data" : "podle jízdního řádu") + '"></span>' + timeTxt + "</span>" +
        '<span class="leave">' + leave + "</span></span></li>";
    }).join("");
    renderStatus();
  }

  function isLight(hex) {
    if (!hex || hex.length !== 6) return false;
    var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 150;
  }

  function renderStatus() {
    var st = Live.state(), D = Core.data();
    var live = st.ok ? "živá data připojena (" + st.count + " vozů)"
      : (st.status === "connecting" ? "připojuji živá data…" : "živá data nedostupná – časy podle jízdního řádu");
    var gen = D ? D.gen.slice(8, 10) + "." + D.gen.slice(5, 7) + "." : "?";
    $("status").innerHTML = '<span class="dot ' + (st.ok ? "live" : "plan") + '"></span>' + live +
      " · jízdní řád z " + gen;
    var age = D ? (Date.now() - Date.parse(D.gen)) / 86400000 : 0;
    $("stale").hidden = !(age > 10);
  }

  // ---- 4.5 Start ----
  function init() {
    restore();
    setupPicker("inFrom", "sugFrom", "from");
    setupPicker("inTo", "sugTo", "to");

    $("btnSwap").addEventListener("click", function () {
      if (fromIdx < 0 && toIdx < 0) return;
      setPair(S.to, S.from);
    });
    $("walkMinus").addEventListener("click", function () { S.walk = Math.max(0, S.walk - 1); save(); syncInputs(); render(); });
    $("walkPlus").addEventListener("click", function () { S.walk = Math.min(60, S.walk + 1); save(); syncInputs(); render(); });
    $("btnFav").addEventListener("click", function () {
      if (fromIdx < 0 || toIdx < 0) return;
      var i = favIndex();
      if (i >= 0) S.favs.splice(i, 1);
      else S.favs.push({ from: S.from, to: S.to, walk: S.walk });
      save(); render();
    });
    $("favs").addEventListener("click", function (ev) {
      var b = ev.target.closest(".chip");
      if (!b) return;
      var f = S.favs[+b.getAttribute("data-f")];
      if (f) setPair(f.from, f.to, f.walk);
    });

    $("info").textContent = "Načítám jízdní řád…";
    fetch(CFG.DATA_URL, { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) {
        Core.load(data);
        setPair(S.from, S.to);
        Live.start();
        setInterval(function () { if (!document.hidden) render(); }, CFG.RENDER_MS);
        document.addEventListener("visibilitychange", function () {
          if (document.hidden) Live.stop();
          else { Live.start(); render(); }
        });
      })
      .catch(function (e) {
        $("info").hidden = false;
        $("info").textContent = "Jízdní řád se nepodařilo načíst (" + e.message + "). Zkuste stránku obnovit.";
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

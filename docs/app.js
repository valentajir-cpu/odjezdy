/* Odjezdy MHD - IDS JMK
 * Odjezdy ze zastavky, z okoli ulice nebo z aktualni polohy; volitelne jen prime
 * spoje do jednoho ci vice cilu. Zive zpozdeni z proudu vozidel KORDIS (gis.brno.cz),
 * jizdni rad z data.json (generuje scripts/build_data.py).
 */
"use strict";

// ============================================================
// 1. NASTAVENI
// ============================================================
var CFG = {
  DATA_URL: "data.json",
  WS_URL: "wss://gis.brno.cz/geoevent/ws/services/Kordis_stream/StreamServer/subscribe",
  HORIZON_MIN: 180,        // jak daleko dopredu hledat odjezdy do cile
  HORIZON_NODEST_MIN: 90,  // bez cile staci kratsi vyhled
  MAX_ROWS: 14,            // kolik odjezdu zobrazit
  KEEP_UNMATCHED_MIN: 2,   // jak dlouho po case odjezdu drzet spoj bez zivych dat
  VEHICLE_TTL_MS: 120000,  // po jake dobe bez zpravy vuz zahodit
  RENDER_MS: 5000,
  GEOCODE_URL: "https://nominatim.openstreetmap.org/search",
  GEOCODE_BOX: "15.5,49.65,17.7,48.6",   // Jihomoravsky kraj (zap., sev., vych., jih)
  NEAR_RADIUS_M: 500,      // vychozi okruh hledani zastavek
  NEAR_FALLBACK_M: 1500,   // kdyz v okruhu nic neni, vezmou se nejblizsi do teto vzdalenosti
  NEAR_MAX_STOPS: 8,
  WALK_M_PER_MIN: 75,      // vychozi rychlost chuze
  WALK_DETOUR: 1.3,        // prirazka na to, ze se nejde vzdusnou carou
  CENTER: [49.1951, 16.6078],   // stred Brna pro rozliseni "do centra / z centra"
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

  function ymdToUtc(ymd) {
    return Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
  }
  function dayDiff(ymdA, ymdB) {   // A - B ve dnech
    return Math.round((ymdToUtc(ymdA) - ymdToUtc(ymdB)) / 86400000);
  }
  function addDays(ymd, n) {
    return new Date(ymdToUtc(ymd) + n * 86400000).toISOString().slice(0, 10);
  }

  // Planovany cas "HH:MM": dnes, nebo zitra, kdyz uz dnes ubehl
  function plannedNow(dateObj, hhmm) {
    var now = pragueNow(dateObj);
    var m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
    if (!m) return now;
    var min = (+m[1]) * 60 + (+m[2]);
    if (min < now.min - 1) return { ymd: addDays(now.ymd, 1), min: min, planned: true, tomorrow: true };
    return { ymd: now.ymd, min: min, planned: true, tomorrow: false };
  }

  function distM(lat1, lon1, lat2, lon2) {
    var kx = 111320 * Math.cos(lat1 * Math.PI / 180), ky = 110540;
    var dx = (lon2 - lon1) * kx, dy = (lat2 - lat1) * ky;
    return Math.sqrt(dx * dx + dy * dy);
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

  // ---- 2.3 Zastavky dosazitelne primym spojem ----
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
  function reachableMulti(idxs) {
    var set = {};
    idxs.forEach(function (i) {
      var r = reachable(i);
      for (var k in r) set[k] = 1;
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
      if (!ok) continue;
      if (name.indexOf(nq) === 0) score += 3;
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
  // toIdx < 0 = bez cile (vsechny odjezdy ze zastavky)
  // vraci spoje s casem v minutach od pulnoci dne now.ymd
  function candidates(fromIdx, toIdx, now) {
    var out = [], seen = {};
    var todayIdx = dayDiff(now.ymd, D.base);
    var horizon = toIdx >= 0 ? CFG.HORIZON_MIN : CFG.HORIZON_NODEST_MIN;
    var pairs = [];           // [vzor, pozice nastupu, pozice vystupu]
    if (toIdx >= 0) {
      byNode[toIdx].forEach(function (e) {
        var p = D.pat[e[0]], nodes = p[2], fl = p[6], j = e[1];
        if (fl && (fl[j] & 2)) return;
        for (var k = j - 1; k >= 0; k--) {
          if (nodes[k] === fromIdx && !(fl && (fl[k] & 1))) { pairs.push([e[0], k, j]); break; }
        }
      });
    } else {
      byNode[fromIdx].forEach(function (e) {
        var p = D.pat[e[0]], fl = p[6], last = p[2].length - 1;
        if (e[1] >= last || (fl && (fl[e[1]] & 1))) return;
        pairs.push([e[0], e[1], last]);
      });
    }
    pairs.forEach(function (pr) {
      var pi = pr[0], i = pr[1], j = pr[2], p = D.pat[pi], fl = p[6];
      var dep = p[4], arr = p[5] || p[4], tr = p[7];
      for (var off = -1; off <= 1; off++) {
        var di = todayIdx + off;
        if (di < 0) continue;
        for (var t = 0; t < tr.length; t += 2) {
          var mask = D.svc[tr[t + 1]];
          if (mask.charAt(di) !== "1") continue;
          var t0 = off * 1440 + tr[t];
          var sched = t0 + dep[i];
          if (sched < now.min - 45 || sched > now.min + horizon) continue;
          var key = pi + ":" + t0 + ":" + i;
          if (seen[key]) continue;
          seen[key] = 1;
          out.push({
            pat: pi, t0: t0, i: i, j: j, trip: pi + ":" + t0,
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
  // vehicles: pole {id, line, fin, last, delay, lf}
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
          // tolerance: zpozdeni je v celych minutach a vuz s predstihem hlasi 0
          var lo = c.t0 + dep[k] - 2.5;
          var hi = c.t0 + (k + 1 < nodes.length ? arr[k + 1] : dep[k]) + 3.5;
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

  // ---- 2.7 Smer vuci centru Brna: "in" = k centru, "out" = od centra, "" = nelze urcit ----
  function directionOf(patIdx, i) {
    var p = D.pat[patIdx], nodes = p[2], c = CFG.CENTER;
    var s0 = D.stops[nodes[i]];
    var d0 = distM(c[0], c[1], s0[3], s0[4]);
    if (d0 < 1000 || d0 > 15000) return "";
    var best = d0;
    for (var k = i + 1; k < nodes.length; k++) {
      var s = D.stops[nodes[k]];
      var d = distM(c[0], c[1], s[3], s[4]);
      if (d < best) best = d;
    }
    return best < d0 * 0.6 ? "in" : "out";
  }

  // ---- 2.8 Vysledny seznam odjezdu ----
  // origins: pole {idx, walk} (jedna zastavka, nebo vice zastavek v okoli)
  // toIdxs:  pole cilovych zastavek (prazdne = vsechny smery)
  // now:     vysledek pragueNow() nebo plannedNow()
  function departures(origins, toIdxs, now, vehicles) {
    var dests = toIdxs && toIdxs.length ? toIdxs : [-1];
    var useLive = !now.planned && vehicles && vehicles.length;
    var best = {};            // spoj -> nejlepsi radek
    origins.forEach(function (o) {
      var platMap = D.plat[o.idx];
      dests.forEach(function (toIdx) {
        if (o.idx === toIdx) return;
        var cands = candidates(o.idx, toIdx, now);
        if (useLive) matchVehicles(cands, vehicles, now.min);
        cands.forEach(function (c) {
          var live = !!c.veh, delay = live ? c.veh.delay : 0;
          if (live && c.vehPos > c.i) return;                      // vuz uz zastavku projel
          if (!live && c.sched < now.min - (now.planned ? 0 : CFG.KEEP_UNMATCHED_MIN)) return;
          var dep = c.sched + delay;
          var atStop = live && c.vehPos === c.i;
          if (atStop && dep < now.min) dep = now.min;
          if (live && !atStop && dep < now.min - 1) dep = now.min; // zpozdeni mezitim naroslo
          var r = D.routes[c.route];
          var row = {
            key: c.trip + ":" + o.idx,
            line: r[0], type: r[1], color: r[2], textColor: r[3],
            headsign: c.headsign,
            platform: platMap && platMap[c.post] ? platMap[c.post] : "",
            stopIdx: o.idx, stopName: D.stops[o.idx][1], walk: o.walk || 0,
            destIdx: toIdx, destName: toIdx >= 0 ? D.stops[toIdx][1] : "",
            pat: c.pat, t0: c.t0, i: c.i, j: c.j,
            vehPos: live ? c.vehPos : -1, lowFloor: live && !!c.veh.lf,
            sched: c.sched, dep: dep, arr: toIdx >= 0 ? c.schedArr + delay : null,
            delay: delay, live: live, atStop: atStop, request: c.request,
            inMin: dep - now.min,
            leaveIn: dep - now.min - (o.walk || 0)
          };
          var old = best[c.trip];
          if (!old) { best[c.trip] = row; return; }
          // prednost: zastavka, kterou stihnu > blizsi zastavka > cil, kam spoj dojede driv
          var okNew = row.leaveIn >= -0.5, okOld = old.leaveIn >= -0.5;
          if (okNew !== okOld) { if (okNew) best[c.trip] = row; return; }
          if (row.walk !== old.walk) { if (row.walk < old.walk) best[c.trip] = row; return; }
          if (row.arr != null && old.arr != null && row.arr < old.arr) best[c.trip] = row;
        });
      });
    });
    var rows = Object.keys(best).map(function (k) { return best[k]; });
    rows.forEach(function (r) { r.dir = directionOf(r.pat, r.i); });
    rows.sort(function (a, b) { return a.dep - b.dep || a.walk - b.walk; });
    return { now: now, rows: rows };
  }

  // ---- 2.9 Zastavky v okoli souradnic ----
  function nearby(lat, lon, radiusM, speed) {
    var radius = radiusM || CFG.NEAR_RADIUS_M, spd = speed || CFG.WALK_M_PER_MIN;
    var limit = Math.max(radius, CFG.NEAR_FALLBACK_M), all = [];
    for (var i = 0; i < D.stops.length; i++) {
      var d = distM(lat, lon, D.stops[i][3], D.stops[i][4]);
      if (d <= limit) all.push([d, i]);
    }
    all.sort(function (a, b) { return a[0] - b[0]; });
    var near = all.filter(function (x) { return x[0] <= radius; });
    if (!near.length) near = all.slice(0, 3);
    return near.slice(0, CFG.NEAR_MAX_STOPS).map(function (x) {
      return {
        idx: x[1], dist: Math.round(x[0]),
        walk: Math.max(1, Math.ceil(x[0] * CFG.WALK_DETOUR / spd))
      };
    });
  }

  // ---- 2.10 Detail spoje: zastavky od nastupu do cile (nebo na konecnou) ----
  function tripStops(row) {
    var p = D.pat[row.pat], nodes = p[2], dep = p[4], arr = p[5] || p[4];
    var end = row.destIdx >= 0 ? row.j : nodes.length - 1;
    var list = [];
    for (var k = row.i; k <= end; k++) {
      list.push({
        name: D.stops[nodes[k]][1],
        time: row.t0 + (k === row.i ? dep[k] : arr[k]) + row.delay,
        board: k === row.i, dest: row.destIdx >= 0 && k === row.j
      });
    }
    var veh = null;
    if (row.live && row.vehPos >= 0) {
      veh = { name: D.stops[nodes[row.vehPos]][1], before: row.i - row.vehPos };
    }
    return { stops: list, vehicle: veh };
  }

  function fmtTime(min) {
    var m = Math.round(min);
    m = ((m % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60), mm = m % 60;
    return h + ":" + (mm < 10 ? "0" : "") + mm;
  }

  return {
    load: load, search: search, reachable: reachable, reachableMulti: reachableMulti,
    nearby: nearby, departures: departures, tripStops: tripStops,
    fmtTime: fmtTime, pragueNow: pragueNow, plannedNow: plannedNow, normalize: normalize,
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
          delay: +a.Delay || 0, lf: String(a.LF) === "true", t: Date.now()
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

  // ---- 4.1 Stav ----
  // S.from: cislo uzlu zastavky | {n: nazev, la, lo, gps?: true} | null
  // S.to:   pole cisel uzlu cilovych zastavek (prazdne = vsechny smery)
  // S.favs: [{name, from, to, walk, use: {"d7": 3, ...}}]
  // S.hide: {klic vychoziho mista: [skryte linky]}
  var S = { from: null, to: [], walk: 5, favs: [], hide: {}, speed: 75, radius: 500, smart: true };
  var origin = null;        // {type:"stop", idx} | {type:"place", name, lat, lon, stops:[...]}
  var toIdxs = [], reach = null;
  var geoResults = [];
  var planAt = "";          // "HH:MM" = odjezd pozdeji, "" = ted
  var dirFilter = "all";    // all | in | out
  var openKey = "";         // rozbaleny detail spoje
  var hint = "";
  var $ = function (id) { return document.getElementById(id); };

  function save() {
    try { localStorage.setItem(CFG.STORE_KEY, JSON.stringify(S)); } catch (e) { }
  }
  function normTo(v) {
    if (Array.isArray(v)) return v.filter(function (x) { return typeof x === "number"; });
    return typeof v === "number" ? [v] : [];
  }
  function restore() {
    try {
      var o = JSON.parse(localStorage.getItem(CFG.STORE_KEY) || "null");
      if (!o || typeof o !== "object") return;
      S.from = o.from != null ? o.from : null;
      S.to = normTo(o.to);
      S.walk = typeof o.walk === "number" ? o.walk : 5;
      S.hide = o.hide && typeof o.hide === "object" ? o.hide : {};
      S.speed = typeof o.speed === "number" ? o.speed : 75;
      S.radius = typeof o.radius === "number" ? o.radius : 500;
      S.smart = o.smart !== false;
      S.favs = (Array.isArray(o.favs) ? o.favs : []).map(function (f) {
        return {
          name: typeof f.name === "string" ? f.name : "", from: f.from, to: normTo(f.to),
          walk: typeof f.walk === "number" ? f.walk : 5,
          use: f.use && typeof f.use === "object" ? f.use : {}
        };
      }).filter(function (f) { return f.from != null; });
    } catch (e) { }
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function isPlace(v) { return v && typeof v === "object"; }
  function stopName(id) {
    var i = Core.findById(id);
    return i >= 0 ? Core.stop(i)[1] : "";
  }
  function fromLabel(v) {
    if (v == null) return "";
    return isPlace(v) ? v.n : stopName(v);
  }
  function routeKey(from, to) { return JSON.stringify([isPlace(from) && from.gps ? "gps" : from, to]); }
  function originKey() { return JSON.stringify(isPlace(S.from) && S.from.gps ? "gps" : S.from); }

  // ---- 4.2 Nastaveni trasy ----
  function applyState() {
    origin = null; toIdxs = []; reach = null;
    if (isPlace(S.from)) {
      var st = Core.nearby(S.from.la, S.from.lo, S.radius, S.speed);
      origin = { type: "place", name: S.from.n, lat: S.from.la, lon: S.from.lo, stops: st };
      reach = Core.reachableMulti(st.map(function (x) { return x.idx; }));
    } else if (S.from != null) {
      var fi = Core.findById(S.from);
      if (fi >= 0) { origin = { type: "stop", idx: fi }; reach = Core.reachable(fi); }
      else S.from = null;
    }
    S.to = S.to.filter(function (id) {
      var i = Core.findById(id);
      if (i < 0 || (reach && !reach[i])) return false;
      toIdxs.push(i);
      return true;
    });
    if (toIdxs.length) dirFilter = "all";
    save(); syncInputs(); render();
  }
  function setRoute(from, to, walk) {
    S.from = from; S.to = normTo(to);
    if (typeof walk === "number") S.walk = walk;
    hint = ""; openKey = "";
    applyState();
  }

  function syncInputs() {
    if (document.activeElement !== $("inFrom")) $("inFrom").value = fromLabel(S.from);
    if (document.activeElement !== $("inTo")) $("inTo").value = "";
    $("inTo").placeholder = S.to.length ? "Přidat další cíl" : "Prázdné = všechny směry";
    $("dests").innerHTML = S.to.map(function (id, i) {
      return '<button type="button" class="dest" data-d="' + i + '" aria-label="Odebrat cíl ' +
        esc(stopName(id)) + '">' + esc(stopName(id)) + " ✕</button>";
    }).join("");
    $("dests").hidden = !S.to.length;
    $("walkVal").textContent = S.walk;
    var place = origin && origin.type === "place";
    $("walkBox").hidden = !!place;
    $("btnSwap").hidden = !(origin && origin.type === "stop" && S.to.length === 1);
    $("btnNow").hidden = !planAt;
    $("inTime").value = planAt;
  }

  // ---- 4.3 Hledani ulice / adresy (OpenStreetMap Nominatim) ----
  function geocode(q) {
    var url = CFG.GEOCODE_URL + "?format=jsonv2&addressdetails=1&limit=6&countrycodes=cz" +
      "&bounded=1&viewbox=" + encodeURIComponent(CFG.GEOCODE_BOX) +
      "&accept-language=cs&q=" + encodeURIComponent(q);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (list) {
      var seen = {};
      return list.map(function (x) {
        var a = x.address || {};
        var street = a.road || a.pedestrian || a.square || a.footway || x.name || "";
        var head = street ? street + (a.house_number ? " " + a.house_number : "") : (x.name || "");
        var town = a.city || a.town || a.village || a.municipality || "";
        var part = a.suburb || a.city_district || a.quarter || "";
        var sub = [part, town].filter(function (v, i, arr) { return v && arr.indexOf(v) === i; }).join(", ");
        return { name: head || String(x.display_name).split(",")[0], sub: sub, lat: +x.lat, lon: +x.lon };
      }).filter(function (g) {
        var k = g.name + "|" + g.sub;
        if (!g.name || isNaN(g.lat) || isNaN(g.lon) || seen[k]) return false;
        seen[k] = 1;
        return true;
      });
    });
  }

  // ---- 4.4 Aktualni poloha ----
  function locate(silent) {
    if (!navigator.geolocation) {
      if (!silent) { hint = "Tento prohlížeč polohu neposkytuje."; render(); }
      return;
    }
    if (!silent) { hint = "Zjišťuji polohu…"; render(); }
    navigator.geolocation.getCurrentPosition(function (pos) {
      S.from = { n: "Moje poloha", la: +pos.coords.latitude.toFixed(5), lo: +pos.coords.longitude.toFixed(5), gps: true };
      hint = "";
      applyState();
    }, function (err) {
      if (silent) return;
      hint = err && err.code === 1
        ? "Poloha není povolená. Povolte ji pro tuto stránku v nastavení prohlížeče."
        : "Polohu se nepodařilo zjistit. Zkuste to znovu, nebo zadejte ulici.";
      render();
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }

  // ---- 4.5 Naseptavac ----
  function setupPicker(inputId, listId, which) {
    var inp = $(inputId), box = $(listId);
    function close() { box.hidden = true; box.innerHTML = ""; }
    function show() {
      var q = inp.value.trim();
      if (!q) { close(); return; }
      var only = (which === "to" && origin) ? reach : null;
      var res = Core.search(q, which === "from" ? 6 : 8, only);
      if (which === "to") res = res.filter(function (i) { return S.to.indexOf(Core.stop(i)[0]) < 0; });
      var html = res.map(function (i) {
        var s = Core.stop(i);
        return '<button type="button" class="sug" data-i="' + i + '">' + esc(s[1]) +
          '<span class="zone">zóna ' + esc(s[2]) + "</span></button>";
      }).join("");
      if (which === "from" && q.length >= 3) {
        html += '<button type="button" class="sug street" data-geo="1">Hledat ulici „' + esc(q) +
          '“<span class="zone">odjezdy v okolí</span></button>';
      }
      if (!html) {
        html = '<div class="sug none">' +
          (only ? "Žádná zastávka s přímým spojem" : "Zastávka nenalezena") + "</div>";
      }
      box.innerHTML = html;
      box.hidden = false;
    }
    function runGeocode() {
      var q = inp.value.trim();
      if (q.length < 3) return;
      box.innerHTML = '<div class="sug none">Hledám adresu…</div>';
      box.hidden = false;
      geocode(q).then(function (list) {
        geoResults = list;
        if (!list.length) {
          box.innerHTML = '<div class="sug none">Ulice nenalezena. Zkuste přidat obec, např. „' +
            esc(q) + ' Brno“.</div>';
          return;
        }
        box.innerHTML = list.map(function (g, i) {
          return '<button type="button" class="sug" data-g="' + i + '">' + esc(g.name) +
            '<span class="zone">' + esc(g.sub) + "</span></button>";
        }).join("");
      }).catch(function () {
        box.innerHTML = '<div class="sug none">Hledání adres teď není dostupné. Zkuste to za chvíli, nebo zadejte zastávku.</div>';
      });
    }
    function pick(b) {
      if (b.hasAttribute("data-geo")) { runGeocode(); return; }
      if (b.hasAttribute("data-g")) {
        var g = geoResults[+b.getAttribute("data-g")];
        if (!g) return;
        close(); inp.blur();
        setRoute({ n: g.name + (g.sub ? ", " + g.sub : ""), la: g.lat, lo: g.lon }, S.to);
        return;
      }
      var id = Core.stop(+b.getAttribute("data-i"))[0];
      close(); inp.value = ""; inp.blur();
      if (which === "from") setRoute(id, S.to);
      else setRoute(S.from, S.to.concat([id]));
    }
    inp.addEventListener("input", show);
    inp.addEventListener("focus", function () { inp.select(); show(); });
    inp.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      var first = box.querySelector(".sug[data-i], .sug[data-g]");
      if (first) pick(first);
      else if (which === "from") runGeocode();
    });
    inp.addEventListener("blur", function () {
      setTimeout(function () {
        close();
        if (which === "from" && !inp.value.trim() && S.from != null) setRoute(null, S.to);
        syncInputs();
      }, 200);
    });
    box.addEventListener("pointerdown", function (ev) {
      var b = ev.target.closest("button.sug");
      if (!b) return;
      ev.preventDefault();
      pick(b);
    });
  }

  // ---- 4.6 Ulozene trasy ----
  function favIndex() {
    var k = routeKey(S.from, S.to);
    for (var i = 0; i < S.favs.length; i++) if (routeKey(S.favs[i].from, S.favs[i].to) === k) return i;
    return -1;
  }
  function defaultFavName() {
    var a = fromLabel(S.from).split(",")[0];
    var b = S.to.map(stopName).join(" / ");
    return b ? a + " → " + b : a + " · okolí";
  }
  function favAutoName(f) {
    var x = fromLabel(f.from).split(",")[0], y = (f.to || []).map(stopName).join(" / ");
    return y ? x + " → " + y : x + " · okolí";
  }
  function bucket(dateObj) {
    var d = dateObj || new Date(), wd = d.getDay();
    return (wd === 0 || wd === 6 ? "w" : "d") + d.getHours();
  }
  function bucketShift(b, n) { return b.charAt(0) + ((+b.slice(1) + n + 24) % 24); }
  function smartPick() {
    if (!S.smart || !S.favs.length) return null;
    var b = bucket(), best = null, bestScore = 0;
    S.favs.forEach(function (f) {
      var u = f.use || {};
      var sc = 2 * (u[b] || 0) + (u[bucketShift(b, -1)] || 0) + (u[bucketShift(b, 1)] || 0);
      if (sc > bestScore) { bestScore = sc; best = f; }
    });
    return bestScore >= 4 ? best : null;     // aspon 2 pouziti v tuto hodinu
  }
  function useFav(f, auto) {
    if (!auto) { f.use = f.use || {}; var b = bucket(); f.use[b] = (f.use[b] || 0) + 1; }
    setRoute(f.from, f.to, f.walk);
    if (auto) { hint = "Trasa „" + f.name + "“ vybrána podle obvyklého času."; render(); }
    if (isPlace(f.from) && f.from.gps) locate(true);
  }
  function renderFavs() {
    var el = $("favs"), cur = routeKey(S.from, S.to);
    var html = S.favs.map(function (f, i) {
      var act = routeKey(f.from, f.to) === cur ? " active" : "";
      return '<button type="button" class="fav' + act + '" data-f="' + i + '">' + esc(f.name || favAutoName(f)) + "</button>";
    }).join("");
    el.innerHTML = html;
    el.hidden = !html;
    var star = $("btnFav"), fi = favIndex();
    star.disabled = !origin;
    star.textContent = fi >= 0 ? "★ " + (S.favs[fi].name || "Uloženo") : "☆ Uložit trasu";
  }
  function openFavEdit() {
    if (!origin) return;
    var fi = favIndex();
    $("favName").value = fi >= 0 ? S.favs[fi].name : defaultFavName();
    $("favDelete").hidden = fi < 0;
    $("favEdit").hidden = false;
    $("favName").focus();
    $("favName").select();
  }
  function closeFavEdit() { $("favEdit").hidden = true; }

  // ---- 4.7 Vykresleni ----
  function minutesText(m) {
    if (m < 0.5) return "teď";
    var r = Math.floor(m + 0.25);
    if (r < 1) r = 1;
    if (r >= 60) return Math.floor(r / 60) + " h " + (r % 60) + " min";
    return r + " min";
  }
  function isLight(hex) {
    if (!hex || hex.length !== 6) return false;
    var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 150;
  }
  function badge(r) {
    var bg = r.color ? "#" + r.color : "#555";
    var fg = r.textColor ? "#" + r.textColor : (isLight(r.color) ? "#000" : "#fff");
    return '<span class="badge" style="background:' + bg + ";color:" + fg + '">' + esc(r.line) + "</span>";
  }
  function lineSort(a, b) {
    var na = parseInt(a.replace(/\D/g, ""), 10), nb = parseInt(b.replace(/\D/g, ""), 10);
    var la = /^\d/.test(a) ? 0 : 1, lb = /^\d/.test(b) ? 0 : 1;
    return la - lb || (na || 0) - (nb || 0) || a.localeCompare(b);
  }
  function leaveText(r, now) {
    if (r.leaveIn < -0.5) return "nestihnete";
    if (now.planned) return "vyrazit v " + Core.fmtTime(r.dep - r.walk);
    if (r.leaveIn < 1) return "vyrazit hned";
    return "vyrazit za " + minutesText(r.leaveIn);
  }

  function renderDetail(r) {
    var t = Core.tripStops(r), html = '<div class="detail">';
    if (t.vehicle) {
      html += '<p class="vehpos">' + (t.vehicle.before <= 0 ? "Vůz je právě v zastávce."
        : "Vůz je teď u zastávky " + esc(t.vehicle.name) + " – " + t.vehicle.before +
        (t.vehicle.before === 1 ? " zastávku" : (t.vehicle.before < 5 ? " zastávky" : " zastávek")) + " před vámi.") + "</p>";
    } else {
      html += '<p class="vehpos">Polohu vozu zatím neznám – časy jsou podle jízdního řádu.</p>';
    }
    html += "<ol>" + t.stops.map(function (s) {
      return '<li class="' + (s.board ? "board" : "") + (s.dest ? " dest" : "") + '"><span class="t">' +
        Core.fmtTime(s.time) + "</span>" + esc(s.name) + "</li>";
    }).join("") + "</ol></div>";
    return html;
  }

  function render() {
    renderFavs();
    var list = $("list"), info = $("info"), near = $("near"), hero = $("hero");
    var chips = $("lines"), dirs = $("dirs"), hintEl = $("hint");
    hintEl.textContent = hint; hintEl.hidden = !hint;
    near.hidden = true; hero.hidden = true; chips.hidden = true; dirs.hidden = true;
    if (!origin) {
      list.innerHTML = "";
      info.textContent = "Zadejte zastávku nebo ulici, odkud jedete, nebo klepněte na ◎ pro odjezdy z okolí.";
      info.hidden = false;
      renderStatus();
      return;
    }
    var place = origin.type === "place";
    var origins = place ? origin.stops : [{ idx: origin.idx, walk: S.walk }];
    if (place) {
      near.hidden = false;
      near.textContent = origins.length
        ? "Zastávky v okolí: " + origins.map(function (o) {
          return Core.stop(o.idx)[1] + " (" + o.walk + " min)";
        }).join(", ")
        : "V okolí není žádná zastávka IDS JMK.";
    }
    var now = planAt ? Core.plannedNow(new Date(), planAt) : Core.pragueNow(new Date());
    var res = Core.departures(origins, toIdxs, now, Live.list());
    var all = res.rows;
    if (place) all = all.filter(function (r) { return r.leaveIn >= -0.5; });   // z adresy jen to, co se da stihnout

    // filtr linek
    var hidden = S.hide[originKey()] || [];
    var lineSet = {};
    all.forEach(function (r) { lineSet[r.line] = r; });
    var lines = Object.keys(lineSet).sort(lineSort);
    if (lines.length > 1) {
      chips.hidden = false;
      chips.innerHTML = '<span class="lbl">Linky</span>' + lines.map(function (l) {
        var off = hidden.indexOf(l) >= 0;
        return '<button type="button" class="lchip' + (off ? " off" : "") + '" data-l="' + esc(l) +
          '" aria-pressed="' + (off ? "false" : "true") + '">' + esc(l) + "</button>";
      }).join("");
    }
    var rows = all.filter(function (r) { return hidden.indexOf(r.line) < 0; });

    // filtr smeru (jen bez cile a kdyz to dava smysl)
    var hasDir = !toIdxs.length && rows.some(function (r) { return r.dir === "in"; }) &&
      rows.some(function (r) { return r.dir === "out"; });
    if (hasDir) {
      dirs.hidden = false;
      dirs.innerHTML = [["all", "Všechny směry"], ["in", "Do centra"], ["out", "Jinam"]].map(function (d) {
        return '<button type="button" class="dchip' + (dirFilter === d[0] ? " on" : "") + '" data-dir="' + d[0] + '">' + d[1] + "</button>";
      }).join("");
      if (dirFilter !== "all") rows = rows.filter(function (r) { return r.dir === dirFilter; });
    } else {
      dirFilter = "all";
    }

    rows = rows.slice(0, CFG.MAX_ROWS);
    if (!rows.length) {
      list.innerHTML = "";
      info.textContent = toIdxs.length
        ? "V příštích " + (CFG.HORIZON_MIN / 60) + " hodinách odtud do cíle nejede žádný přímý spoj."
        : (all.length ? "Všechny spoje jsou skryté filtrem." : "V nejbližší době odtud nic nejede.");
      info.hidden = false;
      renderStatus();
      return;
    }
    info.hidden = true;

    // hlavni karta: prvni spoj, ktery se da stihnout
    var top = null;
    for (var q = 0; q < rows.length; q++) if (rows[q].leaveIn >= -0.5) { top = rows[q]; break; }
    if (top) {
      var title = now.planned ? "Vyrazte v " + Core.fmtTime(top.dep - top.walk)
        : (top.leaveIn < 1 ? "Vyrazte hned" : "Vyrazte za " + minutesText(top.leaveIn));
      var sub = [];
      sub.push("odjezd " + Core.fmtTime(top.dep) + (now.tomorrow ? " (zítra)" : ""));
      if (place) sub.push("ze zastávky " + esc(top.stopName));
      if (top.arr != null) sub.push("v cíli " + Core.fmtTime(top.arr) + (toIdxs.length > 1 ? " " + esc(top.destName) : ""));
      hero.hidden = false;
      hero.innerHTML = '<div class="htitle">' + title + '</div><div class="hline">' + badge(top) +
        '<span class="hhead">' + esc(top.headsign) + '</span></div><div class="hsub">' + sub.join(" · ") + "</div>";
    }

    list.innerHTML = rows.map(function (r) {
      var miss = r.leaveIn < -0.5;
      var d = Math.round(r.delay);
      var timeTxt = Core.fmtTime(r.sched) +
        (r.live ? (d > 0 ? ' <span class="late">+' + d + "</span>" : (d < 0 ? ' <span class="early">' + d + "</span>" : ' <span class="ontime">včas</span>')) : "");
      var meta = [];
      if (place) meta.push("<b>" + esc(r.stopName) + "</b> " + r.walk + " min pěšky");
      if (r.platform) meta.push("nást. " + esc(r.platform));
      if (r.arr != null) meta.push("v cíli " + Core.fmtTime(r.arr) + (toIdxs.length > 1 ? " " + esc(r.destName) : ""));
      if (r.lowFloor) meta.push("nízkopodlažní");
      if (r.request) meta.push("na znamení");
      var open = openKey === r.key;
      var big = now.planned ? Core.fmtTime(r.dep) : (r.atStop ? "v zastávce" : minutesText(r.inMin));
      return '<li class="row' + (miss ? " miss" : "") + (r === top ? " hot" : "") + (open ? " open" : "") + '">' +
        '<button type="button" class="rowbtn" data-k="' + esc(r.key) + '" aria-expanded="' + (open ? "true" : "false") + '">' +
        badge(r) +
        '<span class="mid"><span class="head">' + esc(r.headsign) + "</span>" +
        '<span class="meta">' + meta.join(" · ") + "</span></span>" +
        '<span class="right"><span class="in">' + big + "</span>" +
        '<span class="time"><span class="dot ' + (r.live ? "live" : "plan") + '" title="' +
        (r.live ? "živá data" : "podle jízdního řádu") + '"></span>' + timeTxt + "</span>" +
        '<span class="leave">' + leaveText(r, now) + "</span></span></button>" +
        (open ? renderDetail(r) : "") + "</li>";
    }).join("");
    renderStatus();
  }

  function renderStatus() {
    var st = Live.state(), D = Core.data();
    var live;
    if (planAt) live = "plánovaný čas – časy podle jízdního řádu";
    else if (st.ok) live = "živá data připojena (" + st.count + " vozů)";
    else if (st.status === "connecting") live = "připojuji živá data…";
    else live = "živá data nedostupná – časy podle jízdního řádu";
    var gen = D ? D.gen.slice(8, 10) + "." + D.gen.slice(5, 7) + "." : "?";
    $("status").innerHTML = '<span class="dot ' + (st.ok && !planAt ? "live" : "plan") + '"></span>' + live +
      " · jízdní řád z " + gen;
    var age = D ? (Date.now() - Date.parse(D.gen)) / 86400000 : 0;
    $("stale").hidden = !(age > 10);
  }

  // ---- 4.8 Start a ovladani ----
  function init() {
    restore();
    setupPicker("inFrom", "sugFrom", "from");
    setupPicker("inTo", "sugTo", "to");

    $("btnGps").addEventListener("click", function () { locate(false); });
    $("btnSwap").addEventListener("click", function () {
      if (isPlace(S.from) || S.to.length !== 1) return;
      setRoute(S.to[0], [S.from]);
    });
    $("dests").addEventListener("click", function (ev) {
      var b = ev.target.closest(".dest");
      if (!b) return;
      var to = S.to.slice(); to.splice(+b.getAttribute("data-d"), 1);
      setRoute(S.from, to);
    });
    $("walkMinus").addEventListener("click", function () { S.walk = Math.max(0, S.walk - 1); save(); syncInputs(); render(); });
    $("walkPlus").addEventListener("click", function () { S.walk = Math.min(60, S.walk + 1); save(); syncInputs(); render(); });

    // odjezd pozdeji
    $("inTime").addEventListener("change", function () { planAt = $("inTime").value || ""; openKey = ""; syncInputs(); render(); });
    $("btnNow").addEventListener("click", function () { planAt = ""; syncInputs(); render(); });

    // ulozene trasy
    $("btnFav").addEventListener("click", openFavEdit);
    $("favCancel").addEventListener("click", closeFavEdit);
    $("favSave").addEventListener("click", function () {
      var name = $("favName").value.trim() || defaultFavName(), fi = favIndex();
      if (fi >= 0) { S.favs[fi].name = name; S.favs[fi].walk = S.walk; }
      else S.favs.push({ name: name, from: S.from, to: S.to.slice(), walk: S.walk, use: {} });
      save(); closeFavEdit(); render();
    });
    $("favName").addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); $("favSave").click(); } });
    $("favDelete").addEventListener("click", function () {
      var fi = favIndex();
      if (fi >= 0) S.favs.splice(fi, 1);
      save(); closeFavEdit(); render();
    });
    $("favs").addEventListener("click", function (ev) {
      var b = ev.target.closest(".fav");
      if (!b) return;
      var f = S.favs[+b.getAttribute("data-f")];
      if (f) { useFav(f, false); save(); }
    });

    // filtry a detail
    $("lines").addEventListener("click", function (ev) {
      var b = ev.target.closest(".lchip");
      if (!b) return;
      var k = originKey(), l = b.getAttribute("data-l"), arr = (S.hide[k] || []).slice();
      var at = arr.indexOf(l);
      if (at >= 0) arr.splice(at, 1); else arr.push(l);
      if (arr.length) S.hide[k] = arr; else delete S.hide[k];
      save(); render();
    });
    $("dirs").addEventListener("click", function (ev) {
      var b = ev.target.closest(".dchip");
      if (!b) return;
      dirFilter = b.getAttribute("data-dir"); render();
    });
    $("list").addEventListener("click", function (ev) {
      var b = ev.target.closest(".rowbtn");
      if (!b) return;
      var k = b.getAttribute("data-k");
      openKey = openKey === k ? "" : k;
      render();
    });

    // nastaveni
    $("setSpeed").value = String(S.speed);
    $("setRadius").value = String(S.radius);
    $("setSmart").checked = S.smart;
    $("setSpeed").addEventListener("change", function () { S.speed = +$("setSpeed").value || 75; applyState(); });
    $("setRadius").addEventListener("change", function () { S.radius = +$("setRadius").value || 500; applyState(); });
    $("setSmart").addEventListener("change", function () { S.smart = $("setSmart").checked; save(); });

    // provoz bez signalu
    if ("serviceWorker" in navigator && location.protocol === "https:") {
      navigator.serviceWorker.register("sw.js").catch(function () { });
    }

    $("info").textContent = "Načítám jízdní řád…";
    fetch(CFG.DATA_URL, { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) {
        Core.load(data);
        var auto = smartPick();
        if (auto && routeKey(auto.from, auto.to) !== routeKey(S.from, S.to)) useFav(auto, true);
        else {
          applyState();
          if (isPlace(S.from) && S.from.gps) locate(true);
        }
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

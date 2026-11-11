/* Plan cesty - IDS JMK
 * Vice zastaveni za sebou: start -> zastaveni s pobytem -> cil s casem "nejpozdeji".
 * Vyhledavani spojeni s prestupy (Connection Scan) nad jizdnim radem z data.json.
 * Navazuje na app.js (Core, CFG).
 */
"use strict";

var Planner = (function () {
  // ============================================================
  // 1. NASTAVENI
  // ============================================================
  var C = (typeof Core !== "undefined") ? Core : null;
  var G = (typeof CFG !== "undefined") ? CFG : null;
  if (!C && typeof require === "function") { var mod = require("./app.js"); C = mod.Core; G = mod.CFG; }

  var PC = {
    FOOT_M: 300,          // pesi prestup mezi zastavkami do teto vzdalenosti
    TRANSFER_MIN: 1,      // minimalni cas na prestup ve stejne zastavce
    TIGHT_MIN: 1,         // prestup s cekanim do teto hodnoty je "napjaty"
    DIRECT_WALK_M: 3000,  // primou chuzi mezi misty zvazovat do teto vzdalenosti
    WALK_BONUS: 3,        // chuze musi byt aspon o tolik minut lepsi nez MHD
    BOX_DEG: 0.15,        // okoli mist, ve kterem se berou spoje (~15 km)
    ALT_MAX: 4,           // kolik zaloznich spoju ukazat
    ALT_RUNS: 40,         // kolik odjezdu nejvys zkouset pri hledani zaloh
    INF: 1e9
  };

  // ============================================================
  // 2. POMOCNE FUNKCE
  // ============================================================
  function ymdToUtc(ymd) { return Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)); }
  function dayDiff(a, b) { return Math.round((ymdToUtc(a) - ymdToUtc(b)) / 86400000); }
  function addDays(ymd, n) { return new Date(ymdToUtc(ymd) + n * 86400000).toISOString().slice(0, 10); }
  function distM(lat1, lon1, lat2, lon2) {
    var kx = 111320 * Math.cos(lat1 * Math.PI / 180), ky = 110540;
    var dx = (lon2 - lon1) * kx, dy = (lat2 - lat1) * ky;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function walkMin(d, speed) { return Math.max(1, Math.ceil(d * G.WALK_DETOUR / speed)); }
  function parseHM(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(s || "");
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }
  function lowerBound(cs, t) {
    var lo = 0, hi = cs.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (cs[mid][0] < t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // ============================================================
  // 3. PESI PRESUNY MEZI ZASTAVKAMI (mrizka ~330 m)
  // ============================================================
  var gridD = null, grid = null, footSpeed = 0, foot = [];
  function neighbors(i, speed) {
    var D = C.data();
    if (gridD !== D) {
      grid = {}; gridD = D; foot = []; footSpeed = 0;
      D.stops.forEach(function (s, k) {
        var key = Math.floor(s[3] / 0.003) + ":" + Math.floor(s[4] / 0.0045);
        (grid[key] = grid[key] || []).push(k);
      });
    }
    if (footSpeed !== speed) { foot = []; footSpeed = speed; }
    if (foot[i]) return foot[i];
    var s = D.stops[i], a = Math.floor(s[3] / 0.003), b = Math.floor(s[4] / 0.0045), out = [];
    for (var da = -1; da <= 1; da++) {
      for (var db = -1; db <= 1; db++) {
        var cell = grid[(a + da) + ":" + (b + db)];
        if (!cell) continue;
        for (var q = 0; q < cell.length; q++) {
          var j = cell[q];
          if (j === i) continue;
          var t = D.stops[j], d = distM(s[3], s[4], t[3], t[4]);
          if (d <= PC.FOOT_M) out.push([j, walkMin(d, speed) + 1]);   // +1 min na orientaci
        }
      }
    }
    foot[i] = out;
    return out;
  }

  // ============================================================
  // 4. SIT SPOJU PRO DANY DEN A CASOVE OKNO
  //    spoj = [odjezd, prijezd, z, do, jizda, poradi, priznaky(1 nelze nastoupit, 2 nelze vystoupit)]
  // ============================================================
  var netCache = { key: "", net: null };
  function buildNet(ymd, tFrom, tTo, box) {
    var key = [ymd, tFrom, tTo, box.join(",")].join("|");
    if (netCache.key === key) return netCache.net;
    var D = C.data(), N = D.stops.length, di = dayDiff(ymd, D.base);
    var inBox = new Uint8Array(N);
    for (var i = 0; i < N; i++) {
      var s = D.stops[i];
      if (s[3] >= box[0] && s[3] <= box[1] && s[4] >= box[2] && s[4] <= box[3]) inBox[i] = 1;
    }
    var conns = [], trips = [];
    D.pat.forEach(function (p, pi) {
      var nodes = p[2], dep = p[4], arr = p[5] || p[4], fl = p[6], tr = p[7], last = nodes.length - 1;
      var any = false;
      for (var k = 0; k <= last; k++) if (inBox[nodes[k]]) { any = true; break; }
      if (!any) return;
      for (var off = -1; off <= 1; off++) {
        var dd = di + off;
        if (dd < 0) continue;
        for (var t = 0; t < tr.length; t += 2) {
          if (D.svc[tr[t + 1]].charAt(dd) !== "1") continue;
          var t0 = off * 1440 + tr[t];
          if (t0 + arr[last] < tFrom || t0 > tTo) continue;
          var tid = -1;
          for (var k2 = 0; k2 < last; k2++) {
            var d = t0 + dep[k2];
            if (d < tFrom || d > tTo) continue;
            if (!inBox[nodes[k2]] && !inBox[nodes[k2 + 1]]) continue;
            if (tid < 0) { tid = trips.length; trips.push([pi, t0]); }
            var f = 0;
            if (fl && (fl[k2] & 1)) f |= 1;
            if (fl && (fl[k2 + 1] & 2)) f |= 2;
            conns.push([d, t0 + arr[k2 + 1], nodes[k2], nodes[k2 + 1], tid, k2, f]);
          }
        }
      }
    });
    conns.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1] || a[4] - b[4] || a[5] - b[5]; });
    var net = { ymd: ymd, conns: conns, trips: trips };
    netCache = { key: key, net: net };
    return net;
  }

  // ============================================================
  // 5. NEJDRIVEJSI PRIJEZD (dopredu)
  //    sources: [{idx, t, walk}] = zastavka, cas pripravenosti na ni, chuze z mista
  // ============================================================
  function earliest(net, sources, speed, tLimit) {
    var N = C.data().stops.length, INF = PC.INF;
    var Tf = new Float64Array(N).fill(INF), Tv = new Float64Array(N).fill(INF);
    var Jf = new Array(N), Jv = new Array(N);
    var tb = new Int32Array(net.trips.length).fill(-1), tbm = new Uint8Array(net.trips.length);
    var minT = INF;
    sources.forEach(function (s) {
      if (s.t < Tf[s.idx]) { Tf[s.idx] = s.t; Jf[s.idx] = { start: 1, walk: s.walk }; }
      if (s.t < minT) minT = s.t;
    });
    sources.forEach(function (s) {
      neighbors(s.idx, speed).forEach(function (n) {
        var t = s.t + n[1];
        if (t < Tf[n[0]]) { Tf[n[0]] = t; Jf[n[0]] = { from: s.idx, w: n[1], veh: 0 }; }
      });
    });
    var cs = net.conns;
    for (var i = lowerBound(cs, minT); i < cs.length; i++) {
      var c = cs[i];
      if (c[0] > tLimit) break;
      var tid = c[4];
      if (tb[tid] < 0) {
        if (c[6] & 1) continue;
        if (Tf[c[2]] <= c[0]) { tb[tid] = i; tbm[tid] = 0; }
        else if (Tv[c[2]] + PC.TRANSFER_MIN <= c[0]) { tb[tid] = i; tbm[tid] = 1; }
        else continue;
      }
      if (c[6] & 2) continue;
      if (c[1] < Tv[c[3]]) {
        Tv[c[3]] = c[1];
        Jv[c[3]] = [tb[tid], i];
        var nb = neighbors(c[3], speed);
        for (var q = 0; q < nb.length; q++) {
          var t2 = c[1] + nb[q][1];
          if (t2 < Tf[nb[q][0]]) { Tf[nb[q][0]] = t2; Jf[nb[q][0]] = { from: c[3], w: nb[q][1], veh: 1 }; }
        }
      }
    }
    return { net: net, Tf: Tf, Tv: Tv, Jf: Jf, Jv: Jv, tbm: tbm };
  }

  function bestAt(res, targets) {
    var best = null;
    targets.forEach(function (t) {
      var f = res.Tf[t.idx], v = res.Tv[t.idx], a = Math.min(f, v);
      if (a >= PC.INF) return;
      var tot = a + t.walk;
      if (!best || tot < best.arrive) best = { idx: t.idx, mode: v <= f ? 1 : 0, walk: t.walk, arrive: tot };
    });
    return best;
  }

  function reconstruct(res, best) {
    var cs = res.net.conns, legs = [], cur = best.idx, mode = best.mode, guard = 0, startWalk = 0;
    while (guard++ < 80) {
      if (mode === 1) {
        var jv = res.Jv[cur];
        if (!jv) break;
        var cb = cs[jv[0]], ca = cs[jv[1]];
        legs.unshift({ type: "ride", tid: cb[4], from: cb[2], to: ca[3], dep: cb[0], arr: ca[1], k0: cb[5] });
        cur = cb[2];
        mode = res.tbm[cb[4]];
        continue;
      }
      var jf = res.Jf[cur];
      if (!jf) break;
      if (jf.start) { startWalk = jf.walk; break; }
      legs.unshift({ type: "walk", from: jf.from, to: cur, min: jf.w });
      cur = jf.from;
      mode = jf.veh;
    }
    return { legs: legs, startIdx: cur, startWalk: startWalk, endIdx: best.idx, endWalk: best.walk };
  }

  // ============================================================
  // 6. NEJPOZDEJSI ODJEZD (zpetne)
  //    targets: [{idx, T}] = zastavka a nejpozdejsi cas na ni (uz bez chuze do mista)
  //    vraci F[s] = nejpozdejsi cas, kdy staci byt pesky na zastavce s
  // ============================================================
  function latest(net, targets, speed, tMin) {
    var N = C.data().stops.length, NEG = -PC.INF;
    var F = new Float64Array(N).fill(NEG), V = new Float64Array(N).fill(NEG);
    var ok = new Uint8Array(net.trips.length), maxT = NEG;
    function put(j, tf, tv) { if (tf > F[j]) F[j] = tf; if (tv > V[j]) V[j] = tv; }
    targets.forEach(function (t) {
      put(t.idx, t.T, t.T);
      if (t.T > maxT) maxT = t.T;
      neighbors(t.idx, speed).forEach(function (n) { put(n[0], t.T - n[1], t.T - n[1]); });
    });
    var cs = net.conns;
    for (var i = lowerBound(cs, maxT + 0.5) - 1; i >= 0; i--) {
      var c = cs[i];
      if (c[0] < tMin) break;
      var tid = c[4];
      if (!ok[tid]) {
        if (c[6] & 2) continue;
        if (c[1] > V[c[3]]) continue;
        ok[tid] = 1;
      }
      if (c[6] & 1) continue;
      if (c[0] > F[c[2]]) {
        put(c[2], c[0], c[0] - PC.TRANSFER_MIN);
        var nb = neighbors(c[2], speed);
        for (var q = 0; q < nb.length; q++) put(nb[q][0], c[0] - nb[q][1], c[0] - nb[q][1]);
      } else if (c[0] - PC.TRANSFER_MIN > V[c[2]]) {
        V[c[2]] = c[0] - PC.TRANSFER_MIN;
      }
    }
    return F;
  }

  // ============================================================
  // 7. USEK MEZI DVEMA MISTY
  //    misto: {k:"s", id, n} = zastavka | {k:"p", n, la, lo} = adresa nebo poloha
  // ============================================================
  function placeStops(pl, o) {
    if (pl.k === "s") {
      var i = C.findById(pl.id);
      return i < 0 ? [] : [{ idx: i, walk: 0, dist: 0 }];
    }
    return C.nearby(pl.la, pl.lo, o.radius, o.speed);
  }
  function placeXY(pl) {
    if (pl.k === "s") { var s = C.stop(C.findById(pl.id)); return [s[3], s[4]]; }
    return [pl.la, pl.lo];
  }
  function directWalk(A, B, o) {
    var a = placeXY(A), b = placeXY(B), d = distM(a[0], a[1], b[0], b[1]);
    return d <= PC.DIRECT_WALK_M ? walkMin(d, o.speed) : null;
  }

  function legFwd(net, A, B, t, o, tLimit, noWalk) {
    var sa = placeStops(A, o), sb = placeStops(B, o), out = null;
    if (sa.length && sb.length) {
      var res = earliest(net, sa.map(function (s) { return { idx: s.idx, t: t + s.walk, walk: s.walk }; }), o.speed, tLimit);
      var best = bestAt(res, sb);
      if (best) {
        var r = reconstruct(res, best), pre = r.startWalk, first = null;
        for (var q = 0; q < r.legs.length; q++) {
          if (r.legs[q].type === "ride") { first = r.legs[q]; break; }
          pre += r.legs[q].min;
        }
        if (first) {
          out = {
            mode: "pt", legs: r.legs, startIdx: r.startIdx, startWalk: r.startWalk,
            endIdx: r.endIdx, endWalk: r.endWalk, leave: first.dep - pre, arrive: best.arrive
          };
        }
      }
    }
    if (!noWalk) {
      var w = directWalk(A, B, o);
      if (w != null && (!out || t + w + PC.WALK_BONUS <= out.arrive)) {
        out = { mode: "walk", legs: [], walkMin: w, leave: t, arrive: t + w };
      }
    }
    return out;
  }

  function legBack(net, A, B, T, o, tMin) {
    var sa = placeStops(A, o), sb = placeStops(B, o), fw = null;
    if (sa.length && sb.length) {
      var F = latest(net, sb.map(function (s) { return { idx: s.idx, T: T - s.walk }; }), o.speed, tMin);
      var L = -PC.INF;
      sa.forEach(function (s) { var v = F[s.idx] - s.walk; if (v > L) L = v; });
      if (L > -PC.INF / 2) {
        // rekonstrukce doprednym hledanim od nalezeneho casu (s pojistkou proti nesouladu)
        for (var back = 0; back <= 5 && !fw; back++) {
          var cand = legFwd(net, A, B, L - back, o, T, true);
          if (cand && cand.arrive <= T) fw = cand;
        }
      }
    }
    var w = directWalk(A, B, o);
    if (w != null && (!fw || T - w >= fw.leave + PC.WALK_BONUS)) {
      return { mode: "walk", legs: [], walkMin: w, leave: T - w, arrive: T };
    }
    return fw;
  }

  // ============================================================
  // 8. ZALOZNI SPOJE ("Kdyz se zdrzite") - pozdejsi odchody, ktere jeste stihnou cil
  // ============================================================
  function alternatives(net, A, B, Lmain, Tn, o) {
    var top = legBack(net, A, B, Tn, o, Lmain - 1);
    if (!top || top.leave <= Lmain) return [];
    var cand = {}, cs = net.conns;
    cand[top.leave] = 1;
    placeStops(A, o).forEach(function (s) {
      for (var i = lowerBound(cs, Lmain + s.walk + 1); i < cs.length && cs[i][0] <= top.leave + s.walk; i++) {
        if (cs[i][2] === s.idx && !(cs[i][6] & 1)) cand[cs[i][0] - s.walk] = 1;
      }
    });
    var times = Object.keys(cand).map(Number).filter(function (t) { return t > Lmain && t <= top.leave; })
      .sort(function (a, b) { return b - a; }).slice(0, PC.ALT_RUNS);
    var opts = [], seen = {};
    times.forEach(function (t) {
      var r = (t === top.leave) ? top : legFwd(net, A, B, t, o, Tn, false);
      if (r && r.arrive <= Tn && r.leave > Lmain && !seen[r.leave]) { seen[r.leave] = 1; opts.push(r); }
    });
    opts.sort(function (a, b) { return b.leave - a.leave; });
    var out = [], bestArr = PC.INF;
    opts.forEach(function (r) {
      if (r.arrive < bestArr) { out.push(r); bestArr = r.arrive; }
    });
    out.sort(function (a, b) { return a.leave - b.leave; });
    return out.slice(0, PC.ALT_MAX);
  }

  // ============================================================
  // 9. CELY PLAN
  //    model: {date, start:{pl,t}, stops:[{pl,stay,stretch}], dest:{pl,t}, rez}
  //    o: {speed, radius, now: Date}
  // ============================================================
  function compute(model, o) {
    var D = C.data();
    var stopsIn = model.stops.filter(function (s) { return s.pl; });
    var places = [model.start.pl].concat(stopsIn.map(function (s) { return s.pl; })).concat([model.dest.pl]);
    var n = places.length - 1;
    if (!places[0]) return { error: "Zadejte, odkud vyrážíte." };
    if (!places[n]) return { error: "Zadejte cíl cesty." };
    for (var q = 0; q <= n; q++) {
      if (places[q].k === "s" && C.findById(places[q].id) < 0) {
        return { error: "Zastávka „" + places[q].n + "“ v aktuálním jízdním řádu není. Zadejte ji znovu." };
      }
    }

    // 9.1 Den a casy
    var ymd = model.date, di = dayDiff(ymd, D.base), maxDay = 0;
    D.svc.forEach(function (m) { if (m.length > maxDay) maxDay = m.length; });
    if (di < 1 || di >= maxDay) {
      return { error: "Pro tento den jízdní řád nemám (je k dispozici do " + fmtDate(addDays(D.base, maxDay - 1)) + ")." };
    }
    var nowP = C.pragueNow(o.now || new Date());
    var T0 = parseHM(model.start.t), Tn = parseHM(model.dest.t), rez = Math.max(0, +model.rez || 0);
    var notes = [];
    if (T0 == null && Tn == null) {
      if (ymd !== nowP.ymd) return { error: "Zadejte čas startu, nebo kdy nejpozději máte být v cíli." };
      T0 = Math.ceil(nowP.min);
      notes.push("Start počítám od teď (" + fmtTime(T0) + ").");
    }
    var stays = [0].concat(stopsIn.map(function (s) { return Math.max(0, Math.round(+s.stay || 0)); })).concat([0]);
    var k = -1;
    stopsIn.forEach(function (s, i) { if (s.stretch && k < 0) k = i + 1; });
    if (k >= 0 && (T0 == null || Tn == null)) {
      notes.push("Prodloužení pobytu jde jen se zadaným startem i časem v cíli – počítám s pevným pobytem.");
      k = -1;
    }
    var sumStay = stays.reduce(function (a, b) { return a + b; }, 0);
    var tFrom = T0 != null ? T0 : Tn - 240 - sumStay;
    var tTo = Tn != null ? Tn : T0 + 300 + sumStay;
    if (tTo <= tFrom) return { error: "Čas v cíli je dřív než start." };
    var tNet = Tn != null ? Tn + 90 : tTo;     // rezerva pro pripad, ze se cil nestihne

    // 9.2 Spoje v okoli mist
    var la = [], lo = [];
    places.forEach(function (p) { var xy = placeXY(p); la.push(xy[0]); lo.push(xy[1]); });
    var box = [Math.min.apply(null, la) - PC.BOX_DEG, Math.max.apply(null, la) + PC.BOX_DEG,
      Math.min.apply(null, lo) - PC.BOX_DEG * 1.5, Math.max.apply(null, lo) + PC.BOX_DEG * 1.5]
      .map(function (v) { return Math.round(v * 1000) / 1000; });
    var net = buildNet(ymd, tFrom - 1, tNet + 1, box);

    // 9.3 Dopredu od startu (az k prodlouzenemu pobytu, jinak az do cile)
    var legs = new Array(n), arr = new Array(n + 1), lv = new Array(n + 1), i, L;
    function nm(i) { return placeName(places[i]); }
    if (T0 != null) {
      var fEnd = k >= 0 ? k : n, t = T0;
      for (i = 0; i < fEnd; i++) {
        L = legFwd(net, places[i], places[i + 1], t, o, tNet + 1, false);
        if (!L) return { error: "Spojení z místa " + nm(i) + " do " + nm(i + 1) + " jsem nenašel." };
        legs[i] = L; lv[i] = L.leave; arr[i + 1] = L.arrive;
        if (i + 1 < n) t = arr[i + 1] + stays[i + 1];
      }
    }
    // 9.4 Zpetne od casu v cili
    if (k >= 0 || T0 == null) {
      var bStart = T0 == null ? 0 : k, T = Tn - rez;
      for (i = n - 1; i >= bStart; i--) {
        L = legBack(net, places[i], places[i + 1], T, o, tFrom - 1);
        if (!L) return { error: "Spojení z místa " + nm(i) + " do " + nm(i + 1) + ", které by stihlo čas, jsem nenašel." };
        legs[i] = L; lv[i] = L.leave; arr[i + 1] = L.arrive;
        if (i > bStart) T = lv[i] - stays[i];
      }
    }

    // 9.5 Nevejde se ani bez pobytu: dopocitat, kdy by byl v cili bez zastaveni
    var impossible = false;
    if (k >= 0 && lv[k] < arr[k]) {
      impossible = true;
      var t2 = arr[k];
      for (i = k; i < n; i++) {
        L = legFwd(net, places[i], places[i + 1], t2, o, tNet + 1, false);
        if (!L) return { error: "Nestihnete to: z místa " + nm(i) + " už do " + T_(Tn) + " nic nejede." };
        legs[i] = L; lv[i] = L.leave; arr[i + 1] = L.arrive;
        if (i + 1 < n) t2 = arr[i + 1] + stays[i + 1];
      }
    }

    // 9.6 Zalozni spoje pro posledni usek
    var altLeg = (!impossible && Tn != null && (k < 0 || k === n - 1)) ? n - 1 : -1, alts = [];
    if (altLeg >= 0) alts = alternatives(net, places[altLeg], places[n], lv[altLeg], Tn, o);

    return {
      ymd: ymd, T0: T0, Tn: Tn, rez: rez, k: k, impossible: impossible, places: places, stays: stays,
      legs: legs, arr: arr, lv: lv, alts: alts, altLeg: altLeg, notes: notes, net: net
    };
  }

  // ============================================================
  // 10. POPIS PRO ZOBRAZENI
  // ============================================================
  function fmtTime(min) { return C.fmtTime(min); }
  function T_(min) { return C.fmtTime(min); }
  function fmtDate(ymd) {
    var days = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];
    var d = new Date(ymdToUtc(ymd));
    return days[d.getUTCDay()] + " " + d.getUTCDate() + ". " + (d.getUTCMonth() + 1) + ".";
  }
  function placeName(pl) { return pl ? pl.n : ""; }
  function rideInfo(net, leg) {
    var D = C.data(), tr = net.trips[leg.tid], p = D.pat[tr[0]], r = D.routes[p[0]];
    var pm = D.plat[leg.from], post = p[3][leg.k0];
    return {
      line: r[0], type: r[1], color: r[2], textColor: r[3], headsign: p[1],
      fromName: D.stops[leg.from][1], toName: D.stops[leg.to][1],
      platform: pm && pm[post] ? pm[post] : ""
    };
  }

  return {
    compute: compute, rideInfo: rideInfo, fmtDate: fmtDate, fmtTime: fmtTime,
    placeName: placeName, addDays: addDays, PC: PC,
    _legFwd: legFwd, _legBack: legBack, _buildNet: buildNet
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = { Planner: Planner };
}

// ============================================================
// 11. UZIVATELSKE ROZHRANI ZALOZKY "PLAN CESTY"
// ============================================================
(function () {
  if (typeof document === "undefined") return;

  var KEY = "odjezdy.plan.v1";
  var P = null;              // model planu
  var formReady = false, timer = null, geoBusy = false;
  var $ = function (id) { return document.getElementById(id); };

  // ---- 11.1 Model a ulozeni ----
  function todayYmd() { return Core.pragueNow(new Date()).ymd; }
  function defModel() {
    return {
      date: todayYmd(), start: { pl: null, t: "" },
      stops: [{ pl: null, stay: 60, stretch: false }],
      dest: { pl: null, t: "" }, rez: 5
    };
  }
  function okPlace(pl) {
    if (!pl || typeof pl !== "object" || typeof pl.n !== "string") return null;
    if (pl.k === "s" && typeof pl.id === "number") return pl;
    if (pl.k === "p" && typeof pl.la === "number" && typeof pl.lo === "number") return pl;
    return null;
  }
  function load() {
    P = defModel();
    try {
      var o = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!o || typeof o !== "object") return;
      if (typeof o.date === "string" && o.date >= P.date) P.date = o.date;
      if (o.start) P.start = { pl: okPlace(o.start.pl), t: typeof o.start.t === "string" ? o.start.t : "" };
      if (o.dest) P.dest = { pl: okPlace(o.dest.pl), t: typeof o.dest.t === "string" ? o.dest.t : "" };
      if (Array.isArray(o.stops)) {
        P.stops = o.stops.map(function (s) {
          return { pl: okPlace(s && s.pl), stay: typeof (s && s.stay) === "number" ? s.stay : 30, stretch: !!(s && s.stretch) };
        });
      }
      if (typeof o.rez === "number") P.rez = o.rez;
    } catch (e) { }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(P)); } catch (e) { } }
  function settings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(CFG.STORE_KEY) || "{}") || {}; } catch (e) { }
    return {
      speed: typeof s.speed === "number" ? s.speed : CFG.WALK_M_PER_MIN,
      radius: typeof s.radius === "number" ? s.radius : CFG.NEAR_RADIUS_M
    };
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function hexOk(h) { return /^[0-9A-F]{6}$/i.test(h || "") ? h : ""; }
  function isLight(hex) {
    if (!hex) return false;
    var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 150;
  }
  function badge(ri) {
    var c = hexOk(ri.color), tc = hexOk(ri.textColor);
    var bg = c ? "#" + c : "#555", fg = tc ? "#" + tc : (isLight(c) ? "#000" : "#fff");
    return '<span class="badge sm" style="background:' + bg + ";color:" + fg + '">' + esc(ri.line) + "</span>";
  }
  var T = Planner.fmtTime;

  // ---- 11.2 Misto podle slotu ("start", "dest", "s0", "s1", ...) ----
  function getPlace(slot) {
    if (slot === "start") return P.start.pl;
    if (slot === "dest") return P.dest.pl;
    var s = P.stops[+slot.slice(1)];
    return s ? s.pl : null;
  }
  function setPlace(slot, pl) {
    if (slot === "start") P.start.pl = pl;
    else if (slot === "dest") P.dest.pl = pl;
    else { var s = P.stops[+slot.slice(1)]; if (s) s.pl = pl; }
    save();
    var inp = document.querySelector('.pin[data-slot="' + slot + '"]');
    if (inp && document.activeElement !== inp) inp.value = pl ? pl.n : "";
    schedule();
  }

  // ---- 11.3 Hledani adresy (OpenStreetMap Nominatim) ----
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
        var street = a.road || a.pedestrian || a.square || a.footway || "";
        var addr = street ? street + (a.house_number ? " " + a.house_number : "") : "";
        var town = a.city || a.town || a.village || a.municipality || "";
        var part = a.suburb || a.city_district || a.quarter || "";
        var poi = x.name && x.name !== street ? x.name : "";
        var head = poi || addr || String(x.display_name).split(",")[0];
        var sub = [poi ? addr : "", part, town].filter(function (v, i, arr) { return v && arr.indexOf(v) === i; }).join(", ");
        return { name: head, sub: sub, lat: +x.lat, lon: +x.lon };
      }).filter(function (g) {
        var key = g.name + "|" + g.sub;
        if (!g.name || isNaN(g.lat) || isNaN(g.lon) || seen[key]) return false;
        seen[key] = 1;
        return true;
      });
    });
  }

  // ---- 11.4 Naseptavac mista ----
  function bindPicker(inp, box) {
    var slot = inp.getAttribute("data-slot"), geo = [];
    function close() { box.hidden = true; box.innerHTML = ""; }
    function show() {
      var q = inp.value.trim();
      if (!q || !Core.data()) { close(); return; }
      var html = Core.search(q, 5).map(function (i) {
        var s = Core.stop(i);
        return '<button type="button" class="sug" data-i="' + i + '">' + esc(s[1]) +
          '<span class="zone">zastávka</span></button>';
      }).join("");
      if (q.length >= 3) {
        html += '<button type="button" class="sug street" data-geo="1">Hledat adresu nebo místo „' + esc(q) +
          '“<span class="zone">ulice, bazén, škola…</span></button>';
      }
      box.innerHTML = html || '<div class="sug none">Nic nenalezeno</div>';
      box.hidden = false;
    }
    function runGeo() {
      var q = inp.value.trim();
      if (q.length < 3 || geoBusy) return;
      geoBusy = true;
      box.innerHTML = '<div class="sug none">Hledám…</div>';
      box.hidden = false;
      geocode(q).then(function (list) {
        geoBusy = false;
        geo = list;
        box.innerHTML = list.length ? list.map(function (g, i) {
          return '<button type="button" class="sug" data-g="' + i + '">' + esc(g.name) +
            '<span class="zone">' + esc(g.sub) + "</span></button>";
        }).join("") : '<div class="sug none">Nenalezeno. Zkuste přidat obec, např. „' + esc(q) + ' Brno“.</div>';
      }).catch(function () {
        geoBusy = false;
        box.innerHTML = '<div class="sug none">Hledání adres teď není dostupné. Zkuste to za chvíli.</div>';
      });
    }
    function pick(b) {
      if (b.hasAttribute("data-geo")) { runGeo(); return; }
      var pl = null;
      if (b.hasAttribute("data-g")) {
        var g = geo[+b.getAttribute("data-g")];
        if (g) pl = { k: "p", n: g.name + (g.sub ? ", " + g.sub.split(", ").slice(-1)[0] : ""), la: g.lat, lo: g.lon };
      } else {
        var s = Core.stop(+b.getAttribute("data-i"));
        pl = { k: "s", id: s[0], n: s[1] };
      }
      if (!pl) return;
      close();
      inp.blur();
      inp.value = pl.n;
      setPlace(slot, pl);
    }
    inp.addEventListener("input", show);
    inp.addEventListener("focus", function () { inp.select(); show(); });
    inp.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      var first = box.querySelector(".sug[data-i], .sug[data-g]");
      if (first) pick(first); else runGeo();
    });
    inp.addEventListener("blur", function () {
      setTimeout(function () {
        close();
        if (!inp.value.trim()) { if (getPlace(slot)) setPlace(slot, null); }
        else { var pl = getPlace(slot); inp.value = pl ? pl.n : ""; }
      }, 200);
    });
    box.addEventListener("pointerdown", function (ev) {
      var b = ev.target.closest("button.sug");
      if (!b) return;
      ev.preventDefault();
      pick(b);
    });
  }

  // ---- 11.5 Formular ----
  function placeField(slot, label, gps) {
    var pl = getPlace(slot);
    return '<div class="field"><label>' + label + '</label><div class="withbtn">' +
      '<input class="pin" data-slot="' + slot + '" type="text" inputmode="search" enterkeyhint="search" autocomplete="off" ' +
      'autocapitalize="off" spellcheck="false" placeholder="Zastávka, ulice nebo místo" value="' + esc(pl ? pl.n : "") + '">' +
      (gps ? '<button type="button" class="iconbtn" id="pGps" aria-label="Moje poloha" title="Moje poloha">◎</button>' : "") +
      '</div><div class="sugs" hidden></div></div>';
  }
  function renderForm() {
    var h = [];
    h.push('<div class="pstep"><div class="phead">Start</div>' + placeField("start", "Odkud", true) +
      '<div class="prow"><label>Den <input id="pDate" type="date"></label>' +
      '<label>Nejdřív v <input id="pT0" type="time"></label></div></div>');
    P.stops.forEach(function (s, i) {
      h.push('<div class="pstep"><div class="phead">Zastavení ' + (i + 1) +
        '<button type="button" class="pdel" data-del="' + i + '" aria-label="Odebrat zastavení">✕</button></div>' +
        placeField("s" + i, "Kde", false) +
        '<div class="prow"><label>Pobyt <input type="number" min="0" max="720" step="5" data-stay="' + i + '" value="' + esc(s.stay) + '"> min</label>' +
        '<label class="chk"><input type="checkbox" data-stretch="' + i + '"' + (s.stretch ? " checked" : "") + '> co nejdéle (do času v cíli)</label></div></div>');
    });
    h.push('<button type="button" class="btn padd" id="pAdd">+ Přidat zastavení</button>');
    h.push('<div class="pstep"><div class="phead">Cíl</div>' + placeField("dest", "Kam", false) +
      '<div class="prow"><label>Nejpozději v <input id="pTn" type="time"></label>' +
      '<label>Rezerva <select id="pRez"><option value="0">0 min</option><option value="3">3 min</option>' +
      '<option value="5">5 min</option><option value="10">10 min</option><option value="15">15 min</option></select></label></div></div>');
    h.push('<div class="pactions"><button type="button" class="btn" id="pSwapAll">⇅ Cesta zpět</button>' +
      '<button type="button" class="btn danger" id="pClear">Vymazat plán</button></div>');
    $("planForm").innerHTML = h.join("");

    $("pDate").value = P.date;
    $("pDate").min = todayYmd();
    $("pT0").value = P.start.t;
    $("pTn").value = P.dest.t;
    $("pRez").value = String(P.rez);
    Array.prototype.forEach.call(document.querySelectorAll("#planForm .pin"), function (inp) {
      bindPicker(inp, inp.parentNode.parentNode.querySelector(".sugs"));
    });
    formReady = true;
  }

  function bindFormEvents() {
    var f = $("planForm");
    f.addEventListener("change", function (ev) {
      var el = ev.target;
      if (el.id === "pDate") P.date = el.value || todayYmd();
      else if (el.id === "pT0") P.start.t = el.value || "";
      else if (el.id === "pTn") P.dest.t = el.value || "";
      else if (el.id === "pRez") P.rez = +el.value || 0;
      else if (el.hasAttribute("data-stay")) {
        var s = P.stops[+el.getAttribute("data-stay")];
        if (s) s.stay = Math.max(0, Math.min(720, Math.round(+el.value || 0)));
      } else if (el.hasAttribute("data-stretch")) {
        var idx = +el.getAttribute("data-stretch");
        P.stops.forEach(function (s, i) { s.stretch = i === idx ? el.checked : false; });
        save(); renderForm(); schedule(); return;
      } else return;
      save(); schedule();
    });
    f.addEventListener("click", function (ev) {
      var b = ev.target.closest("button");
      if (!b) return;
      if (b.id === "pAdd") {
        P.stops.push({ pl: null, stay: 30, stretch: false });
        save(); renderForm(); schedule();
        var ins = f.querySelectorAll(".pin");
        if (ins.length > 1) ins[ins.length - 2].focus();
      } else if (b.hasAttribute("data-del")) {
        P.stops.splice(+b.getAttribute("data-del"), 1);
        save(); renderForm(); schedule();
      } else if (b.id === "pGps") {
        locate();
      } else if (b.id === "pSwapAll") {
        var a = P.start.pl; P.start.pl = P.dest.pl; P.dest.pl = a;
        P.stops.reverse();
        save(); renderForm(); schedule();
      } else if (b.id === "pClear") {
        P = defModel(); save(); renderForm(); schedule();
      }
    });
  }

  function locate() {
    if (!navigator.geolocation) { showMsg("Tento prohlížeč polohu neposkytuje."); return; }
    showMsg("Zjišťuji polohu…");
    navigator.geolocation.getCurrentPosition(function (pos) {
      setPlace("start", { k: "p", n: "Moje poloha", la: +pos.coords.latitude.toFixed(5), lo: +pos.coords.longitude.toFixed(5) });
    }, function (err) {
      showMsg(err && err.code === 1 ? "Poloha není povolená. Povolte ji pro tuto stránku v nastavení prohlížeče."
        : "Polohu se nepodařilo zjistit. Zadejte místo ručně.");
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }
  function showMsg(t) { $("planOut").innerHTML = '<p class="pinfo">' + esc(t) + "</p>"; }

  // ---- 11.6 Vypocet a vystup ----
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 120);
  }
  function run() {
    timer = null;
    if ($("viewPlan").hidden) return;
    if (!Core.data()) { showMsg("Načítám jízdní řád…"); return; }
    var res;
    try {
      var o = settings(); o.now = new Date();
      res = Planner.compute(P, o);
    } catch (e) {
      res = { error: "Plán se nepodařilo spočítat (" + e.message + ")." };
    }
    renderOut(res);
  }

  function walkLi(text) { return '<li class="walk"><span class="tt"></span><div class="tc">' + text + "</div></li>"; }

  function legHtml(res, L) {
    var h = [], net = res.net, D = Core.data();
    if (L.mode === "walk") return walkLi("pěšky " + L.walkMin + " min");
    if (L.startWalk > 0) h.push(walkLi("pěšky " + L.startWalk + " min na zastávku " + esc(D.stops[L.startIdx][1])));
    var prevArr = null, walked = 0;
    L.legs.forEach(function (g) {
      if (g.type === "walk") {
        walked += g.min;
        h.push(walkLi("přestup pěšky " + g.min + " min na zastávku " + esc(D.stops[g.to][1])));
        return;
      }
      var ri = Planner.rideInfo(net, g), warn = "";
      if (prevArr != null) {
        var wait = g.dep - prevArr - walked;
        if (wait <= Planner.PC.TIGHT_MIN) warn = '<span class="warn">⚠ napjatý přestup (' + Math.max(0, wait) + " min)</span>";
        else if (!walked) warn = '<small>přestup, čekání ' + wait + " min</small>";
      }
      h.push('<li class="ride"><span class="tt">' + T(g.dep) + '</span><div class="tc">' + warn +
        '<div class="rline">' + badge(ri) + " <b>" + esc(ri.fromName) + "</b>" + (ri.platform ? " · nást. " + esc(ri.platform) : "") + "</div>" +
        "<small>směr " + esc(ri.headsign) + " → vystoupit " + esc(ri.toName) + " v " + T(g.arr) + "</small></div></li>");
      prevArr = g.arr; walked = 0;
    });
    if (L.endWalk > 0) h.push(walkLi("pěšky " + L.endWalk + " min ze zastávky " + esc(D.stops[L.endIdx][1])));
    return h.join("");
  }

  function legSummary(res, L) {
    if (L.mode === "walk") return "pěšky " + L.walkMin + " min";
    var parts = [];
    L.legs.forEach(function (g) {
      if (g.type !== "ride") return;
      var ri = Planner.rideInfo(res.net, g);
      parts.push(badge(ri) + " " + esc(ri.fromName) + " " + T(g.dep));
    });
    return parts.join(" → ");
  }

  function renderOut(res) {
    var out = $("planOut");
    if (res.error) { out.innerHTML = '<p class="perr">' + esc(res.error) + "</p>"; return; }
    var n = res.places.length - 1, h = [], k = res.k;

    // shrnuti nahore
    var head = "", sub = [Planner.fmtDate(res.ymd)];
    if (k >= 0) {
      var stay = res.lv[k] - res.arr[k], want = res.stays[k];
      if (res.impossible) head = "Nestihnete to ani bez pobytu";
      else {
        head = "Na místě " + esc(Planner.placeName(res.places[k]).split(",")[0]) + " máte " + stay + " min";
        if (stay < want) sub.push("chtěl jste " + want + " min – chybí " + (want - stay) + " min");
        else sub.push("o " + (stay - want) + " min víc, než jste chtěl");
      }
    } else if (res.T0 == null) {
      head = "Vyrazte nejpozději v " + T(res.lv[0]);
    } else {
      head = "V cíli budete v " + T(res.arr[n]);
    }
    if (res.Tn != null) {
      var slack = res.Tn - res.arr[n];
      sub.push(slack >= 0 ? "v cíli " + T(res.arr[n]) + ", rezerva " + slack + " min" : "do cíle přijdete o " + (-slack) + " min pozdě");
    }
    h.push('<section class="psum' + ((res.impossible || (res.Tn != null && res.arr[n] > res.Tn)) ? " bad" : "") + '"><div class="htitle">' + head + '</div><div class="hsub">' + sub.join(" · ") + "</div></section>");
    res.notes.forEach(function (t) { h.push('<p class="pinfo">' + esc(t) + "</p>"); });

    // casova osa
    h.push('<ol class="tl">');
    for (var i = 0; i <= n; i++) {
      var name = esc(Planner.placeName(res.places[i]));
      if (i === 0) {
        var wait = res.T0 != null ? res.lv[0] - res.T0 : 0;
        h.push('<li class="place"><span class="tt">' + T(res.lv[0]) + '</span><div class="tc"><b>' + name + "</b><small>odchod" +
          (wait >= 3 ? " · času máte o " + wait + " min víc, než potřebujete" : "") + "</small></div></li>");
      } else if (i < n) {
        var st = res.lv[i] - res.arr[i], w = res.stays[i], note;
        if (i === k && res.impossible) note = '<span class="warn">bez pobytu – jen přestup</span>';
        else if (i === k) note = st < w ? '<span class="warn">chtěl jste ' + w + " min – chybí " + (w - st) + " min</span>"
          : '<span class="okk">vejde se (' + w + " min)</span>";
        else note = st > w ? "<small>včetně " + (st - w) + " min čekání na spoj</small>" : "";
        h.push('<li class="place"><span class="tt">' + T(res.arr[i]) + '</span><div class="tc"><b>' + name + "</b>" +
          "<small>příchod " + T(res.arr[i]) + " · pobyt <b>" + st + " min</b> · odchod " + T(res.lv[i]) + "</small>" + note + "</div></li>");
      } else {
        var info = "";
        if (res.Tn != null) {
          var s2 = res.Tn - res.arr[n];
          info = s2 >= 0 ? '<span class="okk">nejpozději ' + T(res.Tn) + " · rezerva " + s2 + " min ✓</span>"
            : '<span class="warn">o ' + (-s2) + " min později, než potřebujete (" + T(res.Tn) + ")</span>";
        }
        h.push('<li class="place pend"><span class="tt">' + T(res.arr[n]) + '</span><div class="tc"><b>' + name + "</b><small>příchod</small>" + info + "</div></li>");
      }
      if (i < n) h.push(legHtml(res, res.legs[i]));
    }
    h.push("</ol>");

    // zalozni spoje
    if (res.alts.length) {
      h.push('<section class="palts"><h3>Když se zdržíte – odchod z místa ' +
        esc(Planner.placeName(res.places[res.altLeg]).split(",")[0]) + "</h3><ul>");
      res.alts.forEach(function (a) {
        var s3 = res.Tn - a.arrive;
        h.push("<li><b>" + T(a.leave) + "</b> → v cíli " + T(a.arrive) + ' <span class="' + (s3 <= 1 ? "warn" : "muted") + '">(' +
          (s3 > 0 ? "rezerva " + s3 + " min" : "na minutu přesně") + ")</span><small>" + legSummary(res, a) + "</small></li>");
      });
      h.push("</ul></section>");
    }
    h.push('<p class="pinfo">Časy jsou podle jízdního řádu, pěší úseky jsou odhad podle vzdálenosti.</p>');
    out.innerHTML = h.join("");
  }

  // ---- 11.7 Zalozky ----
  function showTab(t) {
    var plan = t === "plan";
    $("viewDep").hidden = plan;
    $("viewPlan").hidden = !plan;
    $("tabDep").classList.toggle("on", !plan);
    $("tabPlan").classList.toggle("on", plan);
    $("tabDep").setAttribute("aria-selected", plan ? "false" : "true");
    $("tabPlan").setAttribute("aria-selected", plan ? "true" : "false");
    if (plan) { if (!formReady) renderForm(); schedule(); }
    try { history.replaceState(null, "", plan ? "#plan" : location.pathname + location.search); } catch (e) { }
  }

  function init() {
    load();
    bindFormEvents();
    $("tabDep").addEventListener("click", function () { showTab("dep"); });
    $("tabPlan").addEventListener("click", function () { showTab("plan"); });
    window.addEventListener("hashchange", function () { showTab(location.hash === "#plan" ? "plan" : "dep"); });
    document.addEventListener("odjezdy:data", function () { if (formReady) renderForm(); schedule(); });
    ["setSpeed", "setRadius"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("change", function () { setTimeout(schedule, 0); });
    });
    showTab(location.hash === "#plan" ? "plan" : "dep");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

/*
 * West Yorkshire address finder: one search box, suggestions as you type.
 * Respondents can type a street ("manor dr"), a number and street ("12 manor drive"),
 * a house name and street, or a postcode ("LS6 1DE"). No dependencies, and nothing typed
 * is sent to a third party: the widget fetches small static files and searches them locally.
 *
 *   WYLookup.mount(element, {
 *     dataUrl: "https://your-host/data",     // our own West Yorkshire data (always used as the backup)
 *     idealKey: "ak_...",                    // optional: Ideal Postcodes key; when set, Ideal is tried first
 *     onChange: function (result) {}
 *   });
 *
 * If Ideal Postcodes fails for any reason (bad key, no credit, daily or per-IP limit, timeout,
 * network or server error) the widget switches to our own data for the rest of that respondent's
 * session, without the respondent noticing. If Ideal finds nothing for a search, our data is tried too.
 *
 * result = { postcode, line1, line2, locality, town, district, ward, lat, lon, uprn, udprn,
 *            source: "ideal" | "local" | "manual", fallback_reason, complete: true|false }
 * fallback_reason is "" while Ideal is working, otherwise the Ideal error code (e.g. 4021) or
 * "timeout"/"network", so you can see how often the backup was used.
 */
(function (global) {
  "use strict";

  var ABBR = { rd: "road", st: "street", la: "lane", ave: "avenue", av: "avenue", dr: "drive", ln: "lane", cres: "crescent",
    cr: "crescent", gr: "grove", gro: "grove", cl: "close", ct: "court", ter: "terrace", terr: "terrace", tce: "terrace",
    pl: "place", gdns: "gardens", gdn: "gardens", sq: "square", mt: "mount", wk: "walk", pk: "park", grn: "green",
    vw: "view", app: "approach", ri: "rise" };
  var UNIT = { flat: 1, apartment: 1, apt: 1, unit: 1, room: 1 };
  var FULL_PC = /^([A-Z]{1,2}[0-9][A-Z0-9]?)\s*([0-9][A-Z]{2})$/;
  var PART_PC = /^[A-Z]{1,2}[0-9][A-Z0-9]?(\s*[0-9][A-Z]?)?$/;
  var MAX = 8;
  var GENERIC = { road: 1, street: 1, lane: 1, avenue: 1, drive: 1, close: 1, court: 1, crescent: 1, grove: 1,
    terrace: 1, place: 1, way: 1, gardens: 1, view: 1, walk: 1, mount: 1, rise: 1, square: 1, the: 1 };

  // ---------- helpers ----------
  var cache = {};
  function getJSON(url) {
    if (!cache[url]) {
      cache[url] = fetch(url).then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).catch(function (e) { delete cache[url]; throw e; });
    }
    return cache[url];
  }
  function words(s) {
    return (s || "").toLowerCase().replace(/['’.]/g, "").replace(/\bsaint\b/g, "st").split(/[^a-z0-9]+/).filter(Boolean);
  }
  function normPC(s) {
    var m = (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").match(/^([A-Z]{1,2}[0-9][A-Z0-9]?)([0-9][A-Z]{2})$/);
    return m ? m[1] + " " + m[2] : null;
  }
  function natCmp(a, b) {
    var x = a.split(/(\d+)/), y = b.split(/(\d+)/);
    for (var i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] === y[i]) continue;
      var nx = +x[i], ny = +y[i];
      if (!isNaN(nx) && !isNaN(ny) && x[i] !== "" && y[i] !== "") return nx - ny;
      return x[i] < y[i] ? -1 : 1;
    }
    return x.length - y.length;
  }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "class") n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function containsSeq(hay, needle) {           // is word list `needle` a run inside `hay`?
    outer: for (var i = 0; i + needle.length <= hay.length; i++) {
      for (var j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  }

  var CSS =
    ".wyl{font:inherit;max-width:34rem}.wyl label{display:block;font-weight:600;margin:.75rem 0 .3rem}" +
    ".wyl input{width:100%;box-sizing:border-box;font:inherit;padding:.6rem .7rem;border:1px solid #8a8f98;border-radius:6px;background:var(--wyl-field,#fff);color:var(--wyl-ink,#111)}" +
    ".wyl .hint{font-size:.9em;opacity:.75;margin:.35rem 0 0}" +
    ".wyl ul{list-style:none;margin:.35rem 0 0;padding:0;border:1px solid #8a8f98;border-radius:6px;overflow:hidden;background:var(--wyl-field,#fff);color:var(--wyl-ink,#111)}" +
    ".wyl li{padding:.55rem .7rem;cursor:pointer;border-top:1px solid rgba(128,128,128,.25);line-height:1.3}.wyl li:first-child{border-top:0}" +
    ".wyl li[aria-selected=true],.wyl li:hover{background:var(--wyl-chosen,#eef2ff)}" +
    ".wyl li .s{display:block;font-size:.85em;opacity:.75}.wyl li.act{color:var(--wyl-link,#1d4ed8);font-weight:600}" +
    ".wyl .link{font:inherit;background:none;border:none;color:var(--wyl-link,#1d4ed8);padding:.5rem 0;text-decoration:underline;cursor:pointer}" +
    ".wyl .err{color:var(--wyl-error,#b91c1c)}.wyl [hidden]{display:none!important}" +
    ".wyl .chosen{margin-top:.75rem;padding:.6rem .75rem;border-radius:6px;background:var(--wyl-chosen,#eef2ff);color:var(--wyl-ink,#111);white-space:pre-line}";

  var uid = 0;

  function mount(root, opts) {
    opts = opts || {};
    if (typeof root === "string") root = document.querySelector(root);
    if (!document.getElementById("wyl-css")) document.head.appendChild(el("style", { id: "wyl-css", text: CSS }));
    var base = (opts.dataUrl || "data").replace(/\/$/, "");
    var id = "wyl" + (++uid);

    var input = el("input", { id: id + "-q", type: "text", role: "combobox", autocomplete: "off", spellcheck: "false",
      "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": id + "-list",
      placeholder: opts.placeholder || "e.g. 12 Manor Drive or LS6 1DE" });
    var hint = el("p", { class: "hint", "aria-live": "polite" });
    var list = el("ul", { id: id + "-list", role: "listbox", hidden: "" });
    var manualBtn = el("button", { type: "button", class: "link", text: "Enter my address manually" });
    var f = {
      house: el("input", { id: id + "-h", type: "text", autocomplete: "address-line1" }),
      street: el("input", { id: id + "-s", type: "text" }),
      line2: el("input", { id: id + "-l2", type: "text", autocomplete: "address-line2" }),
      town: el("input", { id: id + "-t", type: "text", autocomplete: "address-level2" }),
      pc: el("input", { id: id + "-p", type: "text", autocomplete: "postal-code", list: id + "-pcs" })
    };
    var pcList = el("datalist", { id: id + "-pcs" });
    var pcMsg = el("p", { class: "hint" });
    function field(lab, inp) { return [el("label", { for: inp.id, text: lab }), inp]; }
    var manual = el("div", { hidden: "" }, [].concat(
      field("House number or name", f.house), field("Street", f.street), field("Address line 2 (optional)", f.line2),
      field("Town or city", f.town), field("Postcode", f.pc), [pcList, pcMsg]));
    var chosen = el("div", { class: "chosen", hidden: "" });

    root.appendChild(el("div", { class: "wyl" }, [
      el("label", { for: input.id, text: opts.label || "Start typing your address or postcode" }),
      input, hint, list, manualBtn, manual, chosen]));

    var seq = 0, items = [], active = -1, pcInfo = null;
    var ideal = { on: !!opts.idealKey, reason: "", base: (opts.idealBase || "https://api.ideal-postcodes.co.uk/v1").replace(/\/$/, "") };

    // ---------- results ----------
    var last = null;
    function emit(r) {
      if (r) { r.uprn = r.uprn || ""; r.udprn = r.udprn || ""; r.fallback_reason = ideal.reason; }
      last = r;
      chosen.hidden = !(r && r.complete && r.source !== "manual");
      if (r && r.source !== "manual" && r.complete)
        chosen.textContent = [r.line1, r.line2, r.locality, r.town, r.postcode].filter(Boolean).join("\n");
      if (opts.onChange) opts.onChange(r);
    }
    function fromAddr(a) {
      return { postcode: a.pc, line1: a.r[0], line2: a.r[1], locality: a.r[2], town: a.r[3], district: a.info.d,
        ward: a.info.w, lat: a.info.lat, lon: a.info.lon, source: "local", complete: true };
    }

    // ---------- list rendering ----------
    function show(newItems, msg, isErr) {
      items = newItems; active = -1;
      list.innerHTML = "";
      items.forEach(function (it, i) {
        var li = el("li", { role: "option", id: id + "-o" + i, "aria-selected": "false", class: it.cls || "" },
          [document.createTextNode(it.main), it.sub ? el("span", { class: "s", text: it.sub }) : null]);
        li.addEventListener("mousedown", function (e) { e.preventDefault(); });
        li.addEventListener("click", function () { choose(i); });
        list.appendChild(li);
      });
      list.hidden = !items.length;
      input.setAttribute("aria-expanded", items.length ? "true" : "false");
      input.removeAttribute("aria-activedescendant");
      hint.textContent = msg || "";
      hint.className = "hint" + (isErr ? " err" : "");
    }
    function setActive(i) {
      if (!items.length) return;
      active = (i + items.length) % items.length;
      Array.prototype.forEach.call(list.children, function (li, j) { li.setAttribute("aria-selected", j === active ? "true" : "false"); });
      input.setAttribute("aria-activedescendant", id + "-o" + active);
      list.children[active].scrollIntoView({ block: "nearest" });
    }
    function choose(i) { var it = items[i]; if (it) it.go(); }

    function addrItem(a) {
      var sub = [a.r[1], a.r[2], a.r[3]].filter(Boolean).join(", ") + " " + a.pc;
      return { main: a.r[0], sub: sub, go: function () {
        input.value = [a.r[0], a.r[1], a.r[3], a.pc].filter(Boolean).join(", ");
        show([], ""); manual.hidden = true; emit(fromAddr(a));
      } };
    }
    function streetItem(s) {
      var where = [s.place, s.district].filter(Boolean).join(", ") + " " + s.oc;
      var n = s.known ? "" : " · no addresses listed";
      return { main: s.name, sub: where + n, go: function () { openStreet(s); } };
    }

    // ---------- data access ----------
    function streetsFor(letter) {
      return getJSON(base + "/st/" + (/[a-z]/.test(letter) ? letter : "0") + ".json").then(function (rows) {
        return (rows || []).map(function (r) {
          return { name: r[0], place: r[1], district: r[2], oc: r[3],
            pcs: r[4].split(" ").map(function (x) { return r[3] + " " + x; }), known: r[5],
            nw: words(r[0]), aw: words(r[0] + " " + r[1] + " " + r[2] + " " + r[3] + " " + (r[6] || "")) };
        });
      });
    }
    function addressesOn(s) {     // addresses listed on street s, with their postcode info
      return getJSON(base + "/pc/" + s.oc + ".json").then(function (shard) {
        var out = [];
        s.pcs.slice(0, s.known || s.pcs.length).forEach(function (pc) {
          var info = shard && shard[pc];
          if (!info) return;
          info.a.forEach(function (r) {
            if (containsSeq(words(r[0] + " " + r[1]), s.nw)) out.push({ pc: pc, r: r, info: info });
          });
        });
        out.sort(function (x, y) { return natCmp(x.r[0], y.r[0]); });
        return out;
      });
    }

    function matchStreets(rows, toks) {
      var res = [];
      rows.forEach(function (s) {
        var score = 0;
        for (var i = 0; i < toks.length; i++) {
          var t = toks[i], full = ABBR[t], last = i === toks.length - 1, hit = -1;
          for (var j = 0; j < s.aw.length; j++) {
            var w = s.aw[j];
            if (w === t || w === full || w.indexOf(t) === 0) { hit = j; if (w !== t && w !== full && !last) score -= 0.5; break; }
          }
          if (hit < 0) return;
          if (i === 0 && hit >= s.nw.length) return;      // the first word must be in the street name itself
          score += hit < s.nw.length ? 2 : 1;
        }
        if (s.nw[0] && s.nw[0].indexOf(toks[0]) === 0) score += 3;
        if (s.known) score += 1;
        score -= s.nw.length * 0.1;
        res.push({ s: s, score: score });
      });
      res.sort(function (a, b) { return b.score - a.score || a.s.name.localeCompare(b.s.name); });
      return res.map(function (x) { return x.s; });
    }

    function parse(q) {
      var toks = words(q);
      // Leading house tokens: numbers, and "flat 3" style units
      var house = [], i = 0;
      while (i < toks.length) {
        if (/\d/.test(toks[i])) { house.push(toks[i]); i++; }
        else if (UNIT[toks[i]] && i + 1 < toks.length && /\d/.test(toks[i + 1])) { house.push(toks[i], toks[i + 1]); i += 2; }
        else break;
      }
      return { house: house, rest: toks.slice(i) };
    }

    function houseMatch(a, house) {
      if (!house.length) return true;
      var w = words(a.r[0]);
      return house.every(function (t) {
        return /\d/.test(t) ? w.indexOf(t) >= 0 : w.some(function (x) { return x.indexOf(t) === 0; });
      });
    }

    // ---------- search ----------
    function search() {
      var my = ++seq, q = input.value.trim();
      manual.hidden = true; emit(null);
      if (q.length < 2) return show([], "");
      if (ideal.on) return idealSearch(q, my);
      localSearch(q, my);
    }

    // ---------- Ideal Postcodes (primary when a key is given) ----------
    function idealGet(path, params) {
      var url = ideal.base + path + "?api_key=" + encodeURIComponent(opts.idealKey);
      for (var k in params || {}) url += "&" + k + "=" + encodeURIComponent(params[k]);
      var ctl = global.AbortController ? new AbortController() : null;
      var t = setTimeout(function () { if (ctl) ctl.abort(); }, opts.idealTimeout || 4000);
      return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) {
        clearTimeout(t);
        return r.json().catch(function () { return {}; }).then(function (b) {
          if (!r.ok || (b.code && b.code !== 2000)) {
            var e = new Error("Ideal Postcodes error"); e.code = b.code || r.status; throw e;
          }
          return b.result;
        });
      }, function (e) {
        clearTimeout(t);
        var err = new Error("Ideal Postcodes unreachable"); err.code = e && e.name === "AbortError" ? "timeout" : "network"; throw err;
      });
    }
    function idealDown(e, my) {
      ideal.on = false;
      ideal.reason = String((e && e.code) || "error");
      if (opts.onFallback) opts.onFallback(ideal.reason);
      if (my === seq) localSearch(input.value.trim(), my);
    }
    function idealSearch(q, my) {
      if (q.length < 3) return show([], "");
      var params = { query: q, limit: MAX };
      var extra = opts.idealParams || { bias_lonlat: "-1.65,53.74,25000" };   // favour West Yorkshire
      for (var k in extra) params[k] = extra[k];
      idealGet("/autocomplete/addresses", params).then(function (res) {
        if (my !== seq) return;
        var hits = (res && res.hits) || [];
        if (!hits.length) return localSearch(q, my);
        var its = hits.map(function (h) { return { main: h.suggestion, go: function () { idealResolve(h); } }; });
        its.push(manualItem({}));
        show(its, "");
      }).catch(function (e) { idealDown(e, my); });
    }
    function idealResolve(h) {
      var my = ++seq;
      show([], "Getting your address\u2026");
      idealGet("/autocomplete/addresses/" + encodeURIComponent(h.id) + "/gbr").then(function (a) {
        if (my !== seq) return;
        var pc = a.postcode || "";
        // Use our own district and ward coding where we have it, so answers from both sources match
        return getJSON(base + "/pc/" + pc.split(" ")[0] + ".json").catch(function () { return null; }).then(function (shard) {
          if (my !== seq) return;
          var info = shard && shard[pc];
          var line2 = [a.line_2, a.line_3].filter(Boolean).join(", ");
          var loc = a.dependant_locality || "";
          if (loc && (a.line_1 + " " + line2).indexOf(loc) >= 0) loc = "";
          input.value = [a.line_1, line2, a.post_town, pc].filter(Boolean).join(", ");
          show([], ""); manual.hidden = true;
          emit({ postcode: pc, line1: a.line_1 || "", line2: line2, locality: loc, town: a.post_town || "",
            district: info ? info.d : (a.district || ""), ward: info ? info.w : (a.ward || ""),
            lat: a.latitude || (info ? info.lat : ""), lon: a.longitude || (info ? info.lon : ""),
            uprn: a.uprn ? String(a.uprn) : "", udprn: a.udprn ? String(a.udprn) : "", source: "ideal", complete: true });
        });
      }).catch(function (e) { idealDown(e, my); });
    }

    // ---------- our own data (backup) ----------
    function localSearch(q, my) {
      var up = q.toUpperCase();

      var pcm = up.replace(/\s+/g, " ").match(FULL_PC);
      if (pcm) return searchPostcode(pcm[1] + " " + pcm[2], my);
      if (PART_PC.test(up) && /\d/.test(up)) return show([], "Keep typing your full postcode.");

      var p = parse(q);
      if (!p.rest.length || p.rest[0].length < 2) return show([], p.house.length ? "Now type your street name." : "");

      // Try "street" first; if nothing matches, treat leading words as a house name ("rose cottage manor dr")
      var splits = [];
      var maxK = p.house.length ? 1 : 3;     // house names are only tried when no number was typed
      for (var k = 0; k < p.rest.length && k < maxK; k++) {
        var first = p.rest[k];
        if (first.length < 2 || (k > 0 && (GENERIC[first] || GENERIC[ABBR[first]]))) continue;
        splits.push({ house: p.house.concat(p.rest.slice(0, k)), toks: p.rest.slice(k) });
      }
      (function trySplit(n) {
        if (n >= splits.length) { if (my === seq) show([], "No matching streets in West Yorkshire. Check the spelling, try your postcode, or enter your address manually.", true); return; }
        var sp = splits[n];
        streetsFor(sp.toks[0][0]).then(function (rows) {
          if (my !== seq) return;
          var found = matchStreets(rows, sp.toks);
          if (!found.length) return trySplit(n + 1);
          if (!sp.house.length || found.length > 10) {
            var eg = found[0].place || found[0].district;
            var tip = found.length > MAX || sp.house.length
              ? "There are " + found.length + " matching streets. Add your area to narrow them down, e.g. \u201c" + q + " " + eg.toLowerCase() + "\u201d."
              : "";
            return show(found.slice(0, MAX).map(streetItem), tip);
          }
          // Number given and few streets: look up the actual addresses
          Promise.all(found.slice(0, 10).map(addressesOn)).then(function (lists) {
            if (my !== seq) return;
            var hits = [];
            lists.forEach(function (l) { l.forEach(function (a) { if (houseMatch(a, sp.house)) hits.push(a); }); });
            var lead = sp.house.join(" ");
            hits.sort(function (x, y) { return (words(x.r[0]).join(" ").indexOf(lead) === 0 ? 0 : 1) - (words(y.r[0]).join(" ").indexOf(lead) === 0 ? 0 : 1); });
            var its = hits.slice(0, MAX).map(addrItem);
            found.slice(0, Math.max(1, MAX - its.length)).forEach(function (s) {
              var it = streetItem(s); it.main = "All addresses on " + s.name; its.push(it);
            });
            show(its, hits.length ? "" : "We couldn't find that address. Choose your street to see all listed addresses, or add it manually from there.");
          }).catch(fail);
        }).catch(fail);
      })(0);
    }

    function searchPostcode(pc, my) {
      getJSON(base + "/pc/" + pc.split(" ")[0] + ".json").then(function (shard) {
        if (my !== seq) return;
        var info = shard && shard[pc];
        if (!info) return show([manualItem({ pc: pc })], pc + " isn't a current West Yorkshire postcode. Please check it.", true);
        var its = info.a.map(function (r) { return addrItem({ pc: pc, r: r, info: info }); });
        its.sort(function (a, b) { return natCmp(a.main, b.main); });
        its.push(manualItem({ pc: pc, info: info }));
        show(its, info.a.length ? info.a.length + " addresses at " + pc + "." : "No addresses are listed for " + pc + ". Please enter yours manually.");
      }).catch(fail);
    }

    function openStreet(s) {
      var my = ++seq;
      input.value = s.name + ", " + [s.place, s.district].filter(Boolean).join(", ");
      addressesOn(s).then(function (addrs) {
        if (my !== seq) return;
        var its = addrs.map(addrItem);
        its.push(manualItem({ street: s }));
        show(its, addrs.length ? addrs.length + " addresses listed on " + s.name + ". Choose yours." : "No addresses are listed on " + s.name + " yet. Please enter yours.");
        if (!addrs.length) choose(0);
        else input.focus();
      }).catch(fail);
    }

    function fail() { show([manualItem({})], "Sorry, the address search isn't available right now. Please enter your address manually.", true); }

    // ---------- manual entry ----------
    function manualItem(ctx) {
      var label = ctx.street ? "My address on " + ctx.street.name + " isn't listed" : "Enter my address manually";
      return { main: label, cls: "act", go: function () { openManual(ctx); } };
    }
    function openManual(ctx) {
      ctx = ctx || {};
      show([], ""); manual.hidden = false;
      pcList.innerHTML = "";
      if (ctx.street) {
        f.street.value = ctx.street.name;
        f.town.value = ctx.street.place || ctx.street.district;
        ctx.street.pcs.forEach(function (p) { pcList.appendChild(el("option", { value: p })); });
        if (ctx.street.pcs.length === 1) f.pc.value = ctx.street.pcs[0];
      }
      if (ctx.pc) f.pc.value = ctx.pc;
      (f.house.value ? f.street : f.house).focus();
      checkPC();
    }
    function manualChanged() {
      var pc = normPC(f.pc.value), h = f.house.value.trim(), st = f.street.value.trim();
      var line1 = /^\d+[a-z]?$/i.test(h) && st ? h + " " + st : [h, st].filter(Boolean).join(", ");
      var i = pcInfo && pcInfo.pc === pc ? pcInfo.info : null;
      emit({ postcode: pc || f.pc.value.trim().toUpperCase(), line1: line1, line2: f.line2.value.trim(), locality: "",
        town: f.town.value.trim(), district: i ? i.d : "", ward: i ? i.w : "", lat: i ? i.lat : "", lon: i ? i.lon : "",
        source: "manual", complete: !!(h && f.town.value.trim() && pc) });
    }
    function checkPC() {
      var pc = normPC(f.pc.value);
      pcMsg.textContent = ""; pcMsg.className = "hint";
      if (!pc) { pcInfo = null; return manualChanged(); }
      getJSON(base + "/pc/" + pc.split(" ")[0] + ".json").then(function (shard) {
        var info = shard && shard[pc];
        pcInfo = info ? { pc: pc, info: info } : null;
        if (!info) { pcMsg.textContent = pc + " isn't a current West Yorkshire postcode."; pcMsg.className = "hint err"; }
        manualChanged();
      }).catch(function () { pcInfo = null; manualChanged(); });
    }
    [f.house, f.street, f.line2, f.town].forEach(function (x) { x.addEventListener("input", manualChanged); });
    f.pc.addEventListener("input", checkPC);
    manualBtn.addEventListener("click", function () { openManual({}); });

    // ---------- events ----------
    var timer;
    input.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(search, 120); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
      else if (e.key === "Enter") { e.preventDefault(); if (active >= 0) choose(active); else if (items.length === 1) choose(0); }
      else if (e.key === "Escape") { show([], hint.textContent); }
    });

    return { get: function () { return last; } };
  }

  global.WYLookup = { mount: mount, normalise: normPC };
})(window);

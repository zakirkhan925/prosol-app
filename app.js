/* Prosol Foods — front end (Phase 1). Vanilla JS, no build step.
 * Works when served by Apps Script (google.script.run) and when hosted statically (fetch to the web-app URL).
 * The browser holds no secrets: only the user's own session token. All checks are repeated on the server. */
(function () {
  'use strict';

  // ---------- transport ----------
  var CONFIG = window.PROSOL_CONFIG || {};
  var hasGsr = !!(window.google && google.script && google.script.run);
  // Hosted site: never run inside another site's frame (protects against click-jacking of the sign-in and delivery screens).
  if (!hasGsr && window.top !== window.self) { document.body.textContent = 'Open Prosol Foods directly at ' + location.origin; return; }
  var NET_MSG = 'Could not reach the server. Check your internet connection and try again.';

  /** One request to the server. Rejects with code NETWORK when the server could not be reached (the request may or may not have arrived —
   *  every action that can be queued is idempotent on its ClientUUID, so sending it again is always safe). */
  function rawCall(action, payload, timeoutMs) {
    var req = { action: action, payload: payload || {}, token: State.token, userAgent: navigator.userAgent.substring(0, 180) };
    var p;
    if (hasGsr) {
      p = new Promise(function (resolve, reject) {
        google.script.run.withSuccessHandler(resolve).withFailureHandler(function (e) { reject({ message: NET_MSG, code: 'NETWORK', detail: String(e) }); }).api(req);
      });
    } else {
      if (navigator.onLine === false) return Promise.reject({ message: NET_MSG, code: 'NETWORK' });
      var ctl = window.AbortController ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 30000) : null;
      p = fetch(CONFIG.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(req), redirect: 'follow', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
        .then(function (r) { return r.json(); })
        .then(function (x) { clearTimeout(timer); return x; }, function () { clearTimeout(timer); throw { message: NET_MSG, code: 'NETWORK' }; });
    }
    return p.then(function (res) {
      if (res && res.ok) return res.data;
      var e = (res && res.error) || { message: 'Unexpected response from server.', code: 'SERVER' };
      if (e.code === 'SESSION') { Local.forgetBoot(); State.clear(); render(); }
      if (e.code === 'PASSWORD_CHANGE_REQUIRED') { State.me && (State.me.mustChangePassword = true); render(); }
      throw e;
    });
  }

  /**
   * Every screen calls the server through API.call. Online it is a normal request. Without signal:
   *  - field actions (new order, visit, shop GPS, delivery, not-delivered, return, start trip) are checked on the phone,
   *    saved in the outbox and sent automatically later (exactly once — the server de-duplicates on ClientUUID);
   *  - screens are answered from the offline pack (own customers, products, own trips) or from the last copy seen online.
   */
  var renderSeq = 0; // increases on every screen change
  // ---------- instant screens ----------
  // A screen seen before opens at once from the copy kept on this device, and fresh data is fetched in the background; the
  // screen is repainted only if something changed and only while the user is not typing or in a dialog. After any change the
  // user makes (save, approve, deliver...), older copies are not shown any more: the next screen waits for fresh data.
  var SWR = { 'dashboard.summary': 1, 'customers.list': 1, 'customers.get': 1, 'customers.areas': 1, 'salespersons.options': 1, 'salespersons.list': 1,
    'products.list': 1, 'products.get': 1, 'categories.list': 1, 'territories.list': 1, 'orders.list': 1, 'orders.get': 1, 'visits.list': 1,
    'delivery.trips': 1, 'delivery.ready': 1, 'returns.list': 1, 'qb.status': 1, 'qb.queue': 1, 'settings.list': 1, 'users.list': 1, 'roles.list': 1,
    'fleet.drivers': 1, 'fleet.vehicles': 1, 'commission.rules': 1, 'commission.dashboard': 1 };
  var SWR_REFRESH_MS = 8000, lastWriteAt = 0, swrInflight = {}, uiTouched = false;
  function isWriteAction(a) {
    return a !== 'reports.run' && /\.(save\w*|create\w*|submit|approve|returnToDraft|cancel\w*|closeShort|captureLocation|set\w+|end\w+|decide\w*|pay|close\w*|backfill|retry|generateKey|run|start\w*|finish\w*|confirm|fail|update\w*|review\w*|reset\w*|import\w*|logout|changePassword)$/.test(a);
  }
  function uiBusy() { return uiTouched || !!document.querySelector('.modal'); }
  document.addEventListener('input', function () { uiTouched = true; }, true);
  document.addEventListener('change', function () { uiTouched = true; }, true);

  var API = {
    /** Screen data that arrives after the user has moved on to another screen is dropped, so a slow answer never paints over the newer screen. */
    call: function (action, payload) {
      var seq = renderSeq;
      if (SWR[action] && Local.uid && !Net.down()) {
        var k = stableKey(action, payload || {}), c = Local.cache[k];
        if (c && c.t && c.t > lastWriteAt) {
          if (Date.now() - c.t > SWR_REFRESH_MS && !swrInflight[k]) {
            swrInflight[k] = 1;
            API.send(action, payload).then(function (d) {
              delete swrInflight[k];
              if (seq === renderSeq && !uiBusy() && JSON.stringify(d) !== JSON.stringify(Offline.overlay(action, payload, clone(c.data)))) render({ keepScroll: true });
            }, function () { delete swrInflight[k]; });
          }
          return Promise.resolve(Offline.overlay(action, payload, clone(c.data)));
        }
      }
      var p = API.send(action, payload);
      if (!Offline.isRead(action) || action === 'auth.me') return p;
      var stale = function () { return seq !== renderSeq; };
      return p.then(function (d) { return stale() ? new Promise(function () {}) : d; }, function (e) { if (stale()) return new Promise(function () {}); throw e; });
    },
    send: function (action, payload) {
      var r = Local.resolveIds(payload || {});
      payload = r.payload;
      var q = Offline.queueable(action, payload);
      if (r.unsent) {
        if (q) return Offline.enqueue(action, payload); // e.g. an order linked to a visit that is still in the outbox: it must go after it
        return Promise.reject({ code: 'NOT_SENT', message: 'This item is still on this phone and has not been sent yet.' });
      }
      if (q && Net.down()) return Offline.enqueue(action, payload);
      if (!q && Net.down() && Offline.packFirst(action)) { var fast = Offline.read(action, payload); if (fast) { Net.probeSoon(); return fast; } }
      if (isWriteAction(action)) lastWriteAt = Date.now();
      return rawCall(action, payload, q ? 45000 : (Net.down() ? 8000 : 25000)).then(function (data) {
        Net.up();
        if (isWriteAction(action)) lastWriteAt = Date.now();
        Offline.afterOnline(action, payload, data, !!q);
        return Offline.overlay(action, payload, data);
      }, function (e) {
        if (e.code !== 'NETWORK') throw e;
        Net.lost();
        if (q) return Offline.enqueue(action, payload);
        var off = Offline.read(action, payload);
        if (off) return off;
        throw { code: 'OFFLINE', message: Offline.isRead(action) ? 'You are offline and this screen has not been saved on this phone yet. It opens once you have internet.'
          : 'You are offline. This needs an internet connection — try again when you have signal.' };
      });
    }
  };

  // ---------- state ----------
  var State = {
    token: safeGet('prosol.token'), me: null, settings: {},
    save: function (t) { this.token = t; safeSet('prosol.token', t); },
    clear: function () { this.token = null; this.me = null; safeSet('prosol.token', null); }
  };
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  function can(p) { var ps = (State.me && State.me.permissions) || []; if (ps.indexOf('*') >= 0) return true; return [].concat(p).some(function (x) { return ps.indexOf(x) >= 0; }); }


  // =====================================================================================================
  // ---------- offline: storage on the phone (IndexedDB) ----------
  // kv:     'boot' (last signed-in profile, for opening the app without signal), 'u:<user>:pack|cache|idmap|sent'
  // outbox: one record per action waiting to be sent, keyed by its ClientUUID
  // =====================================================================================================
  var Store = (function () {
    var dbp = null, mem = { kv: {}, outbox: {} };
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve) {
        try {
          if (!window.indexedDB) return resolve(null);
          var req = indexedDB.open('prosol-foods', 1);
          req.onupgradeneeded = function () {
            var db = req.result;
            if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
            if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
          };
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { resolve(null); };
          req.onblocked = function () { resolve(null); };
        } catch (e) { resolve(null); }
      }).then(function (db) { Store.durable = !!db; return db; });
      return dbp;
    }
    function run(store, mode, fn) {
      return open().then(function (db) {
        if (!db) return fn(null, mem[store]);
        return new Promise(function (resolve, reject) {
          var t = db.transaction(store, mode), out;
          var r = fn(t.objectStore(store));
          if (r) r.onsuccess = function () { out = r.result; };
          t.oncomplete = function () { resolve(out); }; // resolved only once the data is committed to disk
          t.onerror = t.onabort = function () { reject({ code: 'STORAGE', message: 'Could not save on this phone (' + ((t.error && t.error.name) || 'storage error') + '). Free some space and try again.' }); };
        });
      });
    }
    return {
      durable: false,
      open: open,
      get: function (store, key) { return run(store, 'readonly', function (s, m) { return s ? s.get(key) : null; }).then(function (v) { return v === undefined || v === null ? (Store.durable ? null : mem[store][key] || null) : v; }); },
      put: function (store, key, val) { return run(store, 'readwrite', function (s, m) { if (!s) { m[key] = val; return null; } return store === 'outbox' ? s.put(val) : s.put(val, key); }); },
      del: function (store, key) { return run(store, 'readwrite', function (s, m) { if (!s) { delete m[key]; return null; } return s.delete(key); }); },
      all: function (store) { return run(store, 'readonly', function (s, m) { return s ? s.getAll() : null; }).then(function (v) { return v || Object.keys(mem[store]).map(function (k) { return mem[store][k]; }); }); }
    };
  })();

  function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function stableKey(action, p) {
    var keys = Object.keys(p || {}).filter(function (k) { return p[k] !== '' && p[k] !== null && p[k] !== undefined; }).sort();
    return action + '|' + keys.map(function (k) { return k + '=' + JSON.stringify(p[k]); }).join('&');
  }
  function isLocalId(v) { return typeof v === 'string' && v.indexOf('local-') === 0; }

  /** Per-user data kept on the phone, mirrored in memory so screens can be answered instantly. */
  var Local = {
    uid: null, boot: null, pack: null, cache: {}, idmap: {}, sent: [], outbox: [],
    init: function () {
      if (Local.inited) return Local.inited;
      Local.inited = Store.get('kv', 'boot').then(function (b) { Local.boot = b; }).catch(function () {});
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* best effort */ }
      return Local.inited;
    },
    key: function (k) { return 'u:' + Local.uid + ':' + k; },
    loadUser: function (uid) {
      if (Local.uid === uid) return Promise.resolve();
      Local.uid = uid;
      return Promise.all([Store.get('kv', Local.key('pack')), Store.get('kv', Local.key('cache')), Store.get('kv', Local.key('idmap')),
        Store.get('kv', Local.key('sent')), Store.all('outbox')]).then(function (r) {
        Local.pack = r[0]; Local.cache = r[1] || {}; Local.idmap = r[2] || {}; Local.sent = r[3] || [];
        Local.outbox = (r[4] || []).sort(function (a, b) { return a.seq - b.seq; });
      }).catch(function () {});
    },
    saveBoot: function (d) {
      if (!State.token || !d || !d.me) return;
      Local.boot = { tok: State.token.slice(-10), me: d.me, settings: d.settings || {}, at: new Date().toISOString() };
      Store.put('kv', 'boot', Local.boot).catch(function () {});
    },
    forgetBoot: function () { Local.boot = null; Store.del('kv', 'boot').catch(function () {}); },
    /** Signing out removes the copies of office data from the phone. Unsent work stays and is sent at the next sign-in of the same user. */
    clearUser: function () {
      Local.forgetBoot();
      if (!Local.uid) return;
      ['pack', 'cache'].forEach(function (k) { Store.del('kv', Local.key(k)).catch(function () {}); });
      Local.pack = null; Local.cache = {}; Local.uid = null;
    },
    save: function (k) { return Store.put('kv', Local.key(k), Local[k]).catch(function () {}); },
    saveCacheSoon: function () { clearTimeout(Local._ct); Local._ct = setTimeout(function () { Local.save('cache'); }, 1500); },
    /** Replaces local-… ids that the server has since given a real id. unsent = still refers to something waiting in the outbox. */
    resolveIds: function (p) {
      var out = {}, unsent = false;
      Object.keys(p).forEach(function (k) {
        var v = p[k];
        if (isLocalId(v)) { if (Local.idmap[v]) v = Local.idmap[v]; else unsent = true; }
        out[k] = v;
      });
      return { payload: out, unsent: unsent };
    }
  };

  // ---------- connection state ----------
  var Net = {
    isDown: navigator.onLine === false, timer: null,
    down: function () { return Net.isDown || navigator.onLine === false; },
    lost: function () { if (!Net.isDown) { Net.isDown = true; netbar(); } Net.probeSoon(); },
    up: function (quiet) { var was = Net.isDown; Net.isDown = false; if (was) { netbar(); if (!quiet) Sync.run(); } },
    probeSoon: function () { if (Net.timer) return; Net.timer = setTimeout(function () { Net.timer = null; Net.probe(); }, 20000); },
    probe: function () {
      if (!State.token || !State.me) return;
      if (navigator.onLine === false) { Net.isDown = true; netbar(); return Net.probeSoon(); }
      rawCall('auth.me', {}, 8000).then(function (d) { Local.saveBoot(d); Net.up(); }, function (e) { if (e.code === 'NETWORK') { Net.isDown = true; netbar(); Net.probeSoon(); } });
    }
  };
  window.addEventListener('online', function () { Net.probe(); });
  window.addEventListener('offline', function () { Net.lost(); });

  // ---------- offline pack (own customers, products, own open trips) ----------
  var Pack = {
    loading: null,
    data: function () { return Local.pack; },
    wanted: function () { var m = State.me; return !!(m && (m.salespersonId || m.driverId) && can('dashboard.view')); },
    salesCustomers: function () { var m = State.me; return !!(Local.pack && m && m.salespersonId && can('customers.view.own') && !can('customers.view.all')); },
    hasProducts: function () { return !!(Local.pack && Local.pack.products && Local.pack.products.length); },
    refresh: function () {
      if (!Pack.wanted() || Pack.loading || Net.down()) return Pack.loading || Promise.resolve();
      var uid = Local.uid;
      Pack.loading = rawCall('offline.pack', {}, 60000).then(function (d) {
        if (uid !== Local.uid) return;
        d.savedAt = new Date().toISOString(); Local.pack = d; Local.save('pack'); Net.up(true); netbar();
      }, function (e) { if (e.code === 'NETWORK') Net.lost(); }).then(function () { Pack.loading = null; });
      return Pack.loading;
    },
    customer: function (id) { return Local.pack && (Local.pack.customers || []).filter(function (c) { return c.CustomerID === id; })[0]; },
    product: function (id) { return Local.pack && (Local.pack.products || []).filter(function (p) { return p.ProductID === id; })[0]; },
    trip: function (id) { return Local.pack && (Local.pack.trips || []).filter(function (t) { return t.DeliveryID === id; })[0]; },
    findStop: function (stopId) {
      var trips = (Local.pack && Local.pack.trips) || [];
      for (var i = 0; i < trips.length; i++) { var s = trips[i].StopsList.filter(function (x) { return x.DeliveryOrderID === stopId; })[0]; if (s) return { trip: trips[i], stop: s }; }
      return null;
    },
    findLine: function (lineId) {
      var trips = (Local.pack && Local.pack.trips) || [];
      for (var i = 0; i < trips.length; i++) {
        var t = overlayTrip(trips[i]);
        for (var j = 0; j < t.StopsList.length; j++) { var l = t.StopsList[j].Lines.filter(function (x) { return x.OrderLineID === lineId; })[0]; if (l) return { trip: t, stop: t.StopsList[j], line: l }; }
      }
      return null;
    },
    putTrip: function (t) {
      if (!Local.pack || !t || !t.DeliveryID || !t.StopsList) return;
      var list = Local.pack.trips || (Local.pack.trips = []), i = list.map(function (x) { return x.DeliveryID; }).indexOf(t.DeliveryID);
      if (i >= 0) list[i] = clone(t); else if (t.IsMyTrip && (t.Status === 'PLANNED' || t.Status === 'OUT')) list.push(clone(t)); else return;
      Local.save('pack');
    },
    putCustomer: function (c) {
      var x = c && Pack.customer(c.CustomerID); if (!x) return;
      ['ShopName', 'ContactPerson', 'Mobile', 'WhatsApp', 'Address', 'Area', 'City', 'CreditLimit', 'PaymentTerms', 'Latitude', 'Longitude', 'GPSAccuracy',
        'LocationCapturedAt', 'QBBalance', 'QBBalanceAsOf', 'QBListID', 'Notes', 'Version', 'Active'].forEach(function (k) { if (c[k] !== undefined) x[k] = c[k]; });
      x.HasGPS = typeof x.Latitude === 'number';
      Local.save('pack');
    }
  };

  // ---------- outbox ----------
  var Outbox = {
    mine: function () { return Local.outbox.filter(function (i) { return i.userId === Local.uid; }); },
    pending: function (action) { return Outbox.mine().filter(function (i) { return (i.status === 'PENDING' || i.status === 'SENDING') && (!action || i.action === action); }); },
    failed: function () { return Outbox.mine().filter(function (i) { return i.status === 'FAILED'; }); },
    get: function (id) { return Local.outbox.filter(function (i) { return i.id === id; })[0]; },
    byLocalId: function (lid) { return Local.outbox.filter(function (i) { return i.localId === lid; })[0]; },
    add: function (item) { return Store.put('outbox', item.id, item).then(function () { Local.outbox.push(item); }); },
    save: function (item) { return Store.put('outbox', item.id, item).catch(function () {}); },
    remove: function (item) {
      return Store.del('outbox', item.id).then(function () { Local.outbox = Local.outbox.filter(function (i) { return i.id !== item.id; }); });
    },
    complete: function (item, data) {
      var serverId = data && (item.action === 'orders.save' ? data.OrderID : item.action === 'visits.create' ? data.VisitID : '');
      if (item.localId && serverId) { Local.idmap[item.localId] = serverId; Local.save('idmap'); }
      Local.sent.unshift({ id: item.id, action: item.action, label: item.label, sentAt: new Date().toISOString(), createdAt: item.createdAt,
        ref: (data && (data.OrderNo || data.ReturnNo || data.TripNo)) || '', serverId: serverId || (data && data.DeliveryID) || '', customerId: item.payload.CustomerID || '' });
      Local.sent = Local.sent.slice(0, 40); Local.save('sent');
      if (item.action.indexOf('delivery.') === 0) Pack.putTrip(data);
      if (item.action === 'customers.captureLocation') Pack.putCustomer(data);
      return Outbox.remove(item);
    }
  };

  // ---------- sending the outbox ----------
  var TRANSIENT = { BUSY: 1, SERVER: 1 };
  var Sync = {
    busy: null,
    run: function () {
      if (Sync.busy) return Sync.busy;
      if (!State.token || !State.me || State.me.mustChangePassword || !Local.uid) return Promise.resolve(0);
      var sent = 0, uid = Local.uid;
      var step = function () {
        if (uid !== Local.uid || !State.token) return Promise.resolve();
        var item = Outbox.pending()[0];
        if (!item) return Promise.resolve();
        var r = Local.resolveIds(item.payload), payload = r.payload;
        if (r.unsent) { // refers to an item that was rejected (anything earlier is sent first): send without that link
          Object.keys(payload).forEach(function (k) { if (isLocalId(payload[k])) payload[k] = ''; });
        }
        item.status = 'SENDING'; netbar();
        return rawCall(item.action, payload, 60000).then(function (data) {
          sent++; Net.up(true);
          return Outbox.complete(item, data).then(step);
        }, function (e) {
          item.status = 'PENDING';
          if (e.code === 'NETWORK') { Net.lost(); return Outbox.save(item); }
          if (e.code === 'SESSION' || e.code === 'PASSWORD_CHANGE_REQUIRED') return Outbox.save(item);
          item.attempts = (item.attempts || 0) + 1;
          if (TRANSIENT[e.code] && item.attempts < 6) { item.lastError = e.message; return Outbox.save(item); } // retried by the timer
          item.status = 'FAILED'; item.failedAt = new Date().toISOString();
          item.error = { code: e.code || 'ERROR', message: e.message || 'Rejected by the server.', field: e.field || null };
          return Outbox.save(item).then(step);
        });
      };
      Sync.busy = step().catch(function () {}).then(function () {
        Sync.busy = null; netbar();
        if (sent) {
          toast(sent + ' saved item' + (sent === 1 ? '' : 's') + ' sent.');
          Pack.refresh().then(refreshViewIfSafe);
        }
        return sent;
      });
      return Sync.busy;
    }
  };
  setInterval(function () { if (State.me && Local.uid && !Net.down() && Outbox.pending().length) Sync.run(); }, 60000);
  setInterval(function () {
    var p = Local.pack;
    if (State.me && !Net.down() && Pack.wanted() && (!p || Date.now() - new Date(p.savedAt).getTime() > 15 * 60000)) Pack.refresh();
  }, 60000);

  /** After items are sent, screens showing "waiting to send" are redrawn — but never a form the user is filling in. */
  function refreshViewIfSafe() {
    if (document.querySelector('.modal-bg')) return;
    var r = parseHash(), name = r.seg[0] || 'home';
    if (r.seg[1] === 'new' || r.seg[2] === 'edit' || r.seg[2] === 'stop') return;
    if (['home', 'orders', 'visits', 'outbox', 'deliveries', 'completed', 'customers', 'trips', 'map'].indexOf(name) >= 0) render();
  }

  // ---------- connection banner ----------
  function ago(iso) {
    if (!iso) return 'never';
    var m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : fmtDate(iso);
  }
  function netbar() {
    var el = document.getElementById('netbar'); if (!el) return;
    var n = Local.uid ? Outbox.pending().length : 0, f = Local.uid ? Outbox.failed().length : 0, html = '';
    if (Net.down()) {
      html = '<div class="netbar off"><b>Offline</b> — you can keep working.' + (n ? ' ' + n + ' item' + (n === 1 ? '' : 's') + ' waiting to send.' : '') +
        (Local.pack ? ' Data from ' + esc(ago(Local.pack.savedAt)) + '.' : '') + ' <a href="#/outbox">Outbox</a></div>';
    } else if (Sync.busy || n) {
      html = '<div class="netbar sync">Sending ' + n + ' saved item' + (n === 1 ? '' : 's') + '… <a href="#/outbox">Outbox</a></div>';
    }
    if (f) html += '<div class="netbar bad">' + f + ' saved item' + (f === 1 ? ' was' : 's were') + ' not accepted by the server. <a href="#/outbox">Open Outbox to fix</a></div>';
    if (Local.uid && !Store.durable && (n || f)) html += '<div class="netbar bad">This browser cannot keep data after closing. Keep the app open until everything is sent.</div>';
    el.innerHTML = html;
  }

  // ---------- local copies of what the server would return ----------
  function estimateOrder(p) {
    var lines = (p.Lines || []).map(function (l) {
      var pr = Pack.product(l.ProductID) || { Name: 'Product', UnitsPerCarton: 1, WholesalePrice: 0, TaxRate: 0, Unit: '' };
      var pv = previewLine({ product: pr, Cartons: l.Cartons, LooseUnits: l.LooseUnits, CartonPrice: l.CartonPrice, DiscountPct: l.DiscountPct, DiscountMode: l.DiscountMode, DiscountAmount: l.DiscountAmount });
      return { name: pr.Name, sku: pr.SKU, unit: pr.Unit, qty: pv.qty, cartons: pv.cartons, net: pv.net };
    });
    return { lines: lines, net: Math.round(lines.reduce(function (a, l) { return a + l.net; }, 0) * 100) / 100 };
  }
  function gpsCheck(c, lat, lng) {
    var has = c && typeof c.Latitude === 'number' && c.Latitude !== '' && typeof lat === 'number';
    if (!(typeof lat === 'number' && isFinite(lat))) return { status: 'NO_DRIVER_GPS', dist: '' };
    if (!has) return { status: 'NO_CUSTOMER_GPS', dist: '' };
    var d = Math.round(distance(c.Latitude, c.Longitude, lat, lng)), s = State.settings;
    return { status: d <= (s.GPS_VERIFY_RADIUS_M || 150) ? 'VERIFIED' : d <= (s.GPS_WARN_RADIUS_M || 500) ? 'NEAR' : 'MISMATCH', dist: d };
  }
  function kmText(d) { return d >= 1000 ? (Math.round(d / 100) / 10) + ' km' : d + ' m'; }
  function r3(n) { return Math.round(n * 1000) / 1000; }
  function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  /** A trip as the phone currently knows it: last server copy plus deliveries recorded on this phone but not yet sent. */
  function overlayTrip(t0) {
    var t = clone(t0), items = Outbox.pending().filter(function (i) { return i.action.indexOf('delivery.') === 0; });
    if (!items.length) return t;
    items.forEach(function (i) {
      if (i.action === 'delivery.startTrip' && i.payload.DeliveryID === t.DeliveryID && t.Status === 'PLANNED') t.Status = 'OUT';
      var s = t.StopsList.filter(function (x) { return x.DeliveryOrderID === i.payload.DeliveryOrderID; })[0];
      if (!s || s.Status !== 'PENDING') return;
      s.LocalPending = true; s.DeliveredAt = i.payload.DeviceTime; s.ConfirmedByName = State.me.fullName;
      var g = gpsCheck(s.Customer, i.payload.Latitude, i.payload.Longitude);
      s.GPSStatus = g.status; s.DistanceMeters = g.dist; s.OverrideReason = i.payload.OverrideReason || '';
      if (i.action === 'delivery.fail') { s.Status = 'FAILED'; s.Remarks = i.payload.Reason; return; }
      var q = {}; (i.payload.Lines || []).forEach(function (x) { q[x.OrderLineID] = Number(x.Quantity) || 0; });
      var net = 0;
      s.Lines.forEach(function (l) {
        var d = q[l.OrderLineID] || 0;
        var gross = d * Number(l.Rate), disc = gross * (Number(l.DiscountPct) || 0) / 100, tax = (gross - disc) * (Number(l.TaxRate) || 0) / 100;
        l.ThisStopQty = d ? d : ''; l.ThisStopNet = d ? r2(gross - disc + tax) : ''; net += d ? r2(gross - disc + tax) : 0;
        l.Delivered = r3(Number(l.Delivered) + d); l.Outstanding = r3(Math.max(0, Number(l.Outstanding) - d));
      });
      s.DeliveredNet = r2(net); s.Remarks = i.payload.Remarks || '';
      s.Status = s.Lines.every(function (l) { return l.Outstanding <= 0; }) ? 'DELIVERED' : 'PARTIAL';
      s.Remaining = s.Lines.reduce(function (a, l) { a.cartons += l.Outstanding / l.UnitsPerCarton; a.value += l.Outstanding * Number(l.Rate); return a; }, { cartons: 0, value: 0 });
      s.Remaining.cartons = Math.round(s.Remaining.cartons * 100) / 100; s.Remaining.value = r2(s.Remaining.value);
      if (t.Status === 'PLANNED') t.Status = 'OUT';
    });
    var count = function (st) { return t.StopsList.filter(function (s) { return s.Status === st; }).length; };
    t.Pending = count('PENDING'); t.Delivered = count('DELIVERED'); t.Partial = count('PARTIAL'); t.Failed = count('FAILED');
    if (t.Status === 'OUT' && !t.Pending && t.StopsList.some(function (s) { return s.LocalPending; })) t.Status = 'COMPLETED';
    t.Totals = t.StopsList.reduce(function (a, s) { if (s.Status === 'PENDING') { a.cartons += s.Remaining.cartons; a.value += s.Remaining.value; } a.delivered += Number(s.DeliveredNet) || 0; return a; }, { cartons: 0, value: 0, delivered: 0 });
    t.Totals.cartons = Math.round(t.Totals.cartons * 100) / 100; t.Totals.value = r2(t.Totals.value); t.Totals.delivered = r2(t.Totals.delivered);
    return t;
  }
  function overlayCustomer(c0) {
    var c = clone(c0);
    Outbox.pending('customers.captureLocation').forEach(function (i) {
      if (i.payload.CustomerID !== c.CustomerID) return;
      c.Latitude = i.payload.Latitude; c.Longitude = i.payload.Longitude; c.GPSAccuracy = i.payload.Accuracy; c.HasGPS = true;
      c.LocationCapturedAt = i.payload.DeviceTime; c.LocationCapturedByName = State.me.fullName + ' (waiting to send)'; c.LocalPending = true;
    });
    return c;
  }
  function localOrderRow(i) {
    var c = Pack.customer(i.payload.CustomerID) || {}, est = estimateOrder(i.payload);
    return { OrderID: i.localId, OrderNo: 'Not numbered yet', OrderDate: i.payload.DeviceTime, CustomerID: i.payload.CustomerID, CustomerName: c.ShopName || 'Customer',
      SalespersonName: State.me.fullName, NetAmount: est.net, Status: 'PENDING_SYNC', Local: true };
  }
  function localVisitRow(i) {
    var c = Pack.customer(i.payload.CustomerID) || {}, g = gpsCheck(c, i.payload.Latitude, i.payload.Longitude);
    var ordered = Outbox.pending('orders.save').some(function (o) { return o.payload.VisitID === i.localId; });
    return { VisitID: i.localId, CustomerID: i.payload.CustomerID, CustomerName: c.ShopName || 'Customer', VisitAt: i.payload.DeviceTime, VisitType: i.payload.VisitType,
      Remarks: i.payload.Remarks, SalespersonName: State.me.fullName, GPSStatus: g.status === 'NO_CUSTOMER_GPS' ? 'NO_SHOP_GPS' : g.status, DistanceFromCustomerM: g.dist,
      OrderTaken: ordered, Local: true };
  }
  function paginateLocal(rows, p) {
    var size = Number(p.pageSize) || 50, pages = Math.max(1, Math.ceil(rows.length / size)), page = Math.min(Math.max(Number(p.page) || 1, 1), pages);
    return { items: rows.slice((page - 1) * size, page * size), total: rows.length, page: page, pageSize: size, pages: pages };
  }
  function dayOf(iso) { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' }); }

  var Offline = (function () {
    function offErr(msg) { return { code: 'OFFLINE', message: msg }; }
    function vErr(msg, field) { return { code: 'VALIDATION', message: msg, field: field || null }; }

    // Actions that may be saved on the phone and sent later. Each is idempotent on the server (ClientUUID / state check).
    var QUEUE = {
      'orders.save': {
        when: function (p) { return !p.OrderID && !!p.ClientUUID; }, localPrefix: true,
        label: function (p) { var c = Pack.customer(p.CustomerID); return (p.submit ? 'Order' : 'Draft order') + ' — ' + (c ? c.ShopName : 'customer') + ' (' + (p.Lines || []).length + ' product' + ((p.Lines || []).length === 1 ? '' : 's') + ')'; },
        check: function (p) {
          if (!(p.Lines || []).length) throw vErr('Add at least one product to the order.');
          if (Pack.salesCustomers()) {
            var c = Pack.customer(p.CustomerID);
            if (!c) throw vErr('Select a customer assigned to you.', 'CustomerID');
            if (!c.Active) throw vErr(c.ShopName + ' is inactive. Orders cannot be taken.', 'CustomerID');
          }
          var seen = {};
          p.Lines.forEach(function (l) {
            var pr = Pack.product(l.ProductID);
            if (!pr) throw offErr('A product in this order is not saved on this phone. Connect once to update the product list.');
            if (seen[l.ProductID]) throw vErr(pr.Name + ' appears twice. Combine it into one line.'); seen[l.ProductID] = 1;
            var q = (Number(l.Cartons) || 0) * pr.UnitsPerCarton + (Number(l.LooseUnits) || 0);
            if (!(q > 0)) throw vErr(pr.Name + ': enter a quantity.');
            var cp = l.CartonPrice === undefined || l.CartonPrice === '' || l.CartonPrice === null ? null : Number(l.CartonPrice);
            if (cp !== null && !(cp > 0)) throw vErr(pr.Name + ': enter the price per carton.');
            if (l.DiscountMode === 'AMT') {
              var da = Number(l.DiscountAmount) || 0, lv = Math.round(q * (cp === null ? Number(pr.WholesalePrice) : cp / pr.UnitsPerCarton) * 100) / 100;
              if (da < 0 || da > lv) throw vErr(pr.Name + ': discount must be between 0 and the line value (PKR ' + lv + ').');
            } else { var d = Number(l.DiscountPct) || 0; if (d < 0 || d > 100) throw vErr(pr.Name + ': discount must be between 0 and 100%.'); }
          });
        },
        local: function (p, item) {
          var c = Pack.customer(p.CustomerID) || {};
          return { OrderID: item.localId, OrderNo: '', Status: p.submit ? 'SUBMITTED' : 'DRAFT', CustomerID: p.CustomerID, CustomerName: c.ShopName || '', NetAmount: estimateOrder(p).net, Local: true };
        }
      },
      'visits.create': {
        localPrefix: true,
        label: function (p) { var c = Pack.customer(p.CustomerID); return 'Visit — ' + (c ? c.ShopName : 'customer'); },
        check: function (p) {
          if (Pack.salesCustomers() && !Pack.customer(p.CustomerID)) throw { code: 'NOT_FOUND', message: 'Customer not found or not assigned to you.' };
          if (!(typeof p.Latitude === 'number' && Number(p.Accuracy) > 0)) throw { code: 'GPS_INVALID', message: 'A GPS position is required to record a visit. Enable location and try again.' };
        },
        local: function (p, item) { return localVisitRow(item); }
      },
      'customers.captureLocation': {
        label: function (p) { var c = Pack.customer(p.CustomerID); return 'Shop location — ' + (c ? c.ShopName : 'customer'); },
        check: function (p) {
          if (!(typeof p.Latitude === 'number' && isFinite(p.Latitude))) throw { code: 'GPS_INVALID', message: 'No valid GPS position was received from the device. Please try again outdoors.' };
          var maxAcc = State.settings.GPS_MAX_ACCURACY_M || 50;
          if (Number(p.Accuracy) > maxAcc && !p.ConfirmLowAccuracy) throw { code: 'LOW_ACCURACY', message: 'GPS accuracy is ' + Math.round(p.Accuracy) + ' m (target ' + maxAcc + ' m or better). Move outside or wait and retry, or confirm to save anyway.' };
          var c = Pack.customer(p.CustomerID);
          if (c && typeof overlayCustomer(c).Latitude === 'number' && String(p.Reason || '').trim().length < 3) throw vErr('A reason is required when changing a saved location.', 'Reason');
        },
        local: function (p) {
          var c = Pack.customer(p.CustomerID);
          return c ? overlayCustomer(c) : { CustomerID: p.CustomerID, ShopName: 'Customer', Latitude: p.Latitude, Longitude: p.Longitude, GPSAccuracy: p.Accuracy, LocationCapturedAt: p.DeviceTime, Active: true, LocalPending: true };
        }
      },
      'delivery.startTrip': {
        id: function (p) { return 'start-' + p.DeliveryID; },
        label: function (p) { var t = Pack.trip(p.DeliveryID); return 'Start trip ' + (t ? t.TripNo : ''); },
        check: function (p) {
          var t = Pack.trip(p.DeliveryID);
          if (!t) throw offErr('This trip is not saved on this phone. Open it once with internet.');
          if (t.Status !== 'PLANNED' && t.Status !== 'OUT') throw { code: 'INVALID_STATE', message: 'Trip is ' + t.Status.toLowerCase() + '.' };
        },
        local: function (p) { return overlayTrip(Pack.trip(p.DeliveryID)); }
      },
      'delivery.confirm': {
        label: function (p) { var f = Pack.findStop(p.DeliveryOrderID); return 'Delivery — ' + (f ? f.stop.Customer.ShopName + ' (' + f.stop.OrderNo + ')' : 'stop'); },
        check: function (p) {
          var f = Pack.findStop(p.DeliveryOrderID);
          if (!f) throw offErr('This delivery is not saved on this phone. Open the trip once with internet, then try again.');
          var t = overlayTrip(f.trip), s = t.StopsList.filter(function (x) { return x.DeliveryOrderID === p.DeliveryOrderID; })[0];
          if (s.Status !== 'PENDING') throw { code: 'INVALID_STATE', message: 'This stop was already completed.' };
          if (!t.IsMyTrip && !t.CanPlan) throw { code: 'FORBIDDEN', message: 'Only the driver assigned to this trip can confirm this delivery.' };
          if (t.Status !== 'OUT' && t.Status !== 'PLANNED') throw { code: 'INVALID_STATE', message: 'Trip ' + t.TripNo + ' is no longer open.' };
          var lines = {}, total = 0; s.Lines.forEach(function (l) { lines[l.OrderLineID] = l; });
          (p.Lines || []).forEach(function (x) {
            var l = lines[x.OrderLineID]; if (!l) throw vErr('A line does not belong to this order.');
            var q = Number(x.Quantity) || 0;
            if (q < 0) throw vErr(l.ProductName + ': delivered quantity cannot be less than 0.');
            if (q > l.Outstanding + 1e-9) throw vErr(l.ProductName + ': delivered ' + q + ' is more than the ' + l.Outstanding + ' ' + l.Unit + ' still to deliver.');
            total += q;
          });
          if (total <= 0) throw vErr('Nothing delivered? Use "Could not deliver" instead.');
          var hasGps = typeof p.Latitude === 'number' && Number(p.Accuracy) > 0;
          if (!hasGps && t.IsMyTrip) throw { code: 'GPS_INVALID', message: 'Location permission is required. Please enable location access and try again.' };
          var g = gpsCheck(s.Customer, p.Latitude, p.Longitude);
          if (g.status === 'MISMATCH') {
            if (String(p.OverrideReason || '').trim().length < 5) throw { code: 'GPS_MISMATCH', field: 'OverrideReason', message: 'WARNING: you appear to be about ' + kmText(g.dist) + ' from the saved shop location. Give a reason to continue.' };
            if (!can('delivery.gps_override') && !State.settings.GPS_DRIVER_SELF_OVERRIDE) throw { code: 'FORBIDDEN', message: 'You are about ' + kmText(g.dist) + ' from the shop. A Distribution Manager must approve this delivery.' };
          }
          [['Photo', 'Delivery photo'], ['Signature', 'Signature']].forEach(function (x) { if (p[x[0]] && p[x[0]].length * 0.75 > 2 * 1024 * 1024) throw vErr(x[1] + ' is too large (max 2 MB).'); });
        },
        local: function (p) { return overlayTrip(Pack.findStop(p.DeliveryOrderID).trip); }
      },
      'delivery.fail': {
        label: function (p) { var f = Pack.findStop(p.DeliveryOrderID); return 'Not delivered — ' + (f ? f.stop.Customer.ShopName + ' (' + f.stop.OrderNo + ')' : 'stop'); },
        check: function (p) {
          var f = Pack.findStop(p.DeliveryOrderID);
          if (!f) throw offErr('This delivery is not saved on this phone. Open the trip once with internet, then try again.');
          var s = overlayTrip(f.trip).StopsList.filter(function (x) { return x.DeliveryOrderID === p.DeliveryOrderID; })[0];
          if (s.Status !== 'PENDING') throw { code: 'INVALID_STATE', message: 'This stop was already completed.' };
          if (String(p.Reason || '').trim().length < 3) throw vErr('Select or enter the reason.', 'Reason');
        },
        local: function (p) { return overlayTrip(Pack.findStop(p.DeliveryOrderID).trip); }
      },
      'returns.create': {
        label: function (p) { var f = Pack.findLine(p.OrderLineID); return 'Return — ' + (f ? f.line.ProductName + ' × ' + p.Quantity + ' ' + f.line.Unit + ' (' + f.stop.Customer.ShopName + ')' : p.Quantity); },
        check: function (p) {
          var f = Pack.findLine(p.OrderLineID);
          if (!f) throw offErr('This order is not saved on this phone. Record the return when you have internet.');
          var q = Number(p.Quantity);
          if (!(q > 0)) throw vErr('Quantity must be greater than 0.', 'Quantity');
          var queued = Outbox.pending('returns.create').filter(function (i) { return i.payload.OrderLineID === p.OrderLineID; }).reduce(function (a, i) { return a + Number(i.payload.Quantity); }, 0);
          var returnable = r3(Number(f.line.Delivered) - Number(f.line.Returned || 0) - queued);
          if (q > returnable + 1e-9) throw vErr('Only ' + returnable + ' ' + f.line.Unit + ' of ' + f.line.ProductName + ' can be returned (delivered minus already returned/pending).', 'Quantity');
          if (!p.Reason) throw vErr('Select a return reason.', 'Reason');
        },
        local: function () { return { ReturnNo: '', Local: true }; }
      }
    };

    // Screens that can be answered on the phone. Return null when the phone cannot answer (falls back to the last copy seen online).
    var READ = {
      'auth.me': function () { var b = Local.boot; return b && State.token && b.tok === State.token.slice(-10) ? { me: b.me, settings: b.settings, offline: true } : null; },
      'dashboard.summary': function (p) {
        var c = Local.cache[stableKey('dashboard.summary', p)];
        var d = c ? clone(c.data) : { notices: [], cards: [], generatedAt: Local.pack ? Local.pack.savedAt : new Date().toISOString() };
        d.notices = ['You are offline. ' + (c ? 'Figures below are from ' + ago(c.at) + '.' : 'Figures appear when you are back online.')].concat(d.notices || []);
        return d;
      },
      'customers.list': function (p) {
        if (!Pack.salesCustomers()) return null;
        var q = String(p.q || '').toLowerCase().trim();
        var rows = Local.pack.customers.map(overlayCustomer).filter(function (c) {
          if (p.active === 'false') return false;
          if (p.mine === '1' && c.Mine === false) return false;
          if (p.area && c.Area !== p.area) return false;
          if (p.gps === 'captured' && !c.HasGPS) return false;
          if (p.gps === 'missing' && c.HasGPS) return false;
          if (p.qb === 'unmapped' && c.QBListID) return false;
          return !q || [c.ShopName, c.Code, c.Mobile, c.Area, c.Address, c.ContactPerson].join(' ').toLowerCase().indexOf(q) >= 0;
        }).sort(function (a, b) { return a.ShopName < b.ShopName ? -1 : 1; });
        return paginateLocal(rows, p);
      },
      'customers.areas': function () {
        if (!Pack.salesCustomers()) return null;
        return Object.keys(Local.pack.customers.reduce(function (m, c) { if (c.Area) m[c.Area] = 1; return m; }, {})).sort();
      },
      'customers.get': function (p) {
        var c = Pack.customer(p.CustomerID); if (!c) return null;
        var cached = Local.cache[stableKey('customers.get', p)];
        return overlayCustomer(Object.assign({}, cached ? cached.data : { LocationHistory: [] }, c, { CanMapQB: false }));
      },
      'products.list': function (p) {
        if (!Pack.hasProducts()) return null;
        var q = String(p.q || '').toLowerCase().trim();
        var rows = Local.pack.products.filter(function (x) {
          if (p.active === 'false') return false;
          if (p.categoryId && x.CategoryID !== p.categoryId) return false;
          if (p.qb === 'unmapped' && x.QBListID) return false;
          return !q || (x.Name + ' ' + x.SKU).toLowerCase().indexOf(q) >= 0;
        }).sort(function (a, b) { return a.Name < b.Name ? -1 : 1; });
        return paginateLocal(rows, p);
      },
      'categories.list': function () { return Pack.hasProducts() ? Local.pack.categories || [] : null; },
      'orders.creditInfo': function (p) {
        var c = Pack.customer(p.CustomerID); if (!c) return null;
        var limit = Number(c.CreditLimit) || 0, synced = !!c.QBBalanceAsOf, bal = synced ? Number(c.QBBalance) || 0 : 0;
        var queued = Outbox.pending('orders.save').filter(function (i) { return i.payload.CustomerID === c.CustomerID && i.payload.submit; });
        var open = r2(Number(c.OpenOrdersValue || 0) + queued.reduce(function (a, i) { return a + estimateOrder(i.payload).net; }, 0));
        var available = r2(limit - bal - open), amt = Number(p.Amount) || 0, after = r2(available - amt);
        return { creditLimit: limit, qbBalance: synced ? bal : null, qbBalanceAsOf: c.QBBalanceAsOf || null, openOrdersValue: open,
          openOrdersCount: Number(c.OpenOrdersCount || 0) + queued.length, outstanding: r2(bal + open), available: available, newOrder: r2(amt), availableAfter: after,
          status: limit <= 0 ? 'NO_LIMIT_SET' : after < 0 ? 'EXCEEDED' : 'OK', paymentTerms: c.PaymentTerms, estimated: true, asOf: Local.pack.savedAt };
      },
      'orders.list': function (p) {
        var c = Local.cache[stableKey('orders.list', p)];
        if (c) return c.data;
        return Pack.salesCustomers() ? { items: [], total: 0, page: 1, pageSize: 25, pages: 1, totalValue: 0 } : null;
      },
      'visits.list': function (p) {
        var c = Local.cache[stableKey('visits.list', p)];
        if (c) return c.data;
        return Pack.salesCustomers() ? { items: [], total: 0, page: 1, pageSize: 25, pages: 1, summary: { visits: 0, customersVisited: 0, customersWithOrder: 0, customersWithoutOrder: 0, gpsMismatch: 0 } } : null;
      },
      'delivery.trips': function (p) {
        if (!Local.pack || !State.me.driverId) return null;
        var st = p.status ? String(p.status).split(',') : null;
        var items = (Local.pack.trips || []).map(overlayTrip).filter(function (t) {
          if (st && st.indexOf(t.Status) < 0) return false;
          if (p.from && t.DeliveryDate < p.from && t.Status !== 'OUT') return false;
          if (p.to && t.DeliveryDate > p.to) return false;
          return true;
        });
        return { items: items, total: items.length, page: 1, pages: 1 };
      },
      'delivery.trip': function (p) { var t = Pack.trip(p.DeliveryID); return t ? overlayTrip(t) : null; }
    };
    // Copies of these are kept from online use so the screen still opens offline.
    var CACHED = { 'auth.me': 0, 'dashboard.summary': 1, 'customers.list': 1, 'customers.get': 1, 'customers.areas': 1, 'salespersons.options': 1, 'products.list': 1,
      'categories.list': 1, 'orders.list': 1, 'orders.get': 1, 'visits.list': 1, 'delivery.trips': 1, 'delivery.trip': 1, 'returns.list': 1,
      'commission.report': 1, 'commission.statement': 1, 'territories.list': 1,
      // kept for instant screens (see SWR)
      'salespersons.list': 1, 'products.get': 1, 'delivery.ready': 1, 'qb.status': 1, 'qb.queue': 1, 'settings.list': 1, 'users.list': 1, 'roles.list': 1,
      'fleet.drivers': 1, 'fleet.vehicles': 1, 'commission.rules': 1, 'commission.dashboard': 1 };
    var PACK_FIRST = { 'customers.list': 1, 'customers.areas': 1, 'customers.get': 1, 'products.list': 1, 'categories.list': 1, 'orders.creditInfo': 1, 'delivery.trip': 1, 'delivery.trips': 1, 'auth.me': 1 };
    var refreshTimer = null;

    function remember(action, p, data) {
      var k = stableKey(action, p), keys;
      Local.cache[k] = { at: new Date().toISOString(), t: Date.now(), data: data };
      keys = Object.keys(Local.cache);
      if (keys.length > 80) keys.sort(function (a, b) { return Local.cache[a].at < Local.cache[b].at ? -1 : 1; }).slice(0, keys.length - 80).forEach(function (x) { delete Local.cache[x]; });
      Local.saveCacheSoon();
    }

    return {
      isRead: function (action) { return !!(READ[action] || CACHED[action]); },
      packFirst: function (action) { return !!PACK_FIRST[action]; },
      queueable: function (action, p) { var q = QUEUE[action]; return q && (!q.when || q.when(p)) ? q : null; },
      pendingCount: function () { return Local.uid ? Outbox.pending().length + Outbox.failed().length : 0; },
      label: function (item) { return item.label; },

      enqueue: function (action, payload) {
        var q = QUEUE[action], p = clone(payload);
        if (!Local.uid) return Promise.reject(offErr('You are offline. Sign in once with internet first.'));
        try { if (q.check) q.check(p); } catch (e) { return Promise.reject(e); }
        if (!p.DeviceTime) p.DeviceTime = new Date().toISOString();
        if (action === 'customers.captureLocation') p.Source = 'OFFLINE';
        var id = q.id ? q.id(p) : p.ClientUUID;
        var existing = Outbox.get(id);
        if (existing) return Promise.resolve(q.local(existing.payload, existing));
        var item = { id: id, seq: Date.now() * 1000 + Math.floor(Math.random() * 1000), userId: Local.uid, action: action, payload: p, label: q.label(p),
          status: 'PENDING', attempts: 0, createdAt: new Date().toISOString(), localId: q.localPrefix ? 'local-' + id : '' };
        return Outbox.add(item).then(function () {
          netbar();
          if (!Net.down()) setTimeout(Sync.run, 50);
          var r = q.local(p, item); if (r && typeof r === 'object') r.Local = true;
          return r;
        });
      },

      read: function (action, payload) {
        var r = READ[action] ? READ[action](payload || {}) : null;
        if ((r === null || r === undefined) && CACHED[action]) { var c = Local.cache[stableKey(action, payload)]; if (c) r = clone(c.data); }
        if (r === null || r === undefined) return null;
        return Promise.resolve(Offline.overlay(action, payload, clone(r)));
      },

      afterOnline: function (action, p, data, wasQueueable) {
        if (action === 'auth.me') Local.saveBoot(data);
        if (CACHED[action] && Local.uid) remember(action, p, data);
        if (action === 'delivery.trip') Pack.putTrip(data);
        if (action === 'customers.get' || action === 'customers.captureLocation') Pack.putCustomer(data);
        if (action.indexOf('delivery.') === 0 && data && data.StopsList) Pack.putTrip(data);
        if (wasQueueable || action === 'orders.submit' || action === 'orders.cancel') { clearTimeout(refreshTimer); refreshTimer = setTimeout(Pack.refresh, 4000); }
      },

      /** Adds what is still waiting in the outbox to what the server (or the cache) returned. */
      overlay: function (action, p, data) {
        if (!Local.uid || !data) return data;
        p = p || {};
        if (action === 'customers.get' || action === 'customers.captureLocation') return overlayCustomer(data);
        if (action === 'delivery.trip' || ((action === 'delivery.startTrip' || action === 'delivery.confirm' || action === 'delivery.fail') && data.StopsList)) return overlayTrip(data);
        if (action === 'customers.list' && data.items) { data.items = data.items.map(overlayCustomer); return data; }
        if (action === 'delivery.trips' && data.items) {
          data.items = data.items.map(function (t) { var full = Pack.trip(t.DeliveryID); if (!full) return t; var o = overlayTrip(full); delete o.StopsList; return Object.assign({}, t, o); });
          return data;
        }
        if (action === 'orders.list' && data.items && (Number(p.page) || 1) === 1 && !p.status && !p.credit) {
          var q = String(p.q || '').toLowerCase();
          var mine = Outbox.mine().filter(function (i) { return i.action === 'orders.save' && i.status !== 'DONE'; }).map(function (i) { var r = localOrderRow(i); r.Failed = i.status === 'FAILED'; return r; })
            .filter(function (r) { return (!q || r.CustomerName.toLowerCase().indexOf(q) >= 0) && (!p.from || dayOf(r.OrderDate) >= p.from) && (!p.to || dayOf(r.OrderDate) <= p.to); });
          if (mine.length) { data.items = mine.reverse().concat(data.items); data.total += mine.length; data.totalValue = r2((data.totalValue || 0) + mine.reduce(function (a, r) { return a + r.NetAmount; }, 0)); }
          return data;
        }
        if (action === 'visits.list' && data.items && (Number(p.page) || 1) === 1 && !p.salespersonId) {
          var vs = Outbox.pending('visits.create').map(localVisitRow).filter(function (v) {
            return (!p.from || dayOf(v.VisitAt) >= p.from) && (!p.to || dayOf(v.VisitAt) <= p.to) && (p.orderTaken !== 'true' || v.OrderTaken) && (p.orderTaken !== 'false' || !v.OrderTaken);
          });
          if (vs.length) {
            data.items = vs.reverse().concat(data.items); data.total += vs.length;
            var s = data.summary = Object.assign({}, data.summary); s.visits += vs.length;
            var seen = {}; data.items.forEach(function (v) { seen[v.CustomerID] = seen[v.CustomerID] || v.OrderTaken; });
            s.customersVisited = Object.keys(seen).length; s.customersWithOrder = Object.keys(seen).filter(function (k) { return seen[k]; }).length;
            s.customersWithoutOrder = s.customersVisited - s.customersWithOrder;
          }
          return data;
        }
        if (action === 'dashboard.summary') {
          var n = Outbox.pending().length, f = Outbox.failed().length;
          if (n) data.notices = (data.notices || []).concat([n + ' item' + (n === 1 ? '' : 's') + ' saved on this phone, waiting to be sent.']);
          if (f) data.notices = (data.notices || []).concat([f + ' saved item' + (f === 1 ? ' was' : 's were') + ' not accepted by the server — open Outbox.']);
          return data;
        }
        return data;
      }
    };
  })();

  /** Message after saving: different when the action was stored on the phone instead of sent. */
  function savedMsg(r, onlineMsg) { return r && r.Local ? 'Saved on this phone — it is sent automatically when you are online.' : onlineMsg; }

  // ---------- helpers ----------
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function fmtDate(iso, withTime) {
    if (!iso) return '';
    var d = new Date(iso); if (isNaN(d)) return esc(iso);
    var opts = { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Karachi' };
    if (withTime !== false) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
    return d.toLocaleString('en-GB', opts);
  }
  function money(n) { if (n === '' || n === null || n === undefined) return ''; return (State.settings.CURRENCY || 'PKR') + ' ' + Number(n).toLocaleString('en-PK', { maximumFractionDigits: 2 }); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.substr(0, 8) + '-' + h.substr(8, 4) + '-' + h.substr(12, 4) + '-' + h.substr(16, 4) + '-' + h.substr(20);
  }
  function toast(msg, bad) {
    var box = $('#toast'), same = Array.prototype.filter.call(box.children, function (x) { return x.textContent === msg; })[0];
    if (same) { clearTimeout(same._t); same._t = setTimeout(function () { same.remove(); }, bad ? 6000 : 3000); return; } // repeated message: keep one
    var d = document.createElement('div'); d.textContent = msg; if (bad) d.className = 'bad';
    box.appendChild(d); d._t = setTimeout(function () { d.remove(); }, bad ? 6000 : 3000);
  }
  function busy(btn, on) { if (!btn) return; btn.disabled = on; if (on) { btn.dataset.t = btn.textContent; btn.textContent = 'Please wait…'; } else if (btn.dataset.t) btn.textContent = btn.dataset.t; }
  function mapsView(lat, lng) { return 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng; }
  function mapsNav(lat, lng) { return 'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lng + '&travelmode=driving'; }
  function badge(active) { return active ? '<span class="badge good">Active</span>' : '<span class="badge bad">Inactive</span>'; }

  // ---------- router ----------
  function parseHash() {
    var h = location.hash.replace(/^#\/?/, ''); var parts = h.split('?');
    var q = {}; (parts[1] || '').split('&').forEach(function (kv) { if (!kv) return; var x = kv.split('='); q[decodeURIComponent(x[0])] = decodeURIComponent(x[1] || ''); });
    var seg = parts[0].split('/').filter(String);
    return { seg: seg, q: q };
  }
  function go(path) { location.hash = '#/' + path; }
  window.addEventListener('hashchange', function () { render(); });

  var NAV = [
    { path: 'home', label: 'Home', ic: '⌂', perm: 'dashboard.view', bottom: true },
    { path: 'customers', label: 'Customers', ic: '🏪', perm: ['customers.view.all', 'customers.view.own'], bottom: true },
    { path: 'orders', label: 'Orders', ic: '🧾', perm: ['orders.view.all', 'orders.view.own'], bottom: true },
    { path: 'visits', label: 'Visits', ic: '📍', perm: ['visits.create', 'visits.view.all'], bottom: true },
    { path: 'products', label: 'Products', ic: '📦', perm: 'products.view', bottom: true },
    { path: 'salespersons', label: 'Salespersons', ic: '🧑‍💼', perm: 'salespersons.view' },
    { path: 'deliveries', label: 'Deliveries', ic: '🚚', perm: 'delivery.own', driverOnly: true },
    { path: 'map', label: 'Map', ic: '🗺', perm: 'delivery.own', driverOnly: true },
    { path: 'completed', label: 'Completed', ic: '✅', perm: 'delivery.own', driverOnly: true },
    { path: 'planning', label: 'Planning', ic: '🧭', perm: 'delivery.plan' },
    { path: 'trips', label: 'Trips', ic: '🚛', perm: ['delivery.plan', 'delivery.view.all'], routePerm: ['delivery.plan', 'delivery.view.all', 'delivery.own'] },
    { path: 'returns', label: 'Returns', ic: '↩', perm: ['returns.create', 'returns.approve', 'delivery.view.all'] },
    { path: 'gpsreview', label: 'GPS review', ic: '🛰', perm: ['delivery.plan', 'delivery.view.all'] },
    { path: 'fleet', label: 'Fleet', ic: '🚐', perm: ['drivers.manage', 'vehicles.manage'] },
    { path: 'commission', label: 'Commission', ic: '💰', perm: ['commission.view.all', 'commission.view.own'] },
    { path: 'commrules', label: 'Commission rates', ic: '⚖', perm: ['commission.rules', 'commission.view.all'] },
    { path: 'quickbooks', label: 'QuickBooks', ic: '🔄', perm: 'qb.manage' },
    { path: 'users', label: 'Users', ic: '👥', perm: 'users.manage' },
    { path: 'settings', label: 'Settings', ic: '⚙', perm: 'settings.manage' },
    { path: 'audit', label: 'Audit log', ic: '📜', perm: 'audit.view' },
    { path: 'backups', label: 'Backups', ic: '💾', perm: 'backup.run' },
    { path: 'system', label: 'System & archive', ic: '🗄', perm: 'settings.manage' },
    { path: 'reports', label: 'Reports', ic: '📊', perm: ['orders.view.all', 'orders.view.own', 'delivery.view.all', 'delivery.plan', 'visits.view.all', 'qb.manage', 'customers.view.all', 'commission.view.all', 'commission.view.own'] },
    { path: 'custmap', label: 'Customer map', ic: '🗺', perm: 'customers.view.all', routePerm: ['customers.view.all', 'customers.view.own'] },
    { path: 'outbox', label: 'Outbox', ic: '📤', perm: ['orders.create', 'visits.create', 'customers.location', 'delivery.own', 'returns.create'] },
    { path: 'more', label: 'More', ic: '☰', perm: null, mobileOnly: true },
    { path: 'profile', label: 'Profile', ic: '👤', perm: null }
  ];
  /** Mobile bottom bar: first four permitted main sections + More. */
  function navAllowed(n) { return (!n.perm || can(n.perm)) && (!n.driverOnly || !!(State.me && State.me.driverId)); }
  /** Mobile bottom bar per role (spec: salesperson Home/Customers/Orders/Visits; driver Home/Deliveries/Map/Completed), then More. */
  var BOTTOM_BY_ROLE = { SALESPERSON: ['home', 'customers', 'orders', 'visits'], DRIVER: ['home', 'deliveries', 'map', 'completed'],
    DISTRIBUTION_MANAGER: ['home', 'planning', 'trips', 'returns'], ACCOUNTS: ['home', 'commission', 'quickbooks', 'returns'] };
  function bottomItems() {
    var pref = BOTTOM_BY_ROLE[State.me && State.me.roleCode] || ['home', 'customers', 'orders', 'products'];
    var main = pref.map(function (p) { return NAV.filter(function (n) { return n.path === p && navAllowed(n); })[0]; }).filter(Boolean);
    return main.concat(NAV.filter(function (n) { return n.path === 'more'; }));
  }

  var VIEWS = {};

  function shell(title, bodyHtml, opts) {
    opts = opts || {};
    var r = parseHash(), cur = r.seg[0] || 'home';
    if (cur === 'trips' && State.me && State.me.driverId && !can('delivery.plan')) cur = 'deliveries'; // driver's trip screens live under Deliveries
    var items = NAV.filter(navAllowed);
    var side = '<div class="brand">' + esc(State.settings.COMPANY_NAME || 'Prosol Foods') + '</div>' + items.filter(function (n) { return !n.mobileOnly; })
      .map(function (n) { return '<a href="#/' + n.path + '" class="' + (cur === n.path ? 'on' : '') + '"><span>' + n.ic + '</span>' + esc(n.label) + '</a>'; }).join('');
    var bItems = bottomItems();
    var bottom = bItems
      .map(function (n) { var on = cur === n.path || (n.path === 'more' && !bItems.some(function (x) { return x.path === cur; })); return '<a href="#/' + n.path + '" class="' + (on ? 'on' : '') + '"><span class="ic">' + n.ic + '</span>' + esc(n.label) + '</a>'; }).join('');
    $('#root').innerHTML = '<div class="app"><nav class="sidebar">' + side + '</nav><div class="main">' +
      '<header class="topbar">' + (opts.back ? '<button class="back" aria-label="Back" id="backBtn">‹</button>' : '') +
      '<h1>' + esc(title) + '</h1><span class="who">' + esc(State.me.fullName) + '</span></header><div id="netbar"></div>' +
      '<div class="content" id="content">' + bodyHtml + '</div></div><nav class="bottomnav">' + bottom + '</nav></div>';
    var b = $('#backBtn'); if (b) b.onclick = function () { opts.back === true ? history.back() : go(opts.back); };
    netbar();
    return $('#content');
  }

  function loading(title, back) { shell(title, '<div class="spinner">Loading…</div>', { back: back }); }
  function showError(e) { toast(e && e.message ? e.message : 'Something went wrong.', true); }

  // ---------- generic form builder ----------
  function fieldHtml(f, val) {
    var id = 'f_' + f.name, v = val === undefined || val === null ? '' : val, req = f.required ? ' required' : '', ro = f.readonly ? ' disabled' : '';
    var cls = 'field' + (f.span2 ? ' span2' : '');
    var input;
    if (f.type === 'select') {
      input = '<select id="' + id + '" name="' + f.name + '"' + req + ro + '>' + (f.required ? '' : '<option value="">—</option>') +
        (f.options || []).map(function (o) { return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(v) ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select>';
    } else if (f.type === 'checkbox') {
      return '<div class="' + cls + '"><label class="check"><input type="checkbox" id="' + id + '" name="' + f.name + '"' + (v === true || v === 'true' ? ' checked' : '') + ro + '> ' + esc(f.label) + '</label>' + (f.hint ? '<div class="hint">' + esc(f.hint) + '</div>' : '') + '<div class="ferr" data-err="' + f.name + '"></div></div>';
    } else if (f.type === 'textarea') {
      input = '<textarea id="' + id + '" name="' + f.name + '"' + req + ro + '>' + esc(v) + '</textarea>';
    } else {
      var t = f.type || 'text', extra = f.type === 'number' ? ' inputmode="decimal" step="any"' : '';
      if (f.type === 'tel') extra = ' inputmode="tel"';
      input = '<input type="' + t + '" id="' + id + '" name="' + f.name + '" value="' + esc(v) + '"' + req + ro + extra + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + ' autocomplete="off">';
    }
    return '<div class="' + cls + '"><label for="' + id + '">' + esc(f.label) + (f.required ? ' *' : '') + '</label>' + input +
      (f.hint ? '<div class="hint">' + esc(f.hint) + '</div>' : '') + '<div class="ferr" data-err="' + f.name + '"></div></div>';
  }
  function formHtml(fields, rec) { return '<div class="form-grid">' + fields.map(function (f) { return fieldHtml(f, rec ? rec[f.name] : f.dflt); }).join('') + '</div>'; }
  function readForm(root, fields) {
    var o = {};
    fields.forEach(function (f) { if (f.readonly) return; var el = $('[name="' + f.name + '"]', root); if (!el) return; o[f.name] = f.type === 'checkbox' ? el.checked : el.value.trim(); });
    return o;
  }
  function fieldError(root, e) {
    $all('.ferr', root).forEach(function (x) { x.textContent = ''; });
    if (e && e.field) { var el = $('[data-err="' + e.field + '"]', root); if (el) { el.textContent = e.message; var inp = $('[name="' + e.field + '"]', root); if (inp) inp.focus(); return; } }
    showError(e);
  }

  function modal(title, html, onReady) {
    var bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><h3>' + esc(title) + '</h3>' + html + '</div>';
    document.body.appendChild(bg);
    var close = function () { bg.remove(); };
    bg.addEventListener('click', function (ev) { if (ev.target === bg) close(); });
    if (onReady) onReady($('.modal', bg), close);
    return close;
  }
  function confirmBox(title, message, okLabel) {
    return new Promise(function (resolve) {
      modal(title, '<p>' + esc(message) + '</p><div class="btn-row"><button class="btn primary" data-a="ok">' + esc(okLabel || 'OK') + '</button><button class="btn" data-a="no">Cancel</button></div>', function (m, close) {
        $('[data-a=ok]', m).onclick = function () { close(); resolve(true); };
        $('[data-a=no]', m).onclick = function () { close(); resolve(false); };
      });
    });
  }
  function showSecret(title, label, secret) {
    modal(title, '<p>' + esc(label) + '</p><div class="secret">' + esc(secret) + '</div><p class="hint">This password is shown only once. The user must change it at first login.</p><div class="btn-row"><button class="btn primary" data-a="ok">Done</button></div>', function (m, close) { $('[data-a=ok]', m).onclick = close; });
  }

  function pager(res, onPage) {
    var html = '<div class="pager"><span>' + res.total + ' record' + (res.total === 1 ? '' : 's') + ' · page ' + res.page + ' of ' + res.pages + '</span><span>' +
      (res.page > 1 ? '<button class="btn" data-p="' + (res.page - 1) + '">‹ Prev</button> ' : '') +
      (res.page < res.pages ? '<button class="btn" data-p="' + (res.page + 1) + '">Next ›</button>' : '') + '</span></div>';
    return { html: html, bind: function (root) { $all('[data-p]', root).forEach(function (b) { b.onclick = function () { onPage(Number(b.dataset.p)); }; }); } };
  }

  // ---------- GPS ----------
  function getPosition() {
    return new Promise(function (resolve, reject) {
      if (!('geolocation' in navigator)) return reject({ message: 'This device or browser does not support GPS location.' });
      if (window.isSecureContext === false) return reject({ message: 'Location requires a secure (https) connection.' });
      navigator.geolocation.getCurrentPosition(function (pos) {
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, time: new Date(pos.timestamp).toISOString() });
      }, function (err) {
        var m = err.code === 1 ? 'Location permission is required. Please enable location access and try again.'
          : err.code === 3 ? 'Could not get a GPS fix in time. Move to an open area and try again.'
          : 'Location is unavailable. Turn on GPS/Location Services and try again.';
        reject({ message: m, code: 'GPS' });
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }

  // ---------- views: auth ----------
  function renderLogin(msg) {
    // the server: the Apps Script web app, the Supabase function (item D), or the local test server
    if (!hasGsr && !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(CONFIG.apiUrl || '') &&
        !/^https:\/\/[a-z0-9]{20}\.supabase\.co\/functions\/v1\/api$/.test(CONFIG.apiUrl || '') && CONFIG.apiUrl !== '/api') {
      $('#root').innerHTML = '<div class="login-wrap"><div class="login-card"><div class="logo">PROSOL FOODS</div><div class="card"><h2>Setup not finished</h2>' +
        '<p>This copy of the app does not know the server address yet. In <b>config.js</b>, replace the placeholder with the Apps Script web-app URL (ends with <code>/exec</code>) — see DEPLOY.md section 9.</p></div></div></div>';
      return;
    }
    $('#root').innerHTML = '<div class="login-wrap"><div class="login-card"><div class="logo">PROSOL FOODS</div><form class="card" id="lf">' +
      '<h2>Sign in</h2>' + (msg ? '<div class="alert bad">' + esc(msg) + '</div>' : '') +
      '<div class="field"><label for="u">Username</label><input type="text" id="u" autocomplete="username" autocapitalize="none" required></div>' +
      '<div class="field"><label for="p">Password</label><input type="password" id="p" autocomplete="current-password" required></div>' +
      '<button class="btn primary block" type="submit">Sign in</button></form></div></div>';
    $('#lf').onsubmit = function (ev) {
      ev.preventDefault(); var b = $('button', ev.target); busy(b, true);
      API.call('auth.login', { username: $('#u').value, password: $('#p').value }).then(function (d) {
        State.save(d.token); State.me = d.me; return boot();
      }).catch(function (e) { busy(b, false); renderLogin(e.message); });
    };
  }

  function renderChangePassword(forced) {
    var html = (forced ? '<div class="alert warn">You are using a temporary password. Choose your own password to continue.</div>' : '') +
      '<form class="card" id="cp"><div class="field"><label>Current password</label><input type="password" name="oldPassword" autocomplete="current-password" required><div class="ferr" data-err="oldPassword"></div></div>' +
      '<div class="field"><label>New password</label><input type="password" name="newPassword" autocomplete="new-password" required><div class="hint">At least 8 characters with letters and numbers.</div><div class="ferr" data-err="newPassword"></div></div>' +
      '<div class="field"><label>Repeat new password</label><input type="password" name="repeat" autocomplete="new-password" required><div class="ferr" data-err="repeat"></div></div>' +
      '<div class="btn-row"><button class="btn primary" type="submit">Change password</button>' + (forced ? '<button class="btn" type="button" id="lo">Sign out</button>' : '') + '</div></form>';
    var root;
    if (forced) { $('#root').innerHTML = '<div class="login-wrap"><div class="login-card"><div class="logo">PROSOL FOODS</div>' + html + '</div></div>'; root = $('#root'); }
    else root = shell('Change password', html, { back: 'profile' });
    var f = $('#cp', root);
    if ($('#lo', root)) $('#lo', root).onclick = logout;
    f.onsubmit = function (ev) {
      ev.preventDefault();
      var o = { oldPassword: f.oldPassword.value, newPassword: f.newPassword.value };
      if (o.newPassword !== f.repeat.value) return fieldError(f, { field: 'repeat', message: 'Passwords do not match.' });
      var b = $('button[type=submit]', f); busy(b, true);
      API.call('auth.changePassword', o).then(function (me) { State.me = me; toast('Password changed.'); go('home'); render(); })
        .catch(function (e) { busy(b, false); fieldError(f, e); });
    };
  }

  function logout() {
    var n = Offline.pendingCount();
    (n ? confirmBox('Items not sent yet', n + ' item' + (n === 1 ? '' : 's') + ' on this phone have not reached the office yet. They stay on this phone and are sent the next time you sign in here. Sign out anyway?', 'Sign out')
      : Promise.resolve(true)).then(function (yes) {
      if (!yes) return;
      API.call('auth.logout').catch(function () {}).then(function () { Local.clearUser(); State.clear(); location.hash = ''; render(); });
    });
  }

  // ---------- views: home ----------
  VIEWS.home = function (r) {
    loading('Home');
    API.call('dashboard.summary', r && r.q.fresh ? { fresh: true } : {}).then(function (d) {
      var html = d.notices.map(function (n) { return '<div class="alert warn">' + esc(n) + '</div>'; }).join('');
      html += '<p style="margin:0 0 4px;color:var(--muted)">Welcome, ' + esc(State.me.fullName) + ' · ' + esc(State.me.roleName) + '</p>';
      d.cards.forEach(function (c) {
        html += '<div class="group-title">' + esc(c.group) + '</div><div class="grid">' + c.items.map(function (i) {
          var v = i.isDate ? fmtDate(i.value) : i.money ? money(i.value) : (typeof i.value === 'number' ? i.value.toLocaleString() : esc(i.value));
          return '<a class="stat' + (i.warn && i.value ? ' warn' : '') + '"' + (i.link ? ' href="#/' + i.link + '"' : '') + '><div class="v"' + (i.isDate || typeof i.value !== 'number' ? ' style="font-size:16px"' : '') + '>' + v + '</div><div class="l">' + esc(i.label) + '</div></a>';
        }).join('') + '</div>';
      });
      (d.tables || []).forEach(function (tb) {
        var max = Math.max.apply(null, tb.rows.map(function (r) { return Math.abs(Number(r[tb.bar]) || 0); }).concat([1]));
        html += '<div class="group-title">' + esc(tb.title) + (tb.link ? ' · <a href="#/' + tb.link + '" style="text-transform:none;letter-spacing:0">full report</a>' : '') + '</div><div class="card" style="padding:8px 12px"><div class="scroll-x"><table class="tbl dash">' +
          '<tr>' + tb.columns.map(function (c) { return '<th' + (isNum(c.t) ? ' class="n"' : '') + '>' + esc(c.label) + '</th>'; }).join('') + '</tr>' +
          tb.rows.map(function (r) { return '<tr>' + tb.columns.map(function (c) {
            var v = fmtCell(r[c.k], c.t);
            if (c.k === tb.bar) v = '<span class="bar"><span style="width:' + Math.round(Math.abs(Number(r[c.k]) || 0) / max * 100) + '%"></span></span>' + v;
            return '<td' + (isNum(c.t) ? ' class="n"' : '') + '>' + v + '</td>'; }).join('') + '</tr>'; }).join('') + '</table></div></div>';
      });
      html += '<p class="hint" style="margin-top:16px;color:var(--muted);font-size:12px">Figures counted from live records at ' + fmtDate(d.generatedAt) + '. <a href="#/home?fresh=' + Date.now() + '">Refresh now</a></p>';
      shell('Home', html);
    }).catch(showError);
  };

  VIEWS.more = function () {
    var inBar = bottomItems().map(function (n) { return n.path; });
    var items = NAV.filter(function (n) { return navAllowed(n) && inBar.indexOf(n.path) < 0; });
    shell('More', '<ul class="list">' + items.map(function (n) { return '<li><a class="row" href="#/' + n.path + '"><span>' + n.ic + '</span><span class="main-t"><span class="t1">' + esc(n.label) + '</span></span><span>›</span></a></li>'; }).join('') + '</ul>');
  };

  VIEWS.profile = function (r) {
    if (r.seg[1] === 'password') return renderChangePassword(false);
    var m = State.me;
    shell('Profile', '<div class="card"><dl class="kv"><dt>Name</dt><dd>' + esc(m.fullName) + '</dd><dt>Username</dt><dd>' + esc(m.username) + '</dd><dt>Role</dt><dd>' + esc(m.roleName) + '</dd>' +
      (m.salespersonId ? '<dt>Salesperson</dt><dd>' + esc(m.salespersonId) + '</dd>' : '') + '<dt>App version</dt><dd>' + esc(State.settings.APP_VERSION) + '</dd></dl></div>' +
      '<div class="btn-row"><a class="btn" href="#/profile/password">Change password</a><button class="btn danger" id="lo">Sign out</button></div>');
    $('#lo').onclick = logout;
  };

  // ---------- views: customers ----------
  var custOpts = { sp: null, areas: null };
  function loadCustOptions() {
    var ps = [];
    if (!custOpts.areas) ps.push(API.call('customers.areas').then(function (a) { custOpts.areas = a; }));
    if (!custOpts.sp && can(['customers.manage', 'customers.view.all'])) ps.push(API.call('salespersons.options').then(function (s) { custOpts.sp = s; }));
    return Promise.all(ps);
  }

  VIEWS.customers = function (r) {
    if (r.seg[1] === 'new') return customerForm(null);
    if (r.seg[1] && r.seg[2] === 'edit') return API.call('customers.get', { CustomerID: r.seg[1] }).then(customerForm).catch(showError);
    if (r.seg[1]) return customerDetail(r.seg[1]);
    var q = r.q, page = Number(q.page) || 1;
    loading('Customers');
    loadCustOptions().then(function () {
      return API.call('customers.list', { q: q.q, area: q.area, salespersonId: q.sp, mine: q.mine, active: q.active, gps: q.gps, qb: q.qb, incomplete: q.incomplete, qbcreate: q.qbcreate, page: page });
    }).then(function (res) {
      var canCreate = can(['customers.manage', 'customers.create.own']);
      var html = '<div class="toolbar"><input type="search" class="search" id="cq" placeholder="Search name, code, phone, area" value="' + esc(q.q || '') + '">' +
        '<select id="cArea"><option value="">All areas</option>' + (custOpts.areas || []).map(function (a) { return '<option' + (a === q.area ? ' selected' : '') + '>' + esc(a) + '</option>'; }).join('') + '</select>' +
        // salespersons see every shop; "My shops" narrows to the ones assigned to them
        (State.me && State.me.salespersonId && !can('customers.view.all') ? '<select id="cMine" aria-label="Which shops"><option value="">All shops</option><option value="1"' + (q.mine === '1' ? ' selected' : '') + '>My shops</option></select>' : '') +
        (custOpts.sp ? '<select id="cSp"><option value="">All salespersons</option>' + custOpts.sp.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === q.sp ? ' selected' : '') + '>' + esc(s.label) + '</option>'; }).join('') + '</select>' : '') +
        '<select id="cGps"><option value="">GPS: any</option><option value="captured"' + (q.gps === 'captured' ? ' selected' : '') + '>GPS captured</option><option value="missing"' + (q.gps === 'missing' ? ' selected' : '') + '>GPS missing</option></select>' +
        '<select id="cAct"><option value="">Active + inactive</option><option value="true"' + (q.active === 'true' ? ' selected' : '') + '>Active</option><option value="false"' + (q.active === 'false' ? ' selected' : '') + '>Inactive</option></select>' +
        (canCreate ? '<a class="btn primary" href="#/customers/new">+ New customer</a>' : '') + '</div>';
      if (q.qb === 'unmapped') html += '<div class="alert warn">Showing customers not mapped to QuickBooks. <a href="#/customers">Clear</a></div>';
      if (q.qbcreate === 'failed') html += '<div class="alert bad">Customers that could not be created in QuickBooks. Open each one to see why, fix it (for example the name), then press <b>Create in QuickBooks</b>. <a href="#/customers">Clear</a></div>';
      if (q.incomplete === '1') html += '<div class="alert warn">Showing customers with details still missing (mobile, address, area, city or salesperson). Open each one and press Edit. <a href="#/customers">Clear</a></div>';
      if (!res.items.length) html += '<div class="empty card">No customers found.</div>';
      else html += '<ul class="list">' + res.items.map(function (c) {
        return '<li><a class="row" href="#/customers/' + encodeURIComponent(c.CustomerID) + '"><span class="main-t"><div class="t1">' + esc(c.ShopName) + '</div><div class="t2">' + esc(c.Code) + ' · ' + esc(c.Area) + ' · ' + esc(c.Mobile) + (c.SalespersonName ? ' · ' + esc(c.SalespersonName) : '') + '</div></span>' +
          (c.HasGPS ? '<span class="badge good">GPS</span>' : '<span class="badge warn">No GPS</span>') + (c.Active ? '' : ' <span class="badge bad">Inactive</span>') + '</a></li>';
      }).join('') + '</ul>';
      var pg = pager(res, function (p) { setQ({ page: p }); });
      html += pg.html;
      var root = shell('Customers', html);
      pg.bind(root);
      function setQ(patch) { var n = Object.assign({}, q, patch); if (!patch.page) n.page = 1; go('customers?' + Object.keys(n).filter(function (k) { return n[k]; }).map(function (k) { return k + '=' + encodeURIComponent(n[k]); }).join('&')); }
      var t; $('#cq').oninput = function (ev) { clearTimeout(t); var sq = renderSeq; t = setTimeout(function () { if (sq !== renderSeq) return; setQ({ q: ev.target.value }); }, 450); };
      $('#cArea').onchange = function (ev) { setQ({ area: ev.target.value }); };
      if ($('#cSp')) $('#cSp').onchange = function (ev) { setQ({ sp: ev.target.value }); };
      if ($('#cMine')) $('#cMine').onchange = function (ev) { setQ({ mine: ev.target.value }); };
      $('#cGps').onchange = function (ev) { setQ({ gps: ev.target.value }); };
      $('#cAct').onchange = function (ev) { setQ({ active: ev.target.value }); };
      var s = $('#cq'); if (q.q) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }).catch(showError);
  };

  function customerDetail(id) {
    loading('Customer', 'customers');
    API.call('customers.get', { CustomerID: id }).then(function (c) { drawCustomer(c); }).catch(function (e) { showError(e); go('customers'); });
  }

  /** Where the customer stands with QuickBooks: linked, being created by the bridge, or a problem to fix. */
  function qbCustomerState(c) {
    if (c.QBListID && (!c.QBCreateStatus || c.QBCreateStatus === 'SYNCED')) return esc(c.QBFullName) + ' <span class="badge good">Linked</span>';
    var st = c.QBCreateStatus;
    if (st === 'PENDING' || st === 'IN_PROGRESS') return '<span class="badge warn">Being created in QuickBooks</span> <small>by the bridge on the QuickBooks PC</small>';
    if (st === 'FAILED') return '<span class="badge warn">Retrying</span> <small>' + esc(c.QBCreateError) + '</small>';
    if (st === 'EXCEPTION') return '<span class="badge bad">Could not create in QuickBooks</span><br><small>' + esc(c.QBCreateError) + '</small>';
    return '<span class="badge warn">Not linked</span>';
  }

  function drawCustomer(c) {
    var hasGps = typeof c.Latitude === 'number' && c.Latitude !== '';
    var html = '<div class="card"><div style="display:flex;justify-content:space-between;gap:8px;align-items:start"><div><h2 style="margin:0">' + esc(c.ShopName) + '</h2><div style="color:var(--muted)">' + esc(c.Code) + '</div></div>' + badge(c.Active) + '</div>' +
      '<dl class="kv" style="margin-top:12px"><dt>Contact</dt><dd>' + esc(c.ContactPerson) + '</dd><dt>Mobile</dt><dd>' + (c.Mobile ? '<a href="tel:' + esc(c.Mobile) + '">' + esc(c.Mobile) + '</a>' : '') + '</dd>' +
      '<dt>WhatsApp</dt><dd>' + (c.WhatsApp ? '<a href="https://wa.me/' + esc(c.WhatsApp.replace(/^0/, '92').replace(/^\+/, '')) + '" target="_blank" rel="noopener">' + esc(c.WhatsApp) + '</a>' : '') + '</dd>' +
      '<dt>Address</dt><dd>' + esc(c.Address) + '</dd><dt>Area / City</dt><dd>' + esc(c.Area) + ', ' + esc(c.City) + '</dd><dt>Salesperson</dt><dd>' + esc(c.SalespersonName) + (c.Mine === false && State.me && State.me.salespersonId ? ' <span class="badge">another salesperson\'s shop</span>' : '') + '</dd>' +
      '<dt>Type</dt><dd>' + esc(c.CustomerType) + '</dd><dt>Credit limit</dt><dd>' + money(c.CreditLimit) + '</dd><dt>Payment terms</dt><dd>' + esc(c.PaymentTerms) + '</dd>' +
      '<dt>Outstanding</dt><dd>' + (c.QBBalanceAsOf ? money(c.QBBalance) + ' <span class="badge">as of ' + fmtDate(c.QBBalanceAsOf) + '</span>' : '<span class="badge">Not synced from QuickBooks yet</span>') + '</dd>' +
      '<dt>QuickBooks</dt><dd>' + qbCustomerState(c) + '</dd>' +
      (c.Notes ? '<dt>Notes</dt><dd>' + esc(c.Notes) + '</dd>' : '') + '</dl>' +
      '<div class="btn-row">' + (can(['customers.manage', 'customers.create.own']) ? '<a class="btn" href="#/customers/' + encodeURIComponent(c.CustomerID) + '/edit">Edit</a>' : '') +
      (c.CanMapQB ? '<button class="btn" id="qbMap">QuickBooks mapping</button>' : '') +
      (c.CanCreateInQB ? '<button class="btn" id="qbCreate">Create in QuickBooks</button>' : '') +
      (can(['orders.view.all', 'orders.view.own']) && !c.LocalPending ? '<a class="btn" href="#/reports/statement?customerId=' + encodeURIComponent(c.CustomerID) + '&customerName=' + encodeURIComponent(c.ShopName) + '">Statement</a>' : '') + '</div>' +
      ((can('visits.create') || can('orders.create')) && c.Active ? '<div class="btn-row">' + (can('visits.create') ? '<button class="btn" id="visitBtn">📍 Record visit</button>' : '') +
        (can('orders.create') ? '<a class="btn primary" href="#/orders/new?customer=' + encodeURIComponent(c.CustomerID) + '">+ New order</a>' : '') + '</div>' +
        (c.Mine === false && State.me && State.me.salespersonId ? '<p class="hint" style="font-size:12px;color:var(--muted);margin:6px 0 0">Orders and visits you record here are yours (your commission). You do not see the other salesperson\'s orders.</p>' : '') : '') + '</div>';

    html += '<div class="card"><h2>Location</h2><div class="gps-box' + (hasGps ? ' ok' : '') + '" id="gpsBox">' +
      (hasGps ? '<dl class="kv"><dt>Latitude</dt><dd>' + c.Latitude.toFixed(6) + '</dd><dt>Longitude</dt><dd>' + c.Longitude.toFixed(6) + '</dd><dt>Accuracy</dt><dd>' + Math.round(c.GPSAccuracy) + ' m</dd><dt>Captured</dt><dd>' + fmtDate(c.LocationCapturedAt) + '</dd><dt>Captured by</dt><dd>' + esc(c.LocationCapturedByName) + '</dd></dl>' +
        '<div class="btn-row"><a class="btn" target="_blank" rel="noopener" href="' + mapsView(c.Latitude, c.Longitude) + '">View on map</a><a class="btn" target="_blank" rel="noopener" href="' + mapsNav(c.Latitude, c.Longitude) + '">Navigate</a></div>'
        : '<p style="margin:0 0 6px">No GPS location saved for this customer.</p>') +
      (can('customers.location') ? '<div class="btn-row"><button class="btn primary" id="capBtn">' + (hasGps ? 'Update location' : 'Capture current location') + '</button></div><p class="hint" style="font-size:12px;color:var(--muted)">Stand at the shop entrance. The location comes from this device\'s GPS.</p>' : '') + '</div></div>';

    if (c.LocationHistory && c.LocationHistory.length) {
      html += '<div class="card"><h2>Location history</h2><div class="scroll-x"><table class="tbl"><tr><th>When</th><th>By</th><th>Old</th><th>New</th><th>Acc.</th><th>Reason</th></tr>' +
        c.LocationHistory.map(function (h) {
          var o = h.OldLatitude !== '' ? Number(h.OldLatitude).toFixed(5) + ', ' + Number(h.OldLongitude).toFixed(5) : '—';
          return '<tr><td>' + fmtDate(h.CapturedAt) + '</td><td>' + esc(h.CapturedByName) + '</td><td>' + o + '</td><td>' + Number(h.NewLatitude).toFixed(5) + ', ' + Number(h.NewLongitude).toFixed(5) + '</td><td>' + Math.round(h.Accuracy) + ' m</td><td>' + esc(h.Reason) + '</td></tr>';
        }).join('') + '</table></div></div>';
    }
    shell(c.ShopName, html, { back: 'customers' });
    if ($('#capBtn')) $('#capBtn').onclick = function () { captureFlow(c); };
    if ($('#qbMap')) $('#qbMap').onclick = function () { qbMapModal('customer', c); };
    if ($('#qbCreate')) $('#qbCreate').onclick = function () {
      var b = this; busy(b, true);
      API.call('customers.createInQb', { CustomerID: c.CustomerID }).then(function () { toast('The QuickBooks bridge will create ' + c.ShopName + ' in QuickBooks within a minute or two.'); render(); })
        .catch(function (e) { busy(b, false); showError(e); });
    };
    if ($('#visitBtn')) $('#visitBtn').onclick = function () { visitModal(c); };
  }

  function captureFlow(c) {
    var hasGps = typeof c.Latitude === 'number' && c.Latitude !== '';
    var btn = $('#capBtn'); busy(btn, true);
    getPosition().then(function (pos) {
      busy(btn, false);
      var maxAcc = State.settings.GPS_MAX_ACCURACY_M || 50, low = pos.accuracy > maxAcc;
      var moved = hasGps ? Math.round(distance(c.Latitude, c.Longitude, pos.lat, pos.lng)) : null;
      modal(hasGps ? 'Update location' : 'Save location',
        '<dl class="kv"><dt>Latitude</dt><dd>' + pos.lat.toFixed(6) + '</dd><dt>Longitude</dt><dd>' + pos.lng.toFixed(6) + '</dd><dt>Accuracy</dt><dd>' + Math.round(pos.accuracy) + ' m ' + (low ? '<span class="badge warn">weak</span>' : '<span class="badge good">good</span>') + '</dd>' +
        (moved !== null ? '<dt>Distance from saved</dt><dd>' + moved.toLocaleString() + ' m</dd>' : '') + '</dl>' +
        (low ? '<div class="alert warn" style="margin-top:12px">Accuracy is weaker than ' + maxAcc + ' m. Moving outdoors and retrying usually helps.</div>' : '') +
        (hasGps ? '<div class="field" style="margin-top:12px"><label>Reason for changing the location *</label><input type="text" id="locReason" placeholder="e.g. old pin was wrong, shop moved"><div class="ferr" data-err="Reason"></div></div>' : '') +
        '<div class="btn-row"><button class="btn primary" id="locSave">Save location</button><button class="btn" id="locRetry">Retry GPS</button><button class="btn" id="locCancel">Cancel</button></div>',
        function (m, close) {
          var clientUUID = uuid();
          $('#locCancel', m).onclick = close;
          $('#locRetry', m).onclick = function () { close(); captureFlow(c); };
          $('#locSave', m).onclick = function () {
            var b = this; busy(b, true);
            var payload = { CustomerID: c.CustomerID, ClientUUID: clientUUID, Latitude: pos.lat, Longitude: pos.lng, Accuracy: pos.accuracy, DeviceTime: new Date().toISOString(),
              Reason: hasGps ? $('#locReason', m).value.trim() : '', ConfirmLowAccuracy: low };
            API.call('customers.captureLocation', payload).then(function (fresh) { close(); toast(savedMsg(fresh, 'Location saved.')); drawCustomer(fresh); })
              .catch(function (e) { busy(b, false); fieldError(m, e); });
          };
        });
    }).catch(function (e) { busy(btn, false); showError(e); });
  }

  function distance(lat1, lng1, lat2, lng2) {
    var R = 6371008.8, r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function customerFields(c) {
    var manage = can('customers.manage');
    var f = [
      { name: 'ShopName', label: 'Shop name', required: true, span2: true },
      { name: 'ContactPerson', label: 'Owner / contact person' },
      { name: 'Mobile', label: 'Mobile', type: 'tel', required: true, placeholder: '03xxxxxxxxx' },
      { name: 'WhatsApp', label: 'WhatsApp', type: 'tel' },
      { name: 'CustomerType', label: 'Customer type', type: 'select', options: ['Retailer', 'Wholesaler', 'Supermarket', 'Bakery', 'Distributor', 'Other'].map(function (x) { return { value: x, label: x }; }) },
      { name: 'Address', label: 'Address', required: true, span2: true },
      { name: 'Area', label: 'Area', required: true, hint: (custOpts.areas || []).length ? 'Existing: ' + custOpts.areas.slice(0, 8).join(', ') : '' },
      { name: 'City', label: 'City', required: true, dflt: 'Rawalpindi' }
    ];
    if (manage) {
      f.push({ name: 'SalespersonID', label: 'Assigned salesperson', type: 'select', options: (custOpts.sp || []).map(function (s) { return { value: s.id, label: s.label }; }) });
      f.push({ name: 'CreditLimit', label: 'Credit limit (' + (State.settings.CURRENCY || 'PKR') + ')', type: 'number', dflt: 0 });
      f.push({ name: 'PaymentTerms', label: 'Payment terms', placeholder: 'e.g. Cash, 15 days' });
      f.push({ name: 'Active', label: 'Active', type: 'checkbox', dflt: true });
    }
    f.push({ name: 'Notes', label: 'Notes', type: 'textarea', span2: true });
    return f;
  }

  function customerForm(c) {
    loadCustOptions().then(function () {
      var fields = customerFields(c);
      var html = '<form class="card" id="cf">' + (!can('customers.manage') && !c ? '<div class="alert good">This customer will be assigned to you. Credit limit is set by the Sales Manager.</div>' : '') +
        formHtml(fields, c) + '<div class="btn-row"><button class="btn primary" type="submit">Save</button><a class="btn" href="#/customers' + (c ? '/' + encodeURIComponent(c.CustomerID) : '') + '">Cancel</a></div></form>';
      var root = shell(c ? 'Edit customer' : 'New customer', html, { back: c ? 'customers/' + encodeURIComponent(c.CustomerID) : 'customers' });
      var f = $('#cf', root);
      f.onsubmit = function (ev) {
        ev.preventDefault(); var b = $('button[type=submit]', f);
        var data = readForm(f, fields); if (c) { data.CustomerID = c.CustomerID; data.Version = c.Version; }
        var send = function (extra) {
          busy(b, true);
          return API.call('customers.save', Object.assign(data, extra || {})).then(function (saved) {
            custOpts.areas = null; toast(!c && saved.QBCreateStatus === 'PENDING' ? 'Customer saved. It will be created in QuickBooks automatically.' : 'Customer saved.'); go('customers/' + encodeURIComponent(saved.CustomerID));
          }).catch(function (e) {
            busy(b, false);
            if (e.code === 'DUPLICATE') return confirmBox('Possible duplicate', e.message, 'Save anyway').then(function (yes) { if (yes) send({ confirmDuplicate: true }); });
            fieldError(f, e);
          });
        };
        send();
      };
    }).catch(showError);
  }

  function qbMapModal(kind, rec) {
    var isC = kind === 'customer';
    var name = isC ? rec.ShopName : rec.Name;
    modal('QuickBooks mapping — ' + name, '<p class="hint" style="font-size:13px;color:var(--muted)">Pick the matching QuickBooks ' + (isC ? 'customer' : 'item') + '. The list comes from the QuickBooks bridge (refreshed hourly). Match on the exact record — never a look-alike name.</p>' +
      '<input type="search" id="qbq" placeholder="Search QuickBooks ' + (isC ? 'customers' : 'items') + '" value="' + esc(rec.QBFullName || name) + '" autocomplete="off"><ul class="list" id="qbres" style="margin:8px 0 14px;max-height:260px;overflow:auto"></ul>' +
      '<div class="field"><label>Chosen QuickBooks ' + (isC ? 'customer' : 'item') + '</label><input type="text" id="qbn" value="' + esc(rec.QBFullName) + '" readonly placeholder="pick one from the list above" style="background:var(--bg)"><input type="hidden" id="qbl" value="' + esc(rec.QBListID) + '"><div class="ferr" data-err="QBListID"></div><div class="ferr" data-err="QBFullName"></div></div>' +
      '<div class="btn-row"><button class="btn primary" id="qbs">Save mapping</button>' + (rec.QBListID ? '<button class="btn danger" id="qbx">Remove mapping</button>' : '') + '<button class="btn" id="qbc">Cancel</button></div>', function (m, close) {
        $('#qbc', m).onclick = close;
        var t, search = function () {
          API.call('qb.lists', { kind: isC ? 'CUSTOMER' : 'ITEM', q: $('#qbq', m).value.trim(), pageSize: 30 }).then(function (res) {
            $('#qbres', m).innerHTML = res.items.length ? res.items.map(function (x, i) {
              return '<li><a class="row" role="button" tabindex="0" style="cursor:pointer" data-x="' + i + '"><span class="main-t"><div class="t1">' + esc(x.FullName) + '</div><div class="t2">' + esc(x.ListID) + (x.ItemType ? ' · ' + esc(x.ItemType) : '') + (x.Balance !== '' && x.Balance !== undefined ? ' · balance ' + money(x.Balance) : '') + '</div></span>' +
                (x.MappedTo ? '<span class="badge warn" title="Already mapped">' + esc(x.MappedTo) + '</span>' : '') + '</a></li>';
            }).join('') : '<li><div class="row">' + (res.total === 0 && !$('#qbq', m).value ? 'No QuickBooks list imported yet. Start the bridge (it imports lists on start-up) or type the ListID below.' : 'No match. Try a shorter search.') + '</div></li>';
            $all('[data-x]', m).forEach(function (a) { a.onclick = function () { var x = res.items[Number(a.dataset.x)]; $('#qbl', m).value = x.ListID; $('#qbn', m).value = x.FullName; }; });
          }).catch(function (e) { $('#qbres', m).innerHTML = '<li><div class="row">' + esc(e.message) + '</div></li>'; });
        };
        $('#qbq', m).oninput = function () { clearTimeout(t); t = setTimeout(search, 300); };
        search();
        var save = function (listId, fullName, b) {
          busy(b, true);
          var p = { QBListID: listId, QBFullName: fullName, Version: rec.Version };
          p[isC ? 'CustomerID' : 'ProductID'] = isC ? rec.CustomerID : rec.ProductID;
          API.call(isC ? 'customers.setQbMapping' : 'products.setQbMapping', p).then(function (fresh) {
            close(); toast(listId ? 'Mapping saved. Orders waiting on this mapping were re-queued.' : 'Mapping removed.'); isC ? drawCustomer(fresh) : render();
          }).catch(function (e) { busy(b, false); fieldError(m, e); });
        };
        $('#qbs', m).onclick = function () { save($('#qbl', m).value.trim(), $('#qbn', m).value.trim(), this); };
        if ($('#qbx', m)) $('#qbx', m).onclick = function () { save('', '', this); };
      });
  }

  // ---------- views: products ----------
  var cats = null;
  VIEWS.products = function (r) {
    var q = r.q, page = Number(q.page) || 1;
    loading('Products');
    Promise.all([cats ? Promise.resolve(cats) : API.call('categories.list'), API.call('products.list', { q: q.q, categoryId: q.cat, active: q.active, qb: q.qb, review: q.review, page: page })]).then(function (res) {
      cats = res[0]; var list = res[1];
      var html = '<div class="toolbar"><input type="search" class="search" id="pq" placeholder="Search name, SKU, category" value="' + esc(q.q || '') + '">' +
        '<select id="pCat"><option value="">All categories</option>' + cats.map(function (c) { return '<option value="' + esc(c.CategoryID) + '"' + (c.CategoryID === q.cat ? ' selected' : '') + '>' + esc(c.Name) + '</option>'; }).join('') + '</select>' +
        (can('products.manage') ? '<button class="btn primary" id="pNew">+ New product</button>' : '') + '</div>';
      if (q.qb === 'unmapped') html += '<div class="alert warn">Showing products not mapped to QuickBooks. <a href="#/products">Clear</a></div>';
      if (q.review === '1') html += '<div class="alert warn">Showing products created from QuickBooks that nobody has checked yet. Open each one, check <b>units per carton</b>, unit, price and tax, and press Save. <a href="#/products">Clear</a></div>';
      html += list.items.length ? '<ul class="list">' + list.items.map(function (p, i) {
        return '<li><a class="row" role="button" tabindex="0" style="cursor:pointer" data-i="' + i + '"><span class="main-t"><div class="t1">' + esc(p.Name) + '</div><div class="t2">' + esc(p.SKU) + ' · ' + esc(p.CategoryName) + ' · ' + esc(p.Unit) + (p.PackSize ? ' ' + esc(p.PackSize) : '') + ' · ' + p.UnitsPerCarton + ' per carton · ' + money(p.WholesalePrice) + '</div></span>' +
          (p.QBListID ? '' : '<span class="badge warn">QB?</span>') + (p.Active ? '' : ' <span class="badge bad">Inactive</span>') + '</a></li>';
      }).join('') + '</ul>' : '<div class="empty card">No products found.</div>';
      var pg = pager(list, function (p) { setQ({ page: p }); });
      var root = shell('Products', html + pg.html); pg.bind(root);
      function setQ(patch) { var n = Object.assign({}, q, patch); if (!patch.page) n.page = 1; go('products?' + Object.keys(n).filter(function (k) { return n[k]; }).map(function (k) { return k + '=' + encodeURIComponent(n[k]); }).join('&')); }
      var t; $('#pq').oninput = function (ev) { clearTimeout(t); var sq = renderSeq; t = setTimeout(function () { if (sq !== renderSeq) return; setQ({ q: ev.target.value }); }, 450); };
      $('#pCat').onchange = function (ev) { setQ({ cat: ev.target.value }); };
      if ($('#pNew')) $('#pNew').onclick = function () { productModal(null); };
      $all('[data-i]', root).forEach(function (a) { a.onclick = function () { productModal(list.items[Number(a.dataset.i)]); }; });
      var s = $('#pq'); if (q.q) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }).catch(showError);
  };

  function productModal(p) {
    var edit = can('products.manage');
    var fields = [
      { name: 'SKU', label: 'SKU', required: true }, { name: 'Name', label: 'Product name', required: true },
      { name: 'CategoryID', label: 'Category', type: 'select', options: (cats || []).filter(function (c) { return c.Active; }).map(function (c) { return { value: c.CategoryID, label: c.Name }; }) },
      { name: 'Unit', label: 'Selling unit', required: true, placeholder: 'Pack, Box, Pcs…' }, { name: 'PackSize', label: 'Pack size', placeholder: 'e.g. 250g' },
      { name: 'UnitsPerCarton', label: 'Units per carton', type: 'number', required: true, hint: 'How many selling units are in ONE carton of THIS product.' },
      { name: 'WholesalePrice', label: 'Wholesale price', type: 'number', required: true }, { name: 'SalePrice', label: 'Retail / sale price', type: 'number' },
      { name: 'TaxRate', label: 'Tax rate %', type: 'number', dflt: State.settings.DEFAULT_TAX_RATE }, { name: 'Active', label: 'Active', type: 'checkbox', dflt: true }
    ].map(function (f) { if (!edit) f.readonly = true; return f; });
    modal(p ? p.Name : 'New product', '<form id="pf">' + formHtml(fields, p) +
      (p ? '<p class="hint" style="color:var(--muted);font-size:13px">QuickBooks: ' + (p.QBListID ? esc(p.QBFullName) + ' (' + esc(p.QBListID) + ')' : 'not mapped') + '</p>' : '') +
      '<div class="btn-row">' + (edit ? '<button class="btn primary" type="submit">Save</button>' : '') + (p && can('products.qbmap') ? '<button class="btn" type="button" id="pqb">QuickBooks mapping</button>' : '') + '<button class="btn" type="button" id="pc">Close</button></div></form>',
      function (m, close) {
        $('#pc', m).onclick = close;
        if ($('#pqb', m)) $('#pqb', m).onclick = function () { close(); qbMapModal('product', p); };
        var f = $('#pf', m);
        f.onsubmit = function (ev) {
          ev.preventDefault(); if (!edit) return;
          var b = $('button[type=submit]', f); busy(b, true);
          var data = readForm(f, fields); if (p) { data.ProductID = p.ProductID; data.Version = p.Version; }
          API.call('products.save', data).then(function () { close(); toast('Product saved.'); render(); }).catch(function (e) { busy(b, false); fieldError(f, e); });
        };
      });
  }

  // ---------- views: salespersons ----------
  VIEWS.salespersons = function (r) {
    loading('Salespersons');
    var page = Number(r.q.page) || 1;
    Promise.all([API.call('salespersons.list', { q: r.q.q, page: page }), API.call('territories.list'),
      can('salespersons.manage') ? API.call('users.salespersonLogins') : Promise.resolve([])]).then(function (res) {
      var list = res[0], terr = res[1], logins = res[2];
      var html = '<div class="toolbar"><input type="search" class="search" id="sq" placeholder="Search" value="' + esc(r.q.q || '') + '">' + (can('salespersons.manage') ? '<button class="btn primary" id="sNew">+ New salesperson</button>' : '') + '</div>';
      html += list.items.length ? '<ul class="list">' + list.items.map(function (s, i) {
        return '<li><a class="row" role="button" tabindex="0" style="cursor:pointer" data-i="' + i + '"><span class="main-t"><div class="t1">' + esc(s.Name) + '</div><div class="t2">' + esc(s.Code) + ' · ' + esc(s.Mobile) + ' · ' + s.ActiveCustomers + ' customers' + (s.UserID ? '' : ' · no login linked') +
          (can('qb.manage') ? ' · ' + repText(s) : '') + '</div></span>' + badge(s.Active) + '</a></li>';
      }).join('') + '</ul>' : '<div class="empty card">No salespersons yet.</div>';
      var pg = pager(list, function (p) { go('salespersons?page=' + p + (r.q.q ? '&q=' + encodeURIComponent(r.q.q) : '')); });
      var root = shell('Salespersons', html + pg.html); pg.bind(root);
      var t; $('#sq').oninput = function (ev) { clearTimeout(t); var sq = renderSeq; t = setTimeout(function () { if (sq !== renderSeq) return; go('salespersons?q=' + encodeURIComponent(ev.target.value)); }, 450); };
      var open = function (s) {
        var fields = [
          { name: 'Name', label: 'Name', required: true }, { name: 'Code', label: 'Code', hint: s ? '' : 'Leave empty to auto-generate' },
          { name: 'Mobile', label: 'Mobile', type: 'tel', required: true }, { name: 'Email', label: 'Email', type: 'email' },
          { name: 'UserID', label: 'Login (user with Salesperson role)', type: 'select', options: logins.filter(function (l) { return !l.linked || (s && l.linked === s.SalespersonID); }).map(function (l) { return { value: l.id, label: l.label }; }) },
          { name: 'TerritoryID', label: 'Territory', type: 'select', options: terr.filter(function (t) { return t.Active; }).map(function (t) { return { value: t.TerritoryID, label: t.Name }; }) },
          { name: 'Area', label: 'Area' }, { name: 'JoiningDate', label: 'Joining date', type: 'date' },
          { name: 'CommissionEligible', label: 'Eligible for commission', type: 'checkbox', dflt: true }, { name: 'Active', label: 'Active', type: 'checkbox', dflt: true }
        ].map(function (f) { if (!can('salespersons.manage')) f.readonly = true; return f; });
        var qbBox = s && can('qb.manage') ? '<div class="card" style="margin:0 0 12px;padding:12px"><b>QuickBooks Sales Rep</b><div style="margin:6px 0">' + repText(s) +
          (s.QBRepCreateStatus === 'EXCEPTION' && s.QBRepCreateError ? '<div class="alert bad" style="margin:6px 0 0">' + esc(s.QBRepCreateError) + '</div>' : '') + '</div>' +
          '<p class="hint" style="font-size:12px;color:var(--muted);margin:0 0 8px">Orders this salesperson books go to QuickBooks with this Sales Rep.</p>' +
          '<div class="btn-row" style="margin:0"><button class="btn" type="button" id="spRep">Choose Sales Rep</button>' +
          (!s.QBSalesRepListID && ['PENDING', 'IN_PROGRESS', 'FAILED'].indexOf(s.QBRepCreateStatus) < 0 ? '<button class="btn" type="button" id="spRepNew">Create in QuickBooks</button>' : '') + '</div></div>' : '';
        modal(s ? s.Name : 'New salesperson', qbBox + '<form id="sf">' + formHtml(fields, s) + '<div class="btn-row">' + (can('salespersons.manage') ? '<button class="btn primary" type="submit">Save</button>' : '') + '<button class="btn" type="button" id="sc">Close</button></div></form>', function (m, close) {
          $('#sc', m).onclick = close;
          if ($('#spRep', m)) $('#spRep', m).onclick = function () { close(); qbRepModal(s); };
          if ($('#spRepNew', m)) $('#spRepNew', m).onclick = function () {
            var b = this; busy(b, true);
            API.call('salespersons.createRepInQb', { SalespersonID: s.SalespersonID }).then(function () { close(); toast('The bridge will create the Sales Rep in QuickBooks on its next run.'); render(); }).catch(function (e) { busy(b, false); showError(e); });
          };
          var f = $('#sf', m);
          f.onsubmit = function (ev) {
            ev.preventDefault(); var b = $('button[type=submit]', f); busy(b, true);
            var d = readForm(f, fields); if (s) { d.SalespersonID = s.SalespersonID; d.Version = s.Version; }
            API.call('salespersons.save', d).then(function () { close(); custOpts.sp = null; toast('Salesperson saved.'); render(); }).catch(function (e) { busy(b, false); fieldError(f, e); });
          };
        });
      };
      if ($('#sNew')) $('#sNew').onclick = function () { open(null); };
      $all('[data-i]', root).forEach(function (a) { a.onclick = function () { open(list.items[Number(a.dataset.i)]); }; });
    }).catch(showError);
  };

  function repText(s) {
    if (s.QBSalesRepListID) return '<span class="badge good">QuickBooks rep ' + esc(s.QBSalesRepInitial) + '</span>';
    if (['PENDING', 'IN_PROGRESS', 'FAILED'].indexOf(s.QBRepCreateStatus) >= 0) return '<span class="badge warn">Sales Rep being created in QuickBooks</span>';
    if (s.QBRepCreateStatus === 'EXCEPTION') return '<span class="badge bad">Sales Rep could not be created</span>';
    return '<span class="badge">No QuickBooks Sales Rep yet</span>';
  }

  /** Links a salesperson to a Sales Rep from the QuickBooks list imported by the bridge. */
  function qbRepModal(s) {
    modal('QuickBooks Sales Rep — ' + s.Name, '<p class="hint" style="font-size:13px;color:var(--muted)">Pick this salesperson\'s Sales Rep from the QuickBooks list (imported by the bridge every hour). Orders the salesperson books are sent with this Sales Rep.</p>' +
      '<input type="search" id="qbq" placeholder="Search initials or name" value="" autocomplete="off"><ul class="list" id="qbres" style="margin:8px 0 14px;max-height:260px;overflow:auto"></ul>' +
      '<div class="field"><label>Chosen Sales Rep</label><input type="text" id="qbn" value="' + esc(s.QBSalesRepInitial || '') + '" readonly placeholder="pick one from the list above" style="background:var(--bg)"><input type="hidden" id="qbl" value="' + esc(s.QBSalesRepListID || '') + '"><div class="ferr" data-err="QBSalesRepListID"></div></div>' +
      '<div class="btn-row"><button class="btn primary" id="qbs">Save</button>' + (s.QBSalesRepListID ? '<button class="btn danger" id="qbx">Remove link</button>' : '') + '<button class="btn" id="qbc">Cancel</button></div>', function (m, close) {
        $('#qbc', m).onclick = close;
        var t, search = function () {
          API.call('qb.lists', { kind: 'SALESREP', q: $('#qbq', m).value.trim(), pageSize: 30 }).then(function (res) {
            $('#qbres', m).innerHTML = res.items.length ? res.items.map(function (x, i) {
              return '<li><a class="row" role="button" tabindex="0" style="cursor:pointer" data-x="' + i + '"><span class="main-t"><div class="t1">' + esc(x.FullName) + '</div><div class="t2">' + esc(x.ListID) + '</div></span>' +
                (x.MappedTo ? '<span class="badge warn" title="Already linked">' + esc(x.MappedTo) + '</span>' : '') + '</a></li>';
            }).join('') : '<li><div class="row">' + (!$('#qbq', m).value ? 'No Sales Rep list imported yet. Start the bridge (it imports the lists when it starts), or press Create in QuickBooks on the salesperson.' : 'No match. Try a shorter search.') + '</div></li>';
            $all('[data-x]', m).forEach(function (a) { a.onclick = function () { var x = res.items[Number(a.dataset.x)]; $('#qbl', m).value = x.ListID; $('#qbn', m).value = x.FullName; }; });
          }).catch(function (e) { $('#qbres', m).innerHTML = '<li><div class="row">' + esc(e.message) + '</div></li>'; });
        };
        $('#qbq', m).oninput = function () { clearTimeout(t); t = setTimeout(search, 300); };
        search();
        var save = function (listId, b) {
          busy(b, true);
          API.call('salespersons.setQbRep', { SalespersonID: s.SalespersonID, QBSalesRepListID: listId, Version: s.Version }).then(function () {
            close(); toast(listId ? 'Sales Rep linked. Orders waiting for it were sent to QuickBooks again.' : 'Sales Rep link removed.'); render();
          }).catch(function (e) { busy(b, false); fieldError(m, e); });
        };
        $('#qbs', m).onclick = function () { save($('#qbl', m).value.trim(), this); };
        if ($('#qbx', m)) $('#qbx', m).onclick = function () { save('', this); };
      });
  }

  // ---------- views: users ----------
  VIEWS.users = function (r) {
    loading('Users');
    Promise.all([API.call('users.list', { q: r.q.q, page: Number(r.q.page) || 1 }), API.call('roles.list')]).then(function (res) {
      var list = res[0], roles = res[1];
      var rn = {}; roles.forEach(function (x) { rn[x.RoleCode] = x.RoleName; });
      var html = '<div class="toolbar"><input type="search" class="search" id="uq" placeholder="Search users" value="' + esc(r.q.q || '') + '"><button class="btn primary" id="uNew">+ New user</button></div>';
      html += '<ul class="list">' + list.items.map(function (u, i) {
        return '<li><a class="row" role="button" tabindex="0" style="cursor:pointer" data-i="' + i + '"><span class="main-t"><div class="t1">' + esc(u.FullName) + '</div><div class="t2">' + esc(u.Username) + ' · ' + esc(rn[u.RoleCode] || u.RoleCode) + (u.LastLoginAt ? ' · last login ' + fmtDate(u.LastLoginAt) : ' · never logged in') + '</div></span>' +
          (u.LockedUntil && new Date(u.LockedUntil) > new Date() ? '<span class="badge warn">Locked</span> ' : '') + badge(u.Active) + '</a></li>';
      }).join('') + '</ul>';
      var pg = pager(list, function (p) { go('users?page=' + p); });
      var root = shell('Users', html + pg.html); pg.bind(root);
      var t; $('#uq').oninput = function (ev) { clearTimeout(t); var sq = renderSeq; t = setTimeout(function () { if (sq !== renderSeq) return; go('users?q=' + encodeURIComponent(ev.target.value)); }, 450); };
      var open = function (u) {
        var fields = [
          { name: 'FullName', label: 'Full name', required: true }, { name: 'Username', label: 'Username', required: true, hint: 'Lower-case letters, numbers, dot, dash' },
          { name: 'RoleCode', label: 'Role', type: 'select', required: true, options: roles.map(function (x) { return { value: x.RoleCode, label: x.RoleName }; }) },
          { name: 'Mobile', label: 'Mobile', type: 'tel' }, { name: 'Email', label: 'Email', type: 'email' }, { name: 'Active', label: 'Active', type: 'checkbox', dflt: true }
        ];
        modal(u ? u.FullName : 'New user', '<form id="uf">' + formHtml(fields, u) + (u && u.RoleCode === 'SALESPERSON' ? '<p class="hint" style="font-size:13px;color:var(--muted)">Linked salesperson: ' + esc(u.LinkedSalespersonID || 'none — link it on the Salespersons screen') + '</p>' : '') +
          '<div class="btn-row"><button class="btn primary" type="submit">Save</button>' + (u ? '<button class="btn" type="button" id="urs">Reset password</button>' : '') + '<button class="btn" type="button" id="uc">Close</button></div></form>', function (m, close) {
          $('#uc', m).onclick = close;
          var f = $('#uf', m);
          if ($('#urs', m)) $('#urs', m).onclick = function () {
            confirmBox('Reset password', 'Reset the password for ' + u.FullName + '? They will be signed out everywhere.', 'Reset').then(function (y) {
              if (!y) return;
              API.call('users.resetPassword', { UserID: u.UserID }).then(function (r2) { close(); showSecret('Temporary password', 'New temporary password for ' + u.Username + ':', r2.tempPassword); }).catch(showError);
            });
          };
          f.onsubmit = function (ev) {
            ev.preventDefault(); var b = $('button[type=submit]', f); busy(b, true);
            var d = readForm(f, fields); if (u) { d.UserID = u.UserID; d.Version = u.Version; }
            API.call('users.save', d).then(function (res2) {
              close(); toast('User saved.'); render();
              if (res2.tempPassword) showSecret('User created', 'Temporary password for ' + res2.user.Username + ':', res2.tempPassword);
            }).catch(function (e) { busy(b, false); fieldError(f, e); });
          };
        });
      };
      $('#uNew').onclick = function () { open(null); };
      $all('[data-i]', root).forEach(function (a) { a.onclick = function () { open(list.items[Number(a.dataset.i)]); }; });
    }).catch(showError);
  };

  // ---------- views: settings ----------
  VIEWS.settings = function () {
    loading('Settings');
    Promise.all([API.call('settings.list'), API.call('territories.list'), API.call('categories.list')]).then(function (res) {
      var settings = res[0], terr = res[1], categories = res[2];
      var html = '<form class="card" id="stf"><h2>System settings</h2>' + settings.map(function (s) {
        var input;
        if (s.Locked) input = '<input type="text" value="' + esc(s.Value) + '" disabled>';
        else if (s.Type === 'enum') input = '<select name="' + s.Key + '">' + s.Options.map(function (o) { return '<option' + (o === s.Value ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select>';
        else if (s.Type === 'b') input = '<select name="' + s.Key + '"><option value="true"' + (s.Value === 'true' ? ' selected' : '') + '>Yes</option><option value="false"' + (s.Value !== 'true' ? ' selected' : '') + '>No</option></select>';
        else input = '<input type="' + (s.Type === 'n' ? 'number' : 'text') + '" name="' + s.Key + '" value="' + esc(s.Value) + '"' + (s.Type === 'n' ? ' step="any"' : '') + '>';
        return '<div class="field"><label>' + esc(s.Key.replace(/_/g, ' ').toLowerCase().replace(/^./, function (c) { return c.toUpperCase(); })) + '</label>' + input + '<div class="hint">' + esc(s.Description) + (s.Locked ? ' — fixed by design' : '') + '</div><div class="ferr" data-err="' + s.Key + '"></div></div>';
      }).join('') + '<button class="btn primary" type="submit">Save settings</button></form>';
      html += '<div class="card"><h2>Territories</h2><ul class="list">' + (terr.map(function (t, i) { return '<li><a class="row" role="button" tabindex="0" style="cursor:pointer" data-t="' + i + '"><span class="main-t"><div class="t1">' + esc(t.Name) + '</div><div class="t2">' + esc(t.Area) + ' ' + esc(t.City) + '</div></span>' + badge(t.Active) + '</a></li>'; }).join('') || '<li><div class="row">None yet</div></li>') + '</ul><div class="btn-row"><button class="btn" id="tNew">+ Territory</button></div></div>';
      html += '<div class="card"><h2>Product categories</h2><ul class="list">' + (categories.map(function (t, i) { return '<li><a class="row" role="button" tabindex="0" style="cursor:pointer" data-c="' + i + '"><span class="main-t"><div class="t1">' + esc(t.Name) + '</div></span>' + badge(t.Active) + '</a></li>'; }).join('') || '<li><div class="row">None yet</div></li>') + '</ul><div class="btn-row"><button class="btn" id="cNew">+ Category</button></div></div>';
      var root = shell('Settings', html);
      mapsKeyCard(root);
      var f = $('#stf', root);
      f.onsubmit = function (ev) {
        ev.preventDefault(); var changes = {};
        settings.forEach(function (s) { if (s.Locked) return; var el = f[s.Key]; if (el && String(el.value) !== String(s.Value)) changes[s.Key] = el.value; });
        if (!Object.keys(changes).length) return toast('No changes.');
        var b = $('button[type=submit]', f); busy(b, true);
        API.call('settings.save', { changes: changes }).then(function () { toast('Settings saved.'); return API.call('auth.me'); }).then(function (d) { State.settings = d.settings; render(); })
          .catch(function (e) { busy(b, false); fieldError(f, e); });
      };
      var masterModal = function (kind, rec) {
        var isT = kind === 'territory';
        var fields = isT ? [{ name: 'Name', label: 'Name', required: true }, { name: 'Area', label: 'Area' }, { name: 'City', label: 'City' }, { name: 'Active', label: 'Active', type: 'checkbox', dflt: true }]
          : [{ name: 'Name', label: 'Name', required: true }, { name: 'Active', label: 'Active', type: 'checkbox', dflt: true }];
        modal((rec ? 'Edit ' : 'New ') + kind, '<form id="mf">' + formHtml(fields, rec) + '<div class="btn-row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" id="mc">Cancel</button></div></form>', function (m, close) {
          $('#mc', m).onclick = close; var mf = $('#mf', m);
          mf.onsubmit = function (ev) {
            ev.preventDefault(); var b = $('button[type=submit]', mf); busy(b, true); var d = readForm(mf, fields);
            if (rec) d[isT ? 'TerritoryID' : 'CategoryID'] = rec[isT ? 'TerritoryID' : 'CategoryID'];
            API.call(isT ? 'territories.save' : 'categories.save', d).then(function () { close(); cats = null; toast('Saved.'); render(); }).catch(function (e) { busy(b, false); fieldError(mf, e); });
          };
        });
      };
      $('#tNew').onclick = function () { masterModal('territory', null); };
      $('#cNew').onclick = function () { masterModal('category', null); };
      $all('[data-t]', root).forEach(function (a) { a.onclick = function () { masterModal('territory', terr[Number(a.dataset.t)]); }; });
      $all('[data-c]', root).forEach(function (a) { a.onclick = function () { masterModal('category', categories[Number(a.dataset.c)]); }; });
    }).catch(showError);
  };

  // ---------- views: audit & backups ----------
  VIEWS.audit = function (r) {
    loading('Audit log');
    var q = r.q;
    API.call(q.view === 'errors' ? 'audit.errors' : 'audit.list', { q: q.q, action: q.action, page: Number(q.page) || 1 }).then(function (list) {
      var errors = q.view === 'errors';
      var html = '<div class="toolbar">' + (errors ? '' : '<input type="search" class="search" id="aq" placeholder="Search user, record, action" value="' + esc(q.q || '') + '">') +
        '<a class="btn" href="#/audit' + (errors ? '' : '?view=errors') + '">' + (errors ? 'Show audit log' : 'Show server errors') + '</a></div>';
      html += '<div class="card scroll-x"><table class="tbl">' + (errors
        ? '<tr><th>When</th><th>Ref</th><th>Action</th><th>Message</th></tr>' + list.items.map(function (e) { return '<tr><td>' + fmtDate(e.At) + '</td><td>' + esc(e.ErrorID) + '</td><td>' + esc(e.Action) + '</td><td>' + esc(e.Message) + '</td></tr>'; }).join('')
        : '<tr><th>When</th><th>User</th><th>Action</th><th>Record</th><th>Change</th></tr>' + list.items.map(function (a) {
          return '<tr><td>' + fmtDate(a.At) + '</td><td>' + esc(a.Username) + '</td><td>' + esc(a.Action) + '</td><td>' + esc(a.Entity) + '<br><small>' + esc(a.RecordID) + '</small></td><td><small>' +
            (a.OldValue ? '<b>Old:</b> ' + esc(a.OldValue) + '<br>' : '') + (a.NewValue ? '<b>New:</b> ' + esc(a.NewValue) : '') + (a.Detail ? '<br>' + esc(a.Detail) : '') + '</small></td></tr>';
        }).join('')) + '</table>' + (list.items.length ? '' : '<div class="empty">Nothing recorded.</div>') + '</div>';
      var pg = pager(list, function (p) { go('audit?page=' + p + (errors ? '&view=errors' : '') + (q.q ? '&q=' + encodeURIComponent(q.q) : '')); });
      var root = shell('Audit log', html + pg.html); pg.bind(root);
      var t; if ($('#aq')) $('#aq').oninput = function (ev) { clearTimeout(t); var sq = renderSeq; t = setTimeout(function () { if (sq !== renderSeq) return; go('audit?q=' + encodeURIComponent(ev.target.value)); }, 500); };
    }).catch(showError);
  };

  VIEWS.backups = function () {
    loading('Backups');
    API.call('backup.list', {}).then(function (list) {
      if (list.supabase) {   // Supabase version: the database backups are made by Supabase
        shell('Backups', '<div class="card"><h2>Backups</h2><p>' + esc(list.note) + '</p></div>');
        return;
      }
      var html = '<div class="card"><p>A copy of the database is saved to a private Google Drive folder every night at 02:00 (Pakistan time). You can also take one now.</p><button class="btn primary" id="bNow">Back up now</button></div>' +
        '<div class="card scroll-x"><table class="tbl"><tr><th>When</th><th>File</th><th>Status</th></tr>' + list.items.map(function (b) {
          return '<tr><td>' + fmtDate(b.At) + '</td><td>' + esc(b.FileName) + '</td><td>' + (b.Status === 'OK' ? '<span class="badge good">OK</span>' : '<span class="badge bad">' + esc(b.Status) + '</span> ' + esc(b.Message)) + '</td></tr>';
        }).join('') + '</table>' + (list.items.length ? '' : '<div class="empty">No backups yet.</div>') + '</div>';
      var root = shell('Backups', html);
      $('#bNow', root).onclick = function () { var b = this; busy(b, true); API.call('backup.run').then(function (r) { toast('Backup saved: ' + r.fileName); render(); }).catch(function (e) { busy(b, false); showError(e); }); };
    }).catch(showError);
  };

  // ---------- views: visits ----------
  var VISIT_TYPES = [['ORDER', 'Order booking'], ['FOLLOW_UP', 'Follow-up'], ['COLLECTION', 'Payment collection'], ['NEW_CUSTOMER', 'New customer'], ['COMPLAINT', 'Complaint'], ['OTHER', 'Other']];
  function visitTypeLabel(t) { var x = VISIT_TYPES.filter(function (v) { return v[0] === t; })[0]; return x ? x[1] : t; }
  function gpsBadge(st, dist) {
    if (st === 'VERIFIED') return '<span class="badge good">At shop · ' + dist + ' m</span>';
    if (st === 'NEAR') return '<span class="badge warn">' + dist + ' m from shop</span>';
    if (st === 'MISMATCH') return '<span class="badge bad">' + (dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : dist + ' m') + ' from shop</span>';
    return '<span class="badge">Shop GPS not saved</span>';
  }

  function visitModal(c) {
    modal('Record visit — ' + c.ShopName, '<div class="field"><label>Visit type</label><select id="vType">' + VISIT_TYPES.map(function (v) { return '<option value="' + v[0] + '">' + v[1] + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>Remarks</label><textarea id="vRem" placeholder="Optional"></textarea></div><p class="hint" id="vGps" style="color:var(--muted);font-size:13px">Your GPS position is recorded with the visit.</p>' +
      '<div class="btn-row"><button class="btn primary" id="vSave">Save visit</button>' + (can('orders.create') ? '<button class="btn" id="vSaveOrder">Save &amp; take order</button>' : '') + '<button class="btn" id="vCancel">Cancel</button></div>', function (m, close) {
        var clientUUID = uuid();
        $('#vCancel', m).onclick = close;
        var doSave = function (thenOrder, btn) {
          busy(btn, true); $('#vGps', m).textContent = 'Getting GPS position…';
          getPosition().then(function (pos) {
            return API.call('visits.create', { ClientUUID: clientUUID, CustomerID: c.CustomerID, VisitType: $('#vType', m).value, Remarks: $('#vRem', m).value,
              Latitude: pos.lat, Longitude: pos.lng, Accuracy: pos.accuracy, DeviceTime: new Date().toISOString() });
          }).then(function (v) {
            close(); toast(savedMsg(v, 'Visit recorded.'));
            if (thenOrder) go('orders/new?customer=' + encodeURIComponent(c.CustomerID) + '&visit=' + encodeURIComponent(v.VisitID));
          }).catch(function (e) { busy(btn, false); $('#vGps', m).textContent = ''; showError(e); });
        };
        $('#vSave', m).onclick = function () { doSave(false, this); };
        if ($('#vSaveOrder', m)) $('#vSaveOrder', m).onclick = function () { doSave(true, this); };
      });
  }

  VIEWS.visits = function (r) {
    var q = r.q, today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
    var from = q.from || today, to = q.to || today;
    loading('Visits');
    var all = can('visits.view.all');
    Promise.all([API.call('visits.list', { from: from, to: to, salespersonId: q.sp, orderTaken: q.ot, page: Number(q.page) || 1 }),
      all ? (custOpts.sp ? Promise.resolve(custOpts.sp) : API.call('salespersons.options')) : Promise.resolve(null)]).then(function (res) {
      var list = res[0]; if (res[1]) custOpts.sp = res[1];
      var s = list.summary;
      var html = '<div class="toolbar"><input type="date" id="vFrom" value="' + esc(from) + '"><input type="date" id="vTo" value="' + esc(to) + '">' +
        (all ? '<select id="vSp"><option value="">All salespersons</option>' + custOpts.sp.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === q.sp ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('') + '</select>' : '') +
        '<select id="vOt"><option value="">All visits</option><option value="true"' + (q.ot === 'true' ? ' selected' : '') + '>With order</option><option value="false"' + (q.ot === 'false' ? ' selected' : '') + '>Without order</option></select></div>' +
        '<div class="grid" style="margin-bottom:14px">' + [['Visits', s.visits], ['Customers visited', s.customersVisited], ['With order', s.customersWithOrder], ['Without order', s.customersWithoutOrder], ['GPS mismatch', s.gpsMismatch]]
          .map(function (x) { return '<div class="stat"><div class="v">' + x[1] + '</div><div class="l">' + x[0] + '</div></div>'; }).join('') + '</div>';
      html += list.items.length ? '<ul class="list">' + list.items.map(function (v) {
        return '<li><a class="row" href="#/customers/' + encodeURIComponent(v.CustomerID) + '"><span class="main-t"><div class="t1">' + esc(v.CustomerName) + '</div><div class="t2">' + fmtDate(v.VisitAt) + ' · ' + esc(visitTypeLabel(v.VisitType)) + (all ? ' · ' + esc(v.SalespersonName) : '') + (v.Remarks ? ' · ' + esc(v.Remarks) : '') + '</div></span>' +
          gpsBadge(v.GPSStatus, v.DistanceFromCustomerM) + ' ' + (v.OrderTaken ? '<span class="badge good">Order</span>' : '<span class="badge">No order</span>') + (v.Local ? ' <span class="badge warn">Waiting to send</span>' : '') + '</a></li>';
      }).join('') + '</ul>' : '<div class="empty card">No visits in this period.' + (can('visits.create') ? ' Open a customer and tap “Record visit”.' : '') + '</div>';
      var pg = pager(list, function (p) { setQ({ page: p }); });
      var root = shell('Visits', html + pg.html); pg.bind(root);
      function setQ(patch) { var n = Object.assign({ from: from, to: to }, q, patch); if (!patch.page) n.page = 1; go('visits?' + Object.keys(n).filter(function (k) { return n[k]; }).map(function (k) { return k + '=' + encodeURIComponent(n[k]); }).join('&')); }
      $('#vFrom').onchange = function (ev) { setQ({ from: ev.target.value }); };
      $('#vTo').onchange = function (ev) { setQ({ to: ev.target.value }); };
      $('#vOt').onchange = function (ev) { setQ({ ot: ev.target.value }); };
      if ($('#vSp')) $('#vSp').onchange = function (ev) { setQ({ sp: ev.target.value }); };
    }).catch(showError);
  };

  // ---------- views: orders ----------
  var ORDER_LABELS = { DRAFT: 'Draft', SUBMITTED: 'Submitted', APPROVED: 'Approved', QB_SYNC_PENDING: 'QB sync pending', QB_SYNCED: 'QB synced',
    READY_FOR_DELIVERY: 'Ready for delivery', ASSIGNED_TO_VAN: 'Assigned to van', OUT_FOR_DELIVERY: 'Out for delivery', DELIVERED: 'Delivered',
    PARTIALLY_DELIVERED: 'Partially delivered', CANCELLED: 'Cancelled', RETURNED: 'Returned' };
  function statusBadge(st) {
    if (st === 'PENDING_SYNC') return '<span class="badge warn">Waiting to send</span>';
    var cls = { DRAFT: '', SUBMITTED: 'warn', CANCELLED: 'bad', RETURNED: 'bad', DELIVERED: 'good', QB_SYNCED: 'good', READY_FOR_DELIVERY: 'good' }[st];
    return '<span class="badge ' + (cls || '') + '">' + esc(ORDER_LABELS[st] || st) + '</span>';
  }
  function creditBadge(cs) {
    if (cs === 'EXCEEDED') return '<span class="badge bad">Credit exceeded</span>';
    if (cs === 'NO_LIMIT_SET') return '<span class="badge warn">No credit limit</span>';
    return '';
  }
  function creditPanel(cr) {
    if (!cr) return '';
    var st = cr.status === 'OK' ? '<div class="alert good">Within credit limit</div>' : cr.status === 'EXCEEDED' ? '<div class="alert bad"><b>CREDIT LIMIT EXCEEDED</b> — needs approval by a user with credit-override rights.</div>'
      : '<div class="alert warn">No credit limit set for this customer — needs credit-override approval.</div>';
    if (cr.estimated) st += '<p class="hint" style="font-size:12px;color:var(--muted)">Offline estimate from data saved ' + esc(ago(cr.asOf)) + '. The office checks credit again when the order is sent.</p>';
    return st + '<dl class="kv"><dt>Credit limit</dt><dd>' + money(cr.creditLimit) + '</dd>' +
      '<dt>QuickBooks balance</dt><dd>' + (cr.qbBalance === null ? '<span class="badge">Not synced yet</span>' : money(cr.qbBalance) + ' <span class="badge">as of ' + fmtDate(cr.qbBalanceAsOf) + '</span>') + '</dd>' +
      '<dt>Open orders</dt><dd>' + money(cr.openOrdersValue) + ' (' + cr.openOrdersCount + ')</dd><dt>Available</dt><dd>' + money(cr.available) + '</dd>' +
      '<dt>This order</dt><dd>' + money(cr.newOrder) + '</dd><dt>Available after</dt><dd style="font-weight:700;color:' + (cr.availableAfter < 0 ? 'var(--bad)' : 'inherit') + '">' + money(cr.availableAfter) + '</dd>' +
      (cr.paymentTerms ? '<dt>Payment terms</dt><dd>' + esc(cr.paymentTerms) + '</dd>' : '') + '</dl>';
  }

  VIEWS.orders = function (r) {
    if (r.seg[1] === 'new') return orderForm(null, r.q);
    if (r.seg[1] && r.seg[2] === 'edit') return API.call('orders.get', { OrderID: r.seg[1] }).then(function (o) { orderForm(o, {}); }).catch(showError);
    if (r.seg[1] && r.seg[2] === 'print') return orderPrint(r.seg[1]);
    if (r.seg[1]) return orderDetail(r.seg[1]);
    var q = r.q;
    loading('Orders');
    API.call('orders.list', { q: q.q, status: q.status, from: q.from, to: q.to, credit: q.credit, price: q.price, page: Number(q.page) || 1 }).then(function (list) {
      var html = '<div class="toolbar"><input type="search" class="search" id="oq" placeholder="Order no. or customer" value="' + esc(q.q || '') + '">' +
        '<select id="oSt"><option value="">All statuses</option>' + Object.keys(ORDER_LABELS).map(function (k) { return '<option value="' + k + '"' + (q.status === k ? ' selected' : '') + '>' + ORDER_LABELS[k] + '</option>'; }).join('') + '</select>' +
        '<input type="date" id="oFrom" value="' + esc(q.from || '') + '" title="From"><input type="date" id="oTo" value="' + esc(q.to || '') + '" title="To">' +
        (can('orders.create') ? '<a class="btn primary" href="#/orders/new">+ New order</a>' : '') + '</div>';
      if (q.credit === 'exception') html += '<div class="alert warn">Showing submitted orders with credit exceptions. <a href="#/orders">Clear</a></div>';
      if (q.price === 'below') html += '<div class="alert warn">Showing submitted orders with prices below the catalogue (need approval). <a href="#/orders">Clear</a></div>';
      html += '<p style="margin:0 0 8px;color:var(--muted);font-size:14px">' + list.total + ' orders · total ' + money(list.totalValue) + '</p>';
      html += list.items.length ? '<ul class="list">' + list.items.map(function (o) {
        return '<li><a class="row" href="#/orders/' + encodeURIComponent(o.OrderID) + '"><span class="main-t"><div class="t1">' + esc(o.CustomerName) + '</div><div class="t2">' + esc(o.OrderNo) + ' · ' + fmtDate(o.OrderDate, false) + (can('orders.view.all') ? ' · ' + esc(o.SalespersonName) : '') + '</div></span>' +
          '<span style="text-align:right"><div style="font-weight:700;white-space:nowrap">' + (o.Local ? '≈ ' : '') + money(o.NetAmount) + '</div>' + (o.Failed ? '<span class="badge bad">Not accepted</span>' : statusBadge(o.Status)) + (o.Archived ? ' <span class="badge">Archived</span>' : '') + ' ' + creditBadge(o.Status === 'SUBMITTED' ? o.CreditStatus : '') + (o.Status === 'SUBMITTED' && o.PriceStatus === 'BELOW_LIST' ? ' <span class="badge warn">Price below list</span>' : '') + '</span></a></li>';
      }).join('') + '</ul>' : '<div class="empty card">No orders found.</div>';
      var pg = pager(list, function (p) { setQ({ page: p }); });
      var root = shell('Orders', html + pg.html); pg.bind(root);
      function setQ(patch) { var n = Object.assign({}, q, patch); if (!patch.page) n.page = 1; go('orders?' + Object.keys(n).filter(function (k) { return n[k]; }).map(function (k) { return k + '=' + encodeURIComponent(n[k]); }).join('&')); }
      var t; $('#oq').oninput = function (ev) { clearTimeout(t); var sq = renderSeq; t = setTimeout(function () { if (sq !== renderSeq) return; setQ({ q: ev.target.value }); }, 450); };
      $('#oSt').onchange = function (ev) { setQ({ status: ev.target.value, credit: '' }); };
      $('#oFrom').onchange = function (ev) { setQ({ from: ev.target.value }); };
      $('#oTo').onchange = function (ev) { setQ({ to: ev.target.value }); };
      var s = $('#oq'); if (q.q) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }).catch(showError);
  };

  /** Line discount as the server calculates it: PKR for the whole line ('AMT') or a percentage ('PCT'). */
  function lineDiscount(l, gross) {
    if (l.DiscountMode === 'AMT') return Math.min(Math.round((Number(l.DiscountAmount) || 0) * 100) / 100, gross);
    return gross * (Number(l.DiscountPct) || 0) / 100;
  }
  /** Mirrors the server formula for an on-screen estimate (price per carton; catalogue price when none typed). The server's figures are final. */
  function previewLine(l) {
    var p = l.product, upc = Number(p.UnitsPerCarton), qty = (Number(l.Cartons) || 0) * upc + (Number(l.LooseUnits) || 0);
    var r2 = function (n) { return Math.round((n + Number.EPSILON) * 100) / 100; };
    var listRate = Number(p.WholesalePrice) || 0, listCtn = r2(listRate * upc);
    var cp = l.CartonPrice === undefined || l.CartonPrice === null || l.CartonPrice === '' ? listCtn : r2(Number(l.CartonPrice) || 0);
    var gross = r2(cp === listCtn ? qty * listRate : qty * cp / upc), disc = lineDiscount(l, gross), tax = (gross - r2(disc)) * (Number(p.TaxRate) || 0) / 100;
    var maxDrop = Number(State.settings.MAX_PRICE_DROP_PCT) || 0, drop = listCtn > 0 ? (listCtn - cp) / listCtn * 100 : 0;
    return { qty: qty, cartons: qty / upc, gross: gross, disc: r2(disc), tax: r2(tax), net: r2(gross - r2(disc) + r2(tax)),
      cartonPrice: cp, listCtn: listCtn, belowList: drop > maxDrop + 1e-9 };
  }

  function orderForm(o, q) {
    var st = {
      clientUUID: uuid(), customer: null, visitId: o ? o.VisitID : (q.visit || ''), remarks: o ? o.Remarks : '',
      // the products chosen for this order (from the searchable product list), keyed by ProductID, in the order they were added;
      // only rows with a quantity become order lines
      items: {}, added: [], catalogue: null, categories: [], filter: '',
      gps: null, credit: null,
      // the salesperson who took the order owns it (commission, QuickBooks Sales Rep). A salesperson's login books for themself;
      // an office user chooses, starting from the shop's own salesperson.
      office: !(State.me && State.me.salespersonId), spId: o ? o.SalespersonID : '', spOptions: null
    };
    if (o) o.Lines.forEach(function (l) {
      var upc = l.UnitsPerCarton, full = Math.floor(l.Quantity / upc + 1e-9);
      st.items[l.ProductID] = { product: { ProductID: l.ProductID, Name: l.ProductName, SKU: l.SKU, Unit: l.Unit, UnitsPerCarton: upc, WholesalePrice: l.ListRate !== '' && l.ListRate !== undefined ? l.ListRate : l.Rate, TaxRate: l.TaxRate },
        Cartons: full, LooseUnits: Math.round((l.Quantity - full * upc) * 1000) / 1000, CartonPrice: l.CartonPrice !== '' && l.CartonPrice !== undefined ? l.CartonPrice : Math.round(l.Rate * upc * 100) / 100,
        DiscountMode: l.DiscountMode === 'PCT' ? 'PCT' : 'AMT', DiscountPct: l.DiscountPct, DiscountAmount: l.DiscountMode === 'PCT' ? '' : (l.DiscountAmount || 0), more: !!(Number(l.DiscountAmount) || l.Quantity % upc) };
      if (st.added.indexOf(l.ProductID) < 0) st.added.push(l.ProductID);
    });
    function lines() { return Object.keys(st.items).map(function (k) { return st.items[k]; }).filter(function (it) { return previewLine(it).qty > 0; }); }
    var title = o ? 'Edit ' + o.OrderNo : 'New order';
    if (st.office) (custOpts.sp ? Promise.resolve(custOpts.sp) : API.call('salespersons.options')).then(function (s) { custOpts.sp = s; st.spOptions = s; if (st.customer) draw(); }).catch(function () { st.spOptions = []; });
    var root = shell(title, '<div id="ofBody"><div class="spinner">Loading…</div></div>', { back: o ? 'orders/' + encodeURIComponent(o.OrderID) : 'orders' });
    // attach device GPS to the order when available (never blocks the order)
    if (!o) getPosition().then(function (pos) { st.gps = pos; }).catch(function () { st.gps = null; });

    var custId = o ? o.CustomerID : q.customer;
    (custId ? API.call('customers.get', { CustomerID: custId }) : Promise.resolve(null)).then(function (c) { setCustomer(c); draw(); }).catch(function (e) { showError(e); draw(); });
    function setCustomer(c) { st.customer = c; if (c && st.office && !o) st.spId = c.SalespersonID || ''; }

    function draw() {
      var body = $('#ofBody', root); if (!body) return;
      var html = '';
      if (!st.customer) {
        html += '<div class="card"><h2>1. Customer</h2><input type="search" id="custSearch" placeholder="Search customer name, code, phone, area" autocomplete="off"><ul class="list" id="custResults" style="margin-top:8px"></ul></div>';
      } else {
        var c = st.customer;
        html += '<div class="card"><div style="display:flex;justify-content:space-between;gap:8px"><div><b>' + esc(c.ShopName) + '</b><div style="color:var(--muted);font-size:14px">' + esc(c.Code) + ' · ' + esc(c.Address) + ', ' + esc(c.Area) + '</div>' +
          '<div style="font-size:13px;margin-top:4px">' + (typeof c.Latitude === 'number' ? '<span class="badge good">Shop GPS saved</span>' : '<span class="badge warn">Shop GPS missing</span>') + (st.visitId ? ' <span class="badge good">Linked to visit</span>' : '') + '</div></div>' +
          (o ? '' : '<button class="btn" id="chgCust">Change</button>') + '</div>' +
          (st.office ? '<div class="field" style="margin:12px 0 0"><label for="oSp">Salesperson who took this order *</label><select id="oSp"><option value="">— choose —</option>' +
            (st.spOptions || (st.spId ? [{ id: st.spId, label: (o && o.SalespersonName) || c.SalespersonName || st.spId }] : [])).map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === st.spId ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('') +
            '</select><small style="color:var(--muted)">' + (c.SalespersonName ? 'Shop\'s salesperson: ' + esc(c.SalespersonName) + '. ' : 'This shop has no salesperson. ') + 'Commission and the QuickBooks Sales Rep go to the salesperson chosen here.</small></div>' : '') + '</div>';
        html += '<div class="card"><h2>2. Products</h2><p class="hint" style="font-size:13px;color:var(--muted);margin:0 0 8px">Choose a product, then enter the <b>cartons</b>. The price per carton is the list price; change it if you agreed another price (a lower price needs the manager\'s approval).</p>' +
          '<div class="field" style="margin:0"><label for="prodSearch">Add a product</label>' +
          '<input type="search" id="prodSearch" placeholder="Search product name or SKU" autocomplete="off" value="' + esc(st.filter) + '">' +
          '<select id="prodPick" aria-label="Product" style="margin-top:6px"><option value="">Loading products…</option></select></div>' +
          '<div id="catBox" style="margin-top:10px"></div>' +
          '<div class="cat-bar" id="catBar"></div></div>';
        html += '<div class="card"><h2>3. Review</h2><div id="totBox"></div><div class="field" style="margin-top:12px"><label>Remarks</label><textarea id="oRem" placeholder="Delivery instructions, notes">' + esc(st.remarks) + '</textarea></div><div id="credBox"></div>' +
          '<div class="btn-row"><button class="btn" id="saveDraft">Save draft</button><button class="btn primary" id="submitOrder">Submit order</button></div>' +
          '<p class="hint" style="font-size:12px;color:var(--muted)">Amounts shown are calculated again by the server when you save.</p></div>';
      }
      body.innerHTML = html;
      if (!st.customer) return bindCustomerSearch();
      if ($('#chgCust', body)) $('#chgCust', body).onclick = function () { st.customer = null; st.credit = null; draw(); };
      if ($('#oSp', body)) $('#oSp', body).onchange = function (ev) { st.spId = ev.target.value; };
      drawCatalogue();
      $('#oRem', body).oninput = function (ev) { st.remarks = ev.target.value; };
      $('#saveDraft', body).onclick = function () { send(false, this); };
      $('#submitOrder', body).onclick = function () { send(true, this); };
    }

    function bindCustomerSearch() {
      var inp = $('#custSearch', root), t;
      var run = function () {
        API.call('customers.list', { q: inp.value, active: 'true', pageSize: 15 }).then(function (res) {
          $('#custResults', root).innerHTML = res.items.map(function (c, i) { return '<li><a class="row" role="button" tabindex="0" style="cursor:pointer" data-c="' + i + '"><span class="main-t"><div class="t1">' + esc(c.ShopName) + '</div><div class="t2">' + esc(c.Code) + ' · ' + esc(c.Area) + ' · ' + esc(c.Mobile) + '</div></span></a></li>'; }).join('') || '<li><div class="row">No matching customers</div></li>';
          $all('[data-c]', root).forEach(function (a) { a.onclick = function () {
            API.call('customers.get', { CustomerID: res.items[Number(a.dataset.c)].CustomerID }).then(function (c) { setCustomer(c); draw(); }).catch(showError);
          }; });
        }).catch(showError);
      };
      inp.oninput = function () { clearTimeout(t); t = setTimeout(run, 350); };
      inp.focus(); run();
    }

    /** The whole active catalogue (from the phone's offline copy when there is no signal), grouped by category. */
    function loadCatalogue() {
      if (st.catalogue) return Promise.resolve(st.catalogue);
      var all = [], page = function (n) {
        return API.call('products.list', { active: 'true', pageSize: 200, page: n }).then(function (r) { all = all.concat(r.items); return n < (r.pages || 1) ? page(n + 1) : all; });
      };
      return Promise.all([page(1), API.call('categories.list').catch(function () { return []; })]).then(function (res) {
        st.categories = res[1] || []; st.catalogue = res[0];
        // products already on a draft that are no longer in the catalogue still show (the server tells if they cannot be ordered)
        Object.keys(st.items).forEach(function (id) { if (!st.catalogue.some(function (p) { return p.ProductID === id; })) st.catalogue.push(st.items[id].product); });
        return st.catalogue;
      });
    }

    /** The product list (searchable dropdown) and the lines of the products chosen so far. */
    function drawCatalogue() {
      var box = $('#catBox', root); if (!box) return;
      drawLines();
      loadCatalogue().then(function () {
        if (!$('#prodPick', root)) return;
        fillPick(); bindPicker();
      }).catch(function (e) { box.innerHTML = '<div class="alert bad">' + esc(e.message || 'Products could not be loaded.') + '</div>'; });
    }
    function productById(id) { return (st.catalogue || []).filter(function (x) { return x.ProductID === id; })[0] || (st.items[id] && st.items[id].product); }
    function listCtnOf(p) { return Math.round(Number(p.WholesalePrice) * Number(p.UnitsPerCarton) * 100) / 100; }
    /** Products matching the search that are not on the order yet, grouped by category (category order as before). */
    function matches() {
      var q = st.filter.toLowerCase().trim();
      return (st.catalogue || []).filter(function (p) { return st.added.indexOf(p.ProductID) < 0 && (!q || (p.Name + ' ' + p.SKU).toLowerCase().indexOf(q) >= 0); });
    }
    function fillPick() {
      var sel = $('#prodPick', root); if (!sel) return;
      var catName = {}; st.categories.forEach(function (c) { catName[c.CategoryID] = c.Name; });
      var found = matches(), groups = {};
      found.forEach(function (p) { var g = catName[p.CategoryID] || p.CategoryName || 'Other products'; (groups[g] = groups[g] || []).push(p); });
      var names = Object.keys(groups).sort(function (a, b) { return a === 'Other products' ? 1 : b === 'Other products' ? -1 : a.localeCompare(b); });
      var head = !(st.catalogue || []).length ? 'No active products — ask the office to add products'
        : found.length ? '— choose a product (' + found.length + ') —' : (st.filter ? 'No product matches "' + st.filter + '"' : 'All products are on the order');
      sel.innerHTML = '<option value="">' + esc(head) + '</option>' + names.map(function (g) {
        return '<optgroup label="' + esc(g) + '">' + groups[g].sort(function (a, b) { return a.Name.localeCompare(b.Name); }).map(function (p) {
          return '<option value="' + esc(p.ProductID) + '" data-sku="' + esc(p.SKU) + '">' + esc(p.Name) + ' · ' + esc(p.SKU) + ' · ' + money(listCtnOf(p)) + '/ctn</option>';
        }).join('') + '</optgroup>';
      }).join('');
    }
    function bindPicker() {
      var sel = $('#prodPick', root), inp = $('#prodSearch', root), t;
      sel.onchange = function () { if (sel.value) addProduct(sel.value); };
      inp.oninput = function () { clearTimeout(t); t = setTimeout(function () { st.filter = inp.value; fillPick(); }, 150); };
      // Enter: one match → add it; more → open the list
      inp.onkeydown = function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault(); clearTimeout(t); st.filter = inp.value; fillPick();
        var found = matches();
        if (found.length === 1) addProduct(found[0].ProductID); else sel.focus();
      };
    }
    function addProduct(id) {
      var p = productById(id); if (!p) return;
      itemFor(p);
      if (st.added.indexOf(id) < 0) st.added.push(id);
      st.filter = ''; var inp = $('#prodSearch', root); if (inp) inp.value = '';
      fillPick(); drawLines();
      var c = $('.cat-row[data-pid="' + cssEsc(id) + '"] [data-f=Cartons]', root); if (c) c.focus();
    }
    function removeProduct(id) {
      delete st.items[id]; st.added = st.added.filter(function (x) { return x !== id; });
      fillPick(); drawLines();
    }
    function drawLines() {
      var box = $('#catBox', root); if (!box) return;
      box.innerHTML = st.added.length ? st.added.map(function (id) { return rowHtml(productById(id)); }).join('')
        : '<div class="empty" style="padding:12px 0">No products yet — choose one above.</div>';
      bindCatalogue(); drawTotals();
    }
    function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

    function itemFor(p) {
      return st.items[p.ProductID] || (st.items[p.ProductID] = { product: p, Cartons: '', LooseUnits: '', CartonPrice: Math.round(Number(p.WholesalePrice) * Number(p.UnitsPerCarton) * 100) / 100,
        DiscountMode: 'AMT', DiscountAmount: '', DiscountPct: '', more: false });
    }

    function rowHtml(p) {
      var it = st.items[p.ProductID] || { Cartons: '', LooseUnits: '', CartonPrice: Math.round(Number(p.WholesalePrice) * Number(p.UnitsPerCarton) * 100) / 100, DiscountMode: 'AMT', DiscountAmount: '', DiscountPct: '', more: false };
      var id = esc(p.ProductID), listCtn = Math.round(Number(p.WholesalePrice) * Number(p.UnitsPerCarton) * 100) / 100;
      return '<div class="cat-row" data-pid="' + id + '" data-sku="' + esc(p.SKU) + '" data-key="' + esc((p.Name + ' ' + p.SKU).toLowerCase()) + '">' +
        '<div class="cat-head"><div class="cat-name"><b>' + esc(p.Name) + '</b><small>' + esc(p.SKU) + ' · ' + esc(p.UnitsPerCarton) + ' ' + esc(p.Unit) + ' per carton · list ' + money(listCtn) + '/ctn</small></div>' +
        '<button type="button" class="cat-del" data-del aria-label="Remove ' + esc(p.Name) + '">Remove</button></div>' +
        '<div class="cat-in"><label>Cartons<input type="number" inputmode="numeric" min="0" step="1" data-f="Cartons" value="' + esc(it.Cartons) + '" placeholder="0"></label>' +
        '<label>Price per carton<input type="number" inputmode="decimal" min="0" step="any" data-f="CartonPrice" value="' + esc(it.CartonPrice) + '"></label></div>' +
        '<button type="button" class="cat-more-btn" data-more>' + (it.more ? 'Hide loose units &amp; discount' : 'Loose units &amp; discount') + '</button>' +
        '<div class="cat-more"' + (it.more ? '' : ' hidden') + '><label>Loose ' + esc(p.Unit) + '<input type="number" inputmode="decimal" min="0" step="any" data-f="LooseUnits" value="' + esc(it.LooseUnits) + '" placeholder="0"></label>' +
          '<label>Discount<span style="display:flex;gap:6px"><input type="number" inputmode="decimal" min="0" step="any" data-f="' + (it.DiscountMode === 'PCT' ? 'DiscountPct' : 'DiscountAmount') + '" value="' + esc(it.DiscountMode === 'PCT' ? it.DiscountPct : it.DiscountAmount) + '" placeholder="0" style="min-width:0;flex:1">' +
          '<select data-dm aria-label="Discount in" style="width:78px;flex:none"><option value="AMT"' + (it.DiscountMode !== 'PCT' ? ' selected' : '') + '>PKR</option><option value="PCT"' + (it.DiscountMode === 'PCT' ? ' selected' : '') + '>%</option></select></span></label></div>' +
        '<div class="cat-pv" data-pv></div></div>';
    }

    function pvRow(row) {
      var it = st.items[row.dataset.pid], el = $('[data-pv]', row);
      if (!it) { el.innerHTML = ''; row.classList.remove('on', 'below'); return; }
      var pv = previewLine(it);
      row.classList.toggle('on', pv.qty > 0); row.classList.toggle('below', pv.belowList);
      el.innerHTML = (pv.qty > 0 ? '= ' + (Math.round(pv.qty * 1000) / 1000) + ' ' + esc(it.product.Unit) + ' (' + (Math.round(pv.cartons * 100) / 100) + ' ctn) · Net <b>' + money(pv.net) + '</b>' : '') +
        (pv.belowList ? '<div class="badge warn" style="margin-top:4px">Below list price (' + money(pv.listCtn) + '/ctn) — needs the manager\'s approval</div>' : '');
    }

    function bindCatalogue() {
      var box = $('#catBox', root);
      $all('.cat-row', box).forEach(function (row) {
        var p = productById(row.dataset.pid);
        pvRow(row);
        $('[data-del]', row).onclick = function () { removeProduct(row.dataset.pid); };
        $all('[data-f]', row).forEach(function (inp) { inp.oninput = function () { itemFor(p)[inp.dataset.f] = inp.value; pvRow(row); drawTotals(); }; });
        $('[data-dm]', row).onchange = function (ev) {
          var it = itemFor(p); it.DiscountMode = ev.target.value; it.DiscountPct = ''; it.DiscountAmount = '';
          var d = $('.cat-more [data-f=DiscountPct], .cat-more [data-f=DiscountAmount]', row); d.dataset.f = it.DiscountMode === 'PCT' ? 'DiscountPct' : 'DiscountAmount'; d.value = '';
          pvRow(row); drawTotals();
        };
        $('[data-more]', row).onclick = function () {
          var it = itemFor(p); it.more = !it.more; $('.cat-more', row).hidden = !it.more;
          this.innerHTML = it.more ? 'Hide loose units &amp; discount' : 'Loose units &amp; discount';
        };
      });
    }

    var creditTimer, creditSeq = 0;
    function drawTotals() {
      var t = { gross: 0, disc: 0, tax: 0, net: 0, ctn: 0, n: 0, below: 0 };
      lines().forEach(function (l) { var pv = previewLine(l); t.gross += pv.gross; t.disc += pv.disc; t.tax += pv.tax; t.net += pv.net; t.ctn += pv.cartons; t.n++; if (pv.belowList) t.below++; });
      var bar = $('#catBar', root);
      if (bar) bar.innerHTML = '<span><b>' + t.n + '</b> product' + (t.n === 1 ? '' : 's') + ' · <b>' + (Math.round(t.ctn * 100) / 100) + '</b> ctn' + (t.below ? ' · <span class="badge warn">' + t.below + ' below list</span>' : '') + '</span><b id="catNet">' + money(Math.round(t.net * 100) / 100) + '</b>';
      var box = $('#totBox', root); if (!box) return;
      box.innerHTML = '<dl class="kv"><dt>Gross</dt><dd>' + money(t.gross) + '</dd><dt>Discount</dt><dd>' + money(t.disc) + '</dd><dt>Tax</dt><dd>' + money(t.tax) + '</dd><dt><b>Net amount</b></dt><dd style="font-size:20px;font-weight:700">' + money(t.net) + '</dd></dl>';
      clearTimeout(creditTimer);
      creditTimer = setTimeout(function () {
        var mine = ++creditSeq; // an older answer arriving late must not replace a newer one
        API.call('orders.creditInfo', { CustomerID: st.customer.CustomerID, OrderID: o ? o.OrderID : '', Amount: Math.round(t.net * 100) / 100 })
          .then(function (cr) { if (mine !== creditSeq) return; var cb = $('#credBox', root); if (cb) cb.innerHTML = '<h2 style="font-size:15px;margin:12px 0 8px">Credit</h2>' + creditPanel(cr); }).catch(function () {});
      }, 500);
    }

    function send(submit, btn) {
      var ls = lines();
      if (!ls.length) return toast(st.added.length ? 'Enter cartons for at least one product.' : 'Choose a product first.', true);
      if (st.office && !st.spId) { toast('Choose the salesperson who took this order.', true); if ($('#oSp', root)) $('#oSp', root).focus(); return; }
      var payload = { CustomerID: st.customer.CustomerID, Remarks: st.remarks, VisitID: st.visitId, submit: submit,
        Lines: ls.map(function (l) { return { ProductID: l.product.ProductID, Cartons: l.Cartons || 0, LooseUnits: l.LooseUnits || 0, CartonPrice: l.CartonPrice === '' ? '' : l.CartonPrice,
          DiscountMode: l.DiscountMode === 'PCT' ? 'PCT' : 'AMT', DiscountPct: l.DiscountMode === 'PCT' ? (l.DiscountPct || 0) : 0, DiscountAmount: l.DiscountMode === 'PCT' ? 0 : (l.DiscountAmount || 0) }; }) };
      if (o) { payload.OrderID = o.OrderID; payload.Version = o.Version; } else payload.ClientUUID = st.clientUUID;
      if (st.office) payload.SalespersonID = st.spId;
      if (st.gps) { payload.Latitude = st.gps.lat; payload.Longitude = st.gps.lng; payload.GPSAccuracy = st.gps.accuracy; }
      busy(btn, true);
      API.call('orders.save', payload).then(function (saved) {
        toast(savedMsg(saved, submit ? 'Order ' + saved.OrderNo + ' submitted.' : 'Draft ' + saved.OrderNo + ' saved.'));
        go('orders/' + encodeURIComponent(saved.OrderID));
      }).catch(function (e) { busy(btn, false); showError(e); });
    }
  }

  function orderDetail(id) {
    if (isLocalId(id)) {
      if (Local.idmap[id]) return go('orders/' + encodeURIComponent(Local.idmap[id]));
      var item = Outbox.byLocalId(id);
      if (item) return drawPendingOrder(item);
      toast('This order is no longer on this phone.', true); return go('orders');
    }
    loading('Order', 'orders');
    API.call('orders.get', { OrderID: id }).then(drawOrder).catch(function (e) { showError(e); go('orders'); });
  }

  /** An order saved on this phone that has not reached the server yet. */
  function drawPendingOrder(item) {
    var p = item.payload, c = Pack.customer(p.CustomerID) || {}, est = estimateOrder(p);
    var html = (item.status === 'FAILED' ? '<div class="alert bad"><b>Not accepted by the server:</b> ' + esc(item.error.message) + ' <a href="#/outbox">Open Outbox</a></div>'
      : '<div class="alert warn">Saved on this phone at ' + fmtDate(item.createdAt) + '. It gets its order number when it is sent' + (Net.down() ? ' — you are offline now.' : '.') + '</div>') +
      '<div class="card"><div style="display:flex;justify-content:space-between;gap:8px"><div><h2 style="margin:0">' + esc(c.ShopName || 'Customer') + '</h2><div style="color:var(--muted);font-size:14px">' + esc(c.Code) + ' · ' + esc(c.Address) + ', ' + esc(c.Area) + '</div></div>' +
      statusBadge('PENDING_SYNC') + '</div><p style="margin:8px 0 0;font-size:14px">' + (p.submit ? 'Will be submitted for approval.' : 'Will be saved as a draft.') + (p.VisitID ? ' Linked to a visit.' : '') + '</p></div>' +
      '<div class="card"><h2>Products</h2><div class="scroll-x"><table class="tbl"><tr><th>Product</th><th>Quantity</th><th>≈ Net</th></tr>' + est.lines.map(function (l) {
        return '<tr><td>' + esc(l.name) + '<br><small>' + esc(l.sku) + '</small></td><td>' + qty(l.qty) + ' ' + esc(l.unit) + ' (' + qty(l.cartons) + ' ctn)</td><td>' + money(l.net) + '</td></tr>';
      }).join('') + '<tr><td colspan="2" style="text-align:right"><b>≈ Total</b></td><td><b>' + money(est.net) + '</b></td></tr></table></div>' +
      (p.Remarks ? '<p><b>Remarks:</b> ' + esc(p.Remarks) + '</p>' : '') + '<p class="hint" style="font-size:12px;color:var(--muted)">Amounts are estimates from the price list saved on this phone. The server calculates the final figures.</p></div>';
    shell('Order (not sent yet)', html, { back: 'orders' });
  }

  // ---------- outbox ----------
  var OUTBOX_FIX = { GPS_MISMATCH: 'OverrideReason', LOW_ACCURACY: 'ConfirmLowAccuracy' };
  VIEWS.outbox = function () {
    var pend = Outbox.pending(), failed = Outbox.failed(), pack = Local.pack;
    var row = function (i, extra) {
      return '<li><div class="row"><span class="main-t"><div class="t1">' + esc(i.label) + '</div><div class="t2">Saved ' + fmtDate(i.createdAt) + (i.lastError ? ' · last try: ' + esc(i.lastError) : '') + '</div>' + (extra || '') + '</span>' +
        (i.status === 'SENDING' ? '<span class="badge warn">Sending…</span>' : i.status === 'FAILED' ? '<span class="badge bad">Not accepted</span>' : '<span class="badge">Waiting</span>') + '</div></li>';
    };
    var html = '<div class="card"><dl class="kv"><dt>Connection</dt><dd>' + (Net.down() ? '<span class="badge bad">Offline</span>' : '<span class="badge good">Online</span>') + '</dd>' +
      '<dt>Waiting to send</dt><dd>' + pend.length + '</dd><dt>Not accepted</dt><dd>' + failed.length + '</dd>' +
      (Pack.wanted() ? '<dt>Offline data</dt><dd>' + (pack ? 'saved ' + esc(ago(pack.savedAt)) + ' · ' + (pack.customers || []).length + ' customers · ' + (pack.products || []).length + ' products · ' + (pack.trips || []).length + ' open trips' : 'not downloaded yet') + '</dd>' : '') + '</dl>' +
      '<div class="btn-row"><button class="btn primary" id="obSend"' + (pend.length ? '' : ' disabled') + '>Send now</button>' + (Pack.wanted() ? '<button class="btn" id="obPack">Update offline data</button>' : '') + '</div></div>';
    if (failed.length) {
      html += '<div class="group-title">Not accepted — needs your action</div><ul class="list">' + failed.map(function (i, n) {
        var fix = i.error.code === 'GPS_MISMATCH' || ((i.error.field === 'Reason' || i.error.field === 'OverrideReason') && i.action !== 'returns.create');
        return row(i, '<div class="alert bad" style="margin:6px 0">' + esc(i.error.message) + '</div><div class="btn-row" style="margin:0">' +
          (fix ? '<button class="btn primary" data-fix="' + n + '">Add reason &amp; send again</button>' : '') +
          (i.error.code === 'LOW_ACCURACY' ? '<button class="btn primary" data-low="' + n + '">Save anyway</button>' : '') +
          '<button class="btn" data-retry="' + n + '">Send again</button><button class="btn danger" data-discard="' + n + '">Discard</button></div>');
      }).join('') + '</ul>';
    }
    html += '<div class="group-title">Waiting to send</div>' + (pend.length ? '<ul class="list">' + pend.map(function (i) { return row(i); }).join('') + '</ul>' : '<div class="empty card">Nothing waiting. Everything recorded on this phone has reached the office.</div>');
    if (Local.sent.length) {
      html += '<div class="group-title">Recently sent from this phone</div><ul class="list">' + Local.sent.slice(0, 20).map(function (x) {
        var link = x.action === 'orders.save' && x.serverId ? '#/orders/' + encodeURIComponent(x.serverId) : x.action.indexOf('delivery.') === 0 && x.serverId ? '#/trips/' + encodeURIComponent(x.serverId)
          : x.customerId ? '#/customers/' + encodeURIComponent(x.customerId) : '';
        return '<li><' + (link ? 'a class="row" href="' + link + '"' : 'div class="row"') + '><span class="main-t"><div class="t1">' + esc(x.label) + (x.ref ? ' · ' + esc(x.ref) : '') + '</div><div class="t2">Saved ' + fmtDate(x.createdAt) + ' · sent ' + fmtDate(x.sentAt) + '</div></span><span class="badge good">Sent</span></' + (link ? 'a' : 'div') + '></li>';
      }).join('') + '</ul>';
    }
    var root = shell('Outbox', html);
    $('#obSend', root).onclick = function () { var b = this; busy(b, true); Net.isDown = false; Sync.run().then(function () { render(); }); };
    if ($('#obPack', root)) $('#obPack', root).onclick = function () { var b = this; busy(b, true); Net.isDown = false; Pack.refresh().then(function () { toast(Net.down() ? 'Still offline.' : 'Offline data updated.', Net.down()); render(); }); };
    var resend = function (i) { i.status = 'PENDING'; i.attempts = 0; i.error = null; i.lastError = ''; return Outbox.save(i).then(function () { Net.isDown = false; return Sync.run(); }).then(function () { render(); }); };
    $all('[data-retry]', root).forEach(function (b) { b.onclick = function () { busy(b, true); resend(failed[Number(b.dataset.retry)]); }; });
    $all('[data-low]', root).forEach(function (b) { b.onclick = function () { var i = failed[Number(b.dataset.low)]; i.payload.ConfirmLowAccuracy = true; busy(b, true); resend(i); }; });
    $all('[data-fix]', root).forEach(function (b) { b.onclick = function () {
      var i = failed[Number(b.dataset.fix)], field = i.error.code === 'GPS_MISMATCH' ? 'OverrideReason' : i.error.field;
      modal('Add a reason', '<div class="alert bad">' + esc(i.error.message) + '</div><div class="field"><label>Reason *</label><input type="text" id="fxr" value="' + esc(i.payload[field] || '') + '"></div>' +
        '<div class="btn-row"><button class="btn primary" id="fxok">Send again</button><button class="btn" id="fxno">Back</button></div>', function (m, close) {
        $('#fxno', m).onclick = close;
        $('#fxok', m).onclick = function () { var v = $('#fxr', m).value.trim(); if (v.length < 5) return toast('Please write a short reason (at least 5 characters).', true); i.payload[field] = v; close(); resend(i); };
      });
    }; });
    $all('[data-discard]', root).forEach(function (b) { b.onclick = function () {
      var i = failed[Number(b.dataset.discard)];
      confirmBox('Discard', 'Remove “' + i.label + '” from this phone? It was not accepted by the server and will not be sent.', 'Discard').then(function (y) {
        if (y) Outbox.remove(i).then(function () { toast('Removed.'); render(); });
      });
    }; });
  };

  function drawOrder(o) {
    var a = o.Actions;
    var html = '<div class="card"><div style="display:flex;justify-content:space-between;gap:8px;align-items:start"><div><h2 style="margin:0">' + esc(o.OrderNo) + '</h2><div style="color:var(--muted);font-size:14px">' + fmtDate(o.CreatedAt) + ' · by ' + esc(o.CreatedByName) + '</div></div>' + statusBadge(o.Status) + (o.Archived ? ' <span class="badge">Archived ' + esc(o.ArchiveMonth) + ' · read-only</span>' : '') + '</div>' +
      '<dl class="kv" style="margin-top:12px"><dt>Customer</dt><dd><a href="#/customers/' + encodeURIComponent(o.CustomerID) + '">' + esc(o.Customer.ShopName) + '</a><br><small>' + esc(o.Customer.Code) + ' · ' + esc(o.Customer.Address) + ', ' + esc(o.Customer.Area) + '</small></dd>' +
      '<dt>Salesperson</dt><dd>' + esc(o.SalespersonName) + (o.AssignedSalespersonName ? '<br><small>Shop\'s salesperson: ' + esc(o.AssignedSalespersonName) + '</small>' : '') + '</dd>' +
      (o.ApprovedAt ? '<dt>Approved</dt><dd>' + fmtDate(o.ApprovedAt) + ' · ' + esc(o.ApprovedByName) + '</dd>' : '') +
      (o.CreditApprovalReason ? '<dt>Credit override</dt><dd>' + esc(o.CreditApprovalReason) + ' — ' + esc(o.CreditApprovedByName) + '</dd>' : '') +
      (o.PriceStatus === 'BELOW_LIST' ? '<dt>Prices</dt><dd>' + (o.PriceApprovalReason ? 'Below list, approved: ' + esc(o.PriceApprovalReason) + ' — ' + esc(o.PriceApprovedByName) : '<span class="badge warn">Price below list</span> <small>needs the manager\'s approval</small>') + '</dd>' : '') +
      '<dt>QuickBooks</dt><dd>' + (o.QBSyncStatus ? esc(o.QBSyncStatus) + (o.QBTxnID ? ' · ' + esc(o.QBTxnID) : '') + ' <small>(ref ' + esc(o.QBRefNumber) + ')</small>' + (can('qb.manage') ? ' <a href="#/quickbooks?q=' + encodeURIComponent(o.OrderNo) + '">sync details</a>' : '') : '—') + '</dd>' +
      (typeof o.Latitude === 'number' ? '<dt>Order GPS</dt><dd>' + o.Latitude.toFixed(5) + ', ' + o.Longitude.toFixed(5) + ' (±' + Math.round(o.GPSAccuracy) + ' m)</dd>' : '') +
      (o.Remarks ? '<dt>Remarks</dt><dd>' + esc(o.Remarks) + '</dd>' : '') + '</dl></div>';

    html += '<div class="card scroll-x"><h2>Items</h2><table class="tbl"><tr><th>Product</th><th>Qty</th><th class="hide-sm">Ctn</th><th class="hide-sm">Rate</th><th class="hide-sm">Disc</th><th class="hide-sm">Tax</th><th style="text-align:right">Net</th></tr>' +
      o.Lines.map(function (l) { return '<tr><td>' + esc(l.ProductName) + '<br><small>' + esc(l.SKU) + ' · ' + (l.CartonPrice !== '' && l.CartonPrice !== undefined ? money(l.CartonPrice) + '/ctn' : money(l.Rate)) +
        (l.PriceBelowList ? ' <span class="badge warn">below list ' + money(Math.round(l.ListRate * l.UnitsPerCarton * 100) / 100) + '/ctn</span>' : '') + (Number(l.DiscountAmount) ? ' · ' + (l.DiscountMode === 'AMT' ? money(l.DiscountAmount) : l.DiscountPct + '%') + ' off' : '') + '</small></td><td>' + l.Quantity + ' ' + esc(l.Unit) + '<br><small>' + l.Cartons + ' ctn</small></td><td class="hide-sm">' + l.Cartons + '</td><td class="hide-sm">' + money(l.Rate) + '</td><td class="hide-sm">' + (Number(l.DiscountAmount) ? money(l.DiscountAmount) + (l.DiscountMode === 'AMT' ? '' : '<br><small>' + l.DiscountPct + '%</small>') : '') + '</td><td class="hide-sm">' + (l.TaxRate ? l.TaxRate + '%' : '') + '</td><td style="text-align:right;white-space:nowrap">' + money(l.NetAmount) + '</td></tr>'; }).join('') +
      '</table><dl class="kv" style="margin-top:12px"><dt>Gross</dt><dd>' + money(o.GrossAmount) + '</dd><dt>Discount</dt><dd>' + money(o.DiscountAmount) + '</dd><dt>Tax</dt><dd>' + money(o.TaxAmount) + '</dd><dt><b>Net amount</b></dt><dd style="font-size:20px;font-weight:700">' + money(o.NetAmount) + '</dd></dl></div>';

    if (o.Credit) html += '<div class="card"><h2>Credit</h2>' + creditPanel(o.Credit) + '</div>';
    if (o.Deliveries && o.Deliveries.length) html += '<div class="card"><h2>Deliveries</h2><ul class="list">' + o.Deliveries.map(function (d) {
      return '<li><a class="row" href="#/trips/' + encodeURIComponent(d.DeliveryID) + (d.Status === 'REMOVED' ? '' : '/stop/' + encodeURIComponent(d.DeliveryOrderID)) + '"><span class="main-t"><div class="t1">' + esc(d.TripNo) + ' · ' + esc(d.DriverName) + '</div><div class="t2">' + (d.DeliveredAt ? fmtDate(d.DeliveredAt) : fmtDate(d.DeliveryDate, false)) + (d.NetValue ? ' · ' + money(d.NetValue) : '') + (d.Remarks ? ' · ' + esc(d.Remarks) : '') + '</div></span>' + stopBadge(d.Status) + ' ' + gpsStopBadge(d) + '</a></li>';
    }).join('') + '</ul><p class="hint" style="font-size:13px;color:var(--muted);margin-top:8px">Delivered / returned per product: ' + o.Lines.map(function (l) { return esc(l.ProductName) + ' ' + qty(l.DeliveredQty) + '/' + qty(l.Quantity) + (l.ReturnedQty ? ' (−' + qty(l.ReturnedQty) + ' returned)' : ''); }).join(' · ') + '</p></div>';
    if (o.Returns && o.Returns.length) html += '<div class="card"><h2>Returns</h2><ul class="list">' + o.Returns.map(function (x) {
      return '<li><div class="row"><span class="main-t"><div class="t1">' + esc(x.ReturnNo) + ' · ' + qty(x.Quantity) + ' units · ' + money(x.NetValue) + '</div><div class="t2">' + esc(RETURN_REASON_LABELS[x.Reason] || x.Reason) + ' · ' + esc(x.CreatedByName) + ' · ' + fmtDate(x.CreatedAt) + '</div></span><span class="badge ' + ({ APPROVED: 'good', REJECTED: 'bad', PENDING: 'warn' }[x.Status]) + '">' + esc(x.Status) + '</span></div></li>';
    }).join('') + '</ul></div>';

    var btns = '';
    if (a.edit) btns += '<a class="btn" href="#/orders/' + encodeURIComponent(o.OrderID) + '/edit">Edit</a>';
    if (a.submit) btns += '<button class="btn primary" id="oSubmit">Submit</button>';
    if (a.approve) btns += '<button class="btn primary" id="oApprove">Approve</button>';
    if (a.returnToDraft) btns += '<button class="btn" id="oReturn">Return to salesperson</button>';
    if (a.cancel) btns += '<button class="btn danger" id="oCancel">Cancel order</button>';
    if (a.closeShort) btns += '<button class="btn" id="oCloseShort">Close remainder</button>';
    if (a.recordReturn) btns += '<button class="btn" id="oReturnGoods">Record return</button>';
    btns += '<a class="btn" href="#/orders/' + encodeURIComponent(o.OrderID) + '/print">Print</a>';
    html += '<div class="btn-row" style="margin-bottom:14px">' + btns + '</div>';

    html += '<div class="card"><h2>Status history</h2><ul class="list">' + o.History.map(function (h) {
      return '<li><div class="row"><span class="main-t"><div class="t1">' + esc(h.ToLabel) + '</div><div class="t2">' + fmtDate(h.ChangedAt) + ' · ' + esc(h.ChangedByName) + (h.Remarks ? ' · ' + esc(h.Remarks) : '') + '</div></span></div></li>';
    }).join('') + '</ul></div>';
    var root = shell(o.OrderNo, html, { back: 'orders' });

    var act = function (action, payload, btn, msg) {
      busy(btn, true);
      return API.call(action, Object.assign({ OrderID: o.OrderID, Version: o.Version }, payload || {})).then(function (fresh) { toast(msg); drawOrder(fresh); })
        .catch(function (e) { busy(btn, false); showError(e); });
    };
    var reasonModal = function (title, label, okLabel, cb) {
      modal(title, '<div class="field"><label>' + esc(label) + '</label><textarea id="rsn"></textarea><div class="ferr" data-err="Reason"></div><div class="ferr" data-err="CreditOverrideReason"></div></div><div class="btn-row"><button class="btn primary" id="rOk">' + esc(okLabel) + '</button><button class="btn" id="rNo">Back</button></div>', function (m, close) {
        $('#rNo', m).onclick = close;
        $('#rOk', m).onclick = function () {
          var b = this; busy(b, true);
          cb($('#rsn', m).value.trim()).then(function (fresh) { close(); drawOrder(fresh); }).catch(function (e) { busy(b, false); fieldError(m, e); });
        };
      });
    };
    if ($('#oReturnGoods', root)) $('#oReturnGoods', root).onclick = function () { returnModal(o.Lines, function () { orderDetail(o.OrderID); }); };
    if ($('#oSubmit', root)) $('#oSubmit', root).onclick = function () { act('orders.submit', {}, this, 'Order submitted.'); };
    if ($('#oApprove', root)) $('#oApprove', root).onclick = function () {
      if (!a.needsOverride && !a.needsPriceApproval) return act('orders.approve', {}, this, 'Order approved.');
      if (a.needsOverride && !a.canOverride) return toast('This order exceeds the credit limit. A user with credit-override rights must approve it.', true);
      var fld = function (id, label, err) { return '<div class="field"><label for="' + id + '">' + label + '</label><textarea id="' + id + '"></textarea><div class="ferr" data-err="' + err + '"></div></div>'; };
      modal('Approve order', (a.needsPriceApproval ? '<div class="alert warn">Some products are priced below the catalogue price.</div>' + fld('rPrice', 'Reason for approving these prices *', 'PriceApprovalReason') : '') +
        (a.needsOverride ? fld('rCredit', 'Reason for approving above the credit limit *', 'CreditOverrideReason') : '') +
        '<div class="btn-row"><button class="btn primary" id="rOk">Approve</button><button class="btn" id="rNo">Back</button></div>', function (m, close) {
        $('#rNo', m).onclick = close;
        $('#rOk', m).onclick = function () {
          var b = this, pl = { OrderID: o.OrderID, Version: o.Version }; busy(b, true);
          if ($('#rPrice', m)) pl.PriceApprovalReason = $('#rPrice', m).value.trim();
          if ($('#rCredit', m)) pl.CreditOverrideReason = $('#rCredit', m).value.trim();
          API.call('orders.approve', pl).then(function (f) { close(); toast('Order approved.'); drawOrder(f); }).catch(function (e) { busy(b, false); fieldError(m, e); });
        };
      });
    };
    if ($('#oReturn', root)) $('#oReturn', root).onclick = function () {
      reasonModal('Return to salesperson', 'What should the salesperson change? *', 'Return', function (reason) {
        return API.call('orders.returnToDraft', { OrderID: o.OrderID, Reason: reason }).then(function (f) { toast('Returned to salesperson.'); return f; });
      });
    };
    if ($('#oCloseShort', root)) $('#oCloseShort', root).onclick = function () {
      reasonModal('Close the rest of ' + o.OrderNo, 'Why will the rest not be delivered? *', 'Close remainder', function (reason) {
        return API.call('orders.closeShort', { OrderID: o.OrderID, Reason: reason }).then(function (f) { toast('Order closed at the delivered quantities.'); return f; });
      });
    };
    if ($('#oCancel', root)) $('#oCancel', root).onclick = function () {
      reasonModal('Cancel order ' + o.OrderNo, 'Reason for cancelling *', 'Cancel order', function (reason) {
        return API.call('orders.cancel', { OrderID: o.OrderID, Reason: reason }).then(function (f) { toast('Order cancelled.'); return f; });
      });
    };
  }

  function orderPrint(id) {
    loading('Print', 'orders/' + encodeURIComponent(id));
    API.call('orders.get', { OrderID: id }).then(function (o) {
      var s = State.settings;
      var html = '<div class="print-doc"><div class="btn-row noprint" style="margin-bottom:12px"><button class="btn primary" id="doPrint">Print / Save PDF</button><a class="btn" href="#/orders/' + encodeURIComponent(o.OrderID) + '">Back</a></div>' +
        '<div class="card"><div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px"><div><div style="font-size:22px;font-weight:800">' + esc(s.COMPANY_NAME || 'Prosol Foods') + '</div><div style="font-size:13px">' + esc(s.COMPANY_ADDRESS || '') + ' ' + esc(s.COMPANY_PHONE || '') + '</div></div>' +
        '<div style="text-align:right"><div style="font-size:18px;font-weight:700">SALES ORDER</div><div>' + esc(o.OrderNo) + '</div><div style="font-size:13px">' + fmtDate(o.OrderDate, false) + ' · ' + esc(ORDER_LABELS[o.Status]) + '</div></div></div>' +
        '<hr style="border:0;border-top:1px solid var(--line);margin:14px 0"><div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;font-size:14px"><div><b>Customer</b><br>' + esc(o.Customer.ShopName) + ' (' + esc(o.Customer.Code) + ')<br>' + esc(o.Customer.Address) + ', ' + esc(o.Customer.Area) + ', ' + esc(o.Customer.City) + '<br>' + esc(o.Customer.Mobile) + '</div>' +
        '<div><b>Salesperson</b><br>' + esc(o.SalespersonName) + (o.Customer.PaymentTerms ? '<br><b>Terms:</b> ' + esc(o.Customer.PaymentTerms) : '') + '</div></div>' +
        '<table class="tbl" style="margin-top:14px"><tr><th class="wide">#</th><th>Product</th><th>Qty</th><th class="wide">Cartons</th><th class="wide">Price</th><th class="wide">Disc</th><th class="wide">Tax</th><th style="text-align:right">Amount</th></tr>' +
        o.Lines.map(function (l) { return '<tr><td class="wide">' + l.LineNo + '</td><td>' + esc(l.ProductName) + '<br><small>' + esc(l.SKU) + '</small></td><td>' + l.Quantity + ' ' + esc(l.Unit) + '</td><td class="wide">' + l.Cartons + '</td><td class="wide">' + (l.CartonPrice !== '' && l.CartonPrice !== undefined ? money(l.CartonPrice) + '/ctn' : money(l.Rate)) + '</td><td class="wide">' + money(l.DiscountAmount) + '</td><td class="wide">' + money(l.TaxAmount) + '</td><td style="text-align:right">' + pkr(l.NetAmount) + '</td></tr>'; }).join('') +
        '<tr><td colspan="7" class="span-total" style="text-align:right">Gross</td><td style="text-align:right">' + money(o.GrossAmount) + '</td></tr><tr><td colspan="7" class="span-total" style="text-align:right">Discount</td><td style="text-align:right">' + money(o.DiscountAmount) + '</td></tr>' +
        '<tr><td colspan="7" class="span-total" style="text-align:right">Tax</td><td style="text-align:right">' + money(o.TaxAmount) + '</td></tr><tr><td colspan="7" class="span-total" style="text-align:right"><b>Net amount</b></td><td style="text-align:right"><b>' + money(o.NetAmount) + '</b></td></tr></table>' +
        (o.Remarks ? '<p style="font-size:14px"><b>Remarks:</b> ' + esc(o.Remarks) + '</p>' : '') +
        '<div style="display:flex;justify-content:space-between;margin-top:48px;font-size:13px"><div>______________________<br>Salesperson</div><div>______________________<br>Customer signature &amp; stamp</div></div></div></div>';
      var root = shell('Sales order ' + o.OrderNo, html, { back: 'orders/' + encodeURIComponent(o.OrderID) });
      $('#doPrint', root).onclick = function () { window.print(); };
      paperControl(root);
    }).catch(showError);
  }

  // ---------- views: QuickBooks ----------
  var QB_TABS = [['', 'All'], ['PENDING', 'Waiting'], ['IN_PROGRESS', 'In progress'], ['FAILED', 'Retrying'], ['EXCEPTION', 'Exceptions'], ['SYNCED', 'Synced'], ['MISMATCH', 'Total mismatch'], ['CANCELLED', 'Cancelled']];
  function qbBadge(st) {
    var cls = { SYNCED: 'good', EXCEPTION: 'bad', FAILED: 'warn', PENDING: '', IN_PROGRESS: '', CANCELLED: '' }[st];
    var label = { PENDING: 'Waiting', IN_PROGRESS: 'In progress', FAILED: 'Retrying', EXCEPTION: 'Needs action', SYNCED: 'Synced', CANCELLED: 'Cancelled' }[st] || st;
    return '<span class="badge ' + (cls || '') + '">' + esc(label) + '</span>';
  }
  VIEWS.quickbooks = function (r) {
    var q = r.q;
    loading('QuickBooks');
    Promise.all([API.call('qb.status'), API.call('qb.queue', { status: q.status, q: q.q, page: Number(q.page) || 1 })]).then(function (res) {
      var st = res[0], list = res[1], b = st.bridge;
      var online = b && (Date.now() - new Date(b.lastSeen).getTime()) < 5 * 60000;
      var html = '<div class="card"><h2>Bridge</h2>';
      if (!b) html += '<div class="alert warn">The QuickBooks bridge has never connected. Install it on the QuickBooks PC (see the setup guide) and paste the bridge key.</div>';
      else {
        if (b.envMismatch) html += '<div class="alert bad"><b>Environment mismatch.</b> The bridge is set to ' + esc(b.environment) + ' but this system expects ' + esc(st.environment) + '. Nothing is synced until they match.</div>';
        else if (!online) html += '<div class="alert warn">The bridge has not been seen for a while (QuickBooks PC off or asleep). Orders wait safely and sync when it is back.</div>';
        else if (!b.qbConnected) html += '<div class="alert warn">The bridge is running but cannot open QuickBooks: ' + esc(b.lastError) + '</div>';
        html += '<dl class="kv"><dt>Status</dt><dd>' + (online && b.qbConnected && !b.envMismatch ? '<span class="badge good">Online, connected to QuickBooks</span>' : online ? '<span class="badge warn">Online, QuickBooks not connected</span>' : '<span class="badge bad">Offline</span>') + '</dd>' +
          '<dt>Last seen</dt><dd>' + fmtDate(b.lastSeen) + '</dd><dt>PC / bridge</dt><dd>' + esc(b.machine) + ' · ' + esc(b.bridgeId) + ' · v' + esc(b.version) + '</dd>' +
          '<dt>QuickBooks</dt><dd>' + esc(b.qbProduct || '—') + '</dd><dt>Company file</dt><dd style="word-break:break-all">' + esc(b.companyFile) + '</dd></dl>';
      }
      html += '<dl class="kv" style="margin-top:8px"><dt>Environment</dt><dd><span class="badge ' + (st.environment === 'PROD' ? 'good' : 'warn') + '">' + esc(st.environment) + '</span> <small>(change in Settings → Qb environment)</small></dd>' +
        '<dt>Lists imported</dt><dd>' + st.lists.customers + ' customers, ' + st.lists.items + ' items, ' + (st.lists.salesReps || 0) + ' sales reps' + (st.listsUpdatedAt ? ' · ' + fmtDate(st.listsUpdatedAt) : '') + '</dd>' +
        '<dt>Bridge key</dt><dd>' + (st.keyCreatedAt ? 'created ' + fmtDate(st.keyCreatedAt) : '<span class="badge warn">not generated</span>') + '</dd></dl>' +
        (st.canGenerateKey ? '<div class="btn-row"><button class="btn" id="genKey">' + (st.keyCreatedAt ? 'Replace bridge key' : 'Generate bridge key') + '</button></div>' : '') + '</div>';
      var cc = st.customerCreate || { waiting: 0, failed: 0, unlinked: 0 };
      if (can('customers.qbmap') && (cc.waiting || cc.failed || cc.unlinked)) html += '<div class="card"><h2>Customers created in the app</h2>' +
        '<p style="font-size:14px;color:var(--muted)">New customers are created in QuickBooks by the bridge (shop name, contact, phone, address; the Prosol customer code is the QuickBooks <i>Account No.</i>). Their orders follow automatically.</p><dl class="kv">' +
        '<dt>Waiting for the bridge</dt><dd>' + cc.waiting + '</dd>' +
        '<dt>Could not be created</dt><dd>' + (cc.failed ? '<a href="#/customers?qbcreate=failed">' + cc.failed + ' — open to see why</a>' : '0') + '</dd>' +
        '<dt>Not linked to QuickBooks</dt><dd>' + cc.unlinked + '</dd></dl>' +
        (cc.unlinked ? '<div class="btn-row"><button class="btn primary" id="qbCreateAll">Create ' + cc.unlinked + ' unlinked customer(s) in QuickBooks</button></div>' : '') + '</div>';
      var rc = st.salesRepCreate || { waiting: 0, failed: 0, unlinked: 0 };
      if (rc.waiting || rc.failed) html += '<div class="card"><h2>Salespersons as QuickBooks Sales Reps</h2>' +
        '<p style="font-size:14px;color:var(--muted)">The salesperson who books an order is sent to QuickBooks as the Sales Rep. A salesperson who is not a Sales Rep yet is created by the bridge (an Other Name with initials); their orders follow automatically.</p><dl class="kv">' +
        '<dt>Waiting for the bridge</dt><dd>' + rc.waiting + '</dd>' +
        '<dt>Could not be created</dt><dd>' + (rc.failed ? '<a href="#/salespersons">' + rc.failed + ' — open Salespersons to see why</a>' : '0') + '</dd></dl></div>';
      if (can(['customers.manage', 'products.manage'])) html += '<div class="card"><h2>Create customers and products from QuickBooks</h2>' +
        '<p style="font-size:14px;color:var(--muted)">Creates a Prosol customer for every active QuickBooks customer, and a Prosol product for the QuickBooks items you choose, already mapped. Records that are already mapped are skipped, so it is safe to run again after new customers or items are added in QuickBooks. Nothing is changed in QuickBooks.</p>' +
        (st.lists.customers + st.lists.items ? '<div class="btn-row"><button class="btn primary" id="qbImp">Preview</button></div>' :
          '<div class="alert warn">The QuickBooks lists have not been imported yet. They arrive when the bridge on the QuickBooks PC connects for the first time.</div>') + '</div>';
      html += '<div class="toolbar">' + QB_TABS.map(function (t) {
        var n = t[0] === '' ? '' : t[0] === 'MISMATCH' ? st.totalMismatches : (st.counts[t[0]] || 0);
        return '<a class="btn' + ((q.status || '') === t[0] ? ' primary' : '') + '" href="#/quickbooks' + (t[0] ? '?status=' + t[0] : '') + '">' + t[1] + (n !== '' ? ' (' + n + ')' : '') + '</a>';
      }).join('') + '<input type="search" class="search" id="qbSearch" placeholder="Order no., customer, TxnID" value="' + esc(q.q || '') + '"></div>';
      html += list.items.length ? '<ul class="list">' + list.items.map(function (x, i) {
        return '<li><div class="row"><span class="main-t"><div class="t1"><a href="#/orders/' + encodeURIComponent(x.OrderID) + '">' + esc(x.OrderNo) + '</a> · ' + esc(x.CustomerName) + '</div>' +
          '<div class="t2">' + money(x.NetAmount) + ' · ref ' + esc(x.QBRefNumber) + (x.QBTxnID ? ' · TxnID ' + esc(x.QBTxnID) : '') + ' · attempts ' + (x.Attempts || 0) + ' · ' + fmtDate(x.UpdatedAt) + '</div>' +
          (x.LastError ? '<div class="t2" style="white-space:normal;color:' + (x.Status === 'SYNCED' ? 'var(--warn)' : 'var(--bad)') + '">' + esc(x.LastError) + '</div>' : '') + '</span>' +
          '<span style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">' + qbBadge(x.Status) +
          '<span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end"><button class="btn" style="min-height:34px;padding:0 10px" data-log="' + i + '">Log</button>' +
          (x.ErrorCode === 'MAP_CUSTOMER' && x.Status === 'EXCEPTION' ? '<a class="btn" style="min-height:34px;padding:0 10px" href="#/customers/' + encodeURIComponent(x.CustomerID) + '">Fix mapping</a>' : '') +
          (x.ErrorCode === 'MAP_ITEM' && x.Status === 'EXCEPTION' ? '<a class="btn" style="min-height:34px;padding:0 10px" href="#/products?qb=unmapped">Fix mapping</a>' : '') +
          (x.ErrorCode === 'MAP_SALESREP' && x.Status === 'EXCEPTION' ? '<a class="btn" style="min-height:34px;padding:0 10px" href="#/salespersons?q=' + encodeURIComponent(x.SalespersonName || '') + '">Fix mapping</a>' : '') +
          (x.CanRetry ? '<button class="btn primary" style="min-height:34px;padding:0 10px" data-retry="' + i + '">Retry</button>' : '') + '</span></span></div></li>';
      }).join('') + '</ul>' : '<div class="empty card">Nothing here.</div>';
      var pg = pager(list, function (p) { go('quickbooks?page=' + p + (q.status ? '&status=' + q.status : '') + (q.q ? '&q=' + encodeURIComponent(q.q) : '')); });
      var root = shell('QuickBooks', html + pg.html); pg.bind(root);
      var t; $('#qbSearch').oninput = function (ev) { clearTimeout(t); var sq = renderSeq; t = setTimeout(function () { if (sq !== renderSeq) return; go('quickbooks?' + (q.status ? 'status=' + q.status + '&' : '') + 'q=' + encodeURIComponent(ev.target.value)); }, 450); };
      $all('[data-retry]', root).forEach(function (bt) { bt.onclick = function () {
        var x = list.items[Number(bt.dataset.retry)]; busy(bt, true);
        API.call('qb.retry', { QueueID: x.QueueID }).then(function () { toast(x.OrderNo + ' queued again.'); render(); }).catch(function (e) { busy(bt, false); showError(e); });
      }; });
      $all('[data-log]', root).forEach(function (bt) { bt.onclick = function () {
        var x = list.items[Number(bt.dataset.log)];
        API.call('qb.log', { OrderID: x.OrderID, QueueID: x.QueueID }).then(function (rows) {
          modal('Sync log — ' + x.OrderNo, '<div class="scroll-x"><table class="tbl"><tr><th>When</th><th>Event</th><th>Message</th></tr>' + rows.map(function (l) {
            return '<tr><td>' + fmtDate(l.At) + '</td><td>' + esc(l.Event) + '</td><td>' + esc(l.Message) + (l.BridgeID ? '<br><small>' + esc(l.BridgeID) + '</small>' : '') + '</td></tr>';
          }).join('') + '</table></div><div class="btn-row"><button class="btn" id="lc">Close</button></div>', function (m, close) { $('#lc', m).onclick = close; });
        }).catch(showError);
      }; });
      if ($('#qbImp', root)) $('#qbImp', root).onclick = function () { qbImportDialog(); };
      if ($('#qbCreateAll', root)) $('#qbCreateAll', root).onclick = function () {
        confirmBox('Create in QuickBooks', 'Every active customer that is not linked to QuickBooks will be created there by the bridge, with the Prosol customer code as Account No. Customers whose name already exists in QuickBooks get the code added to the name. Continue?', 'Create').then(function (y) {
          if (!y) return;
          API.call('qb.createUnmappedCustomers').then(function (r) { toast(r.queued + ' customer(s) queued for QuickBooks.'); render(); }).catch(showError);
        });
      };
      if ($('#genKey', root)) $('#genKey', root).onclick = function () {
        confirmBox('Bridge key', st.keyCreatedAt ? 'Replacing the key disconnects the running bridge until the new key is pasted into it (ProsolQBBridge.exe --setup). Continue?' : 'Generate the key that the QuickBooks bridge uses to connect?', 'Generate').then(function (y) {
          if (!y) return;
          API.call('qb.generateKey').then(function (k) {
            modal('Bridge key', '<p>Copy this key now and paste it into the bridge on the QuickBooks PC (<b>ProsolQBBridge.exe --setup</b>). It is shown only once.</p><div class="secret" style="font-size:13px;word-break:break-all">' + esc(k.key) + '</div><div class="btn-row"><button class="btn primary" id="kc">Done</button></div>', function (m, close) { $('#kc', m).onclick = function () { close(); render(); }; });
          }).catch(showError);
        });
      };
    }).catch(showError);
  };

  var QB_TYPE_LABELS = { Assembly: 'Inventory assembly (manufactured)', Inventory: 'Inventory part', NonInventory: 'Non-inventory part', Service: 'Service' };
  /** Preview → choose finished-product groups and defaults → create in batches until done. */
  function qbImportDialog() {
    Promise.all([API.call('qb.importPreview'), API.call('salespersons.options').catch(function () { return []; })]).then(function (res) {
      var pv = res[0], sps = res[1] || [];
      var groups = pv.itemGroups || [];
      var body = (pv.detailsAvailable ? '' : '<div class="alert warn">QuickBooks has sent names only (no phone or address). Update the bridge on the QuickBooks PC to bring phone, address and price too, or continue and fill them in later.</div>') +
        (pv.canCustomers ? '<label class="check"><input type="checkbox" id="impC"' + (pv.customers.count ? ' checked' : ' disabled') + '> <b>Customers</b> — ' + pv.customers.count + ' to create' +
          (pv.customers.count ? ' (' + pv.customers.withPhone + ' with a phone number)' : ' (all are already in Prosol)') + '</label>' +
          (pv.customers.jobs ? '<label class="check" style="margin-left:26px"><input type="checkbox" id="impJobs"> also ' + pv.customers.jobs + ' sub-customers / jobs</label>' : '') +
          '<div class="form-grid" style="margin:8px 0 14px"><div class="field"><label>Salesperson (when the QuickBooks rep does not match)</label><select id="impSp"><option value="">— assign later —</option>' +
          sps.map(function (s) { return '<option value="' + esc(s.id || s.SalespersonID) + '">' + esc(s.label || s.Name) + '</option>'; }).join('') + '</select></div>' +
          '<div class="field"><label>Area (optional, for all)</label><input id="impArea" maxlength="100"></div></div>' : '') +
        (pv.canProducts ? '<div style="margin-top:6px"><b>Products</b> — tick the groups that are <b>finished products</b> you sell (leave raw materials and packaging unticked):</div>' +
          (groups.length ? '<div class="scroll-x" style="max-height:260px;overflow:auto;margin:6px 0"><table class="tbl"><tr><th></th><th>QuickBooks type</th><th>Parent / group</th><th class="n">Items</th><th>Examples</th></tr>' +
            groups.map(function (g, i) {
              return '<tr><td><input type="checkbox" class="impG" data-i="' + i + '"' + (g.type === 'Assembly' ? ' checked' : '') + '></td><td>' + esc(QB_TYPE_LABELS[g.type] || g.type) + '</td><td>' + (g.parent ? esc(g.parent) : '<i>(no parent)</i>') +
                '</td><td class="n">' + g.count + '</td><td style="font-size:12px">' + esc(g.sample.join(', ')) + '</td></tr>';
            }).join('') + '</table></div>' +
            '<div class="form-grid"><div class="field"><label>Units per carton (for all; check each product afterwards)</label><input id="impUpc" type="number" min="1" value="1"></div>' +
            '<div class="field"><label>Unit</label><input id="impUnit" value="Pcs" maxlength="30"></div></div>'
            : '<p class="hint">No items left to create (all sellable QuickBooks items are already in Prosol).</p>') : '') +
        '<div id="impOut"></div><div class="btn-row"><button class="btn primary" id="impGo">Create in Prosol</button><button class="btn" id="impX">Close</button></div>';
      modal('Create from QuickBooks', body, function (m, close) {
        $('#impX', m).onclick = function () { close(); render(); };
        $('#impGo', m).onclick = function () {
          var btn = this, sel = $all('.impG', m).filter(function (x) { return x.checked; }).map(function (x) { return groups[Number(x.dataset.i)].key; });
          var payload = { customers: !!($('#impC', m) && $('#impC', m).checked), products: sel.length > 0, itemGroups: sel,
            includeJobs: !!($('#impJobs', m) && $('#impJobs', m).checked), salespersonId: $('#impSp', m) ? $('#impSp', m).value : '',
            area: $('#impArea', m) ? $('#impArea', m).value : '', unitsPerCarton: $('#impUpc', m) ? $('#impUpc', m).value : 1, unit: $('#impUnit', m) ? $('#impUnit', m).value : 'Pcs' };
          if (!payload.customers && !payload.products) return toast('Tick customers and/or at least one product group.');
          var tot = { customers: 0, products: 0 }, nd = { noMobile: 0, noAddress: 0, noCity: 0, noSalesperson: 0, duplicateMobile: 0 }, noPrice = 0;
          busy(btn, true);
          var step = function () {
            return API.call('qb.importToApp', payload).then(function (r) {
              tot.customers += r.created.customers; tot.products += r.created.products; noPrice += r.noPrice || 0;
              Object.keys(nd).forEach(function (k) { nd[k] += r.needDetails[k] || 0; });
              $('#impOut', m).innerHTML = '<div class="alert">' + (r.done ? 'Finished' : 'Working…') + ' Created <b>' + tot.customers + '</b> customers and <b>' + tot.products + '</b> products' +
                (r.done ? '.' : ' (' + (r.remaining.customers + r.remaining.products) + ' left)') + '</div>';
              return r.done ? r : step();
            });
          };
          step().then(function () {
            busy(btn, false); btn.disabled = true;
            var notes = [];
            if (tot.customers) {
              var miss = [nd.noMobile + ' without a mobile number', nd.noAddress + ' without an address', nd.noCity + ' without a city', nd.noSalesperson + ' without a salesperson'].filter(function (x) { return x.charAt(0) !== '0'; });
              if (!payload.area) miss.push('area to fill in');
              if (nd.duplicateMobile) miss.push(nd.duplicateMobile + ' sharing a phone number with another shop (kept on the first one)');
              if (miss.length) notes.push('Customers: ' + esc(miss.join(', ')) + '. <a href="#/customers?incomplete=1">Show customers with details missing</a>');
            }
            if (tot.products) notes.push('Products: check <b>units per carton</b>' + (noPrice ? ', and the price of ' + noPrice + ' products that have no price in QuickBooks' : '') + '. <a href="#/products?review=1">Show products to check</a>');
            $('#impOut', m).innerHTML = '<div class="alert good">Done. Created <b>' + tot.customers + '</b> customers and <b>' + tot.products + '</b> products, all mapped to QuickBooks.</div>' +
              (notes.length ? '<ul style="font-size:14px">' + notes.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>' : '');
            $all('#impOut a', m).forEach(function (a) { a.addEventListener('click', function () { close(); }); });
          }).catch(function (e) { busy(btn, false); showError(e); });
        };
      });
    }).catch(showError);
  }

  // ---------- delivery: shared helpers ----------
  var TRIP_LABELS = { PLANNED: 'Planned', OUT: 'Out for delivery', COMPLETED: 'Completed', CANCELLED: 'Cancelled' };
  var STOP_LABELS = { PENDING: 'Pending', DELIVERED: 'Delivered', PARTIAL: 'Partially delivered', FAILED: 'Not delivered', REMOVED: 'Removed' };
  var RETURN_REASON_LABELS = { DAMAGED: 'Damaged', EXPIRED: 'Expired', WRONG_ITEM: 'Wrong item', NOT_ORDERED: 'Not ordered', CUSTOMER_REFUSED: 'Customer refused', OTHER: 'Other' };
  var FAIL_REASONS = ['Shop closed', 'Owner not available', 'Customer refused', 'Payment / credit hold', 'Address not found', 'Vehicle problem'];
  function todayStr() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' }); }
  function tripBadge(st) { return '<span class="badge ' + ({ OUT: 'warn', COMPLETED: 'good', CANCELLED: 'bad' }[st] || '') + '">' + esc(TRIP_LABELS[st] || st) + '</span>'; }
  function stopBadge(st) { return '<span class="badge ' + ({ DELIVERED: 'good', PARTIAL: 'warn', FAILED: 'bad' }[st] || '') + '">' + esc(STOP_LABELS[st] || st) + '</span>'; }
  function gpsStopBadge(s) {
    if (!s.GPSStatus) return '';
    var d = s.DistanceMeters === '' ? '' : (s.DistanceMeters >= 1000 ? (s.DistanceMeters / 1000).toFixed(1) + ' km' : s.DistanceMeters + ' m');
    return { VERIFIED: '<span class="badge good">Location verified · ' + d + '</span>', NEAR: '<span class="badge warn">' + d + ' from shop</span>',
      MISMATCH: '<span class="badge bad">' + d + ' from shop</span>', NO_CUSTOMER_GPS: '<span class="badge">Shop GPS not saved</span>',
      NO_DRIVER_GPS: '<span class="badge bad">No driver GPS</span>', RECORDED: '<span class="badge">GPS recorded</span>' }[s.GPSStatus] || '';
  }
  function navLink(c) {
    if (c.Latitude !== '' && c.Latitude !== undefined && c.Latitude !== null) return mapsNav(c.Latitude, c.Longitude);
    return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent([c.ShopName, c.Address, c.Area, c.City].filter(Boolean).join(', ')) + '&travelmode=driving';
  }
  /** Google Maps route through pending stops in sequence (stops with saved GPS; Maps URLs accept a limited number of waypoints). */
  function routeLink(stops) {
    var pts = stops.filter(function (s) { return s.Status === 'PENDING' && s.Customer.Latitude !== ''; }).slice(0, 10);
    if (!pts.length) return null;
    var dest = pts[pts.length - 1].Customer, wps = pts.slice(0, -1).map(function (s) { return s.Customer.Latitude + ',' + s.Customer.Longitude; });
    return 'https://www.google.com/maps/dir/?api=1&destination=' + dest.Latitude + ',' + dest.Longitude + (wps.length ? '&waypoints=' + encodeURIComponent(wps.join('|')) : '') + '&travelmode=driving';
  }
  function qty(n) { return (Math.round(Number(n) * 1000) / 1000).toLocaleString('en-US'); }

  // ---------- fleet ----------
  VIEWS.fleet = function () {
    loading('Fleet');
    Promise.all([API.call('fleet.drivers', {}), API.call('fleet.vehicles', {}), can('drivers.manage') ? API.call('fleet.driverLogins') : Promise.resolve([])]).then(function (res) {
      var drivers = res[0].items, vans = res[1].items, logins = res[2];
      var html = '<div class="card"><h2>Drivers</h2><ul class="list">' + (drivers.map(function (d, i) {
        return '<li><a class="row" role="button" tabindex="0" style="cursor:pointer" data-d="' + i + '"><span class="main-t"><div class="t1">' + esc(d.Name) + '</div><div class="t2">' + esc(d.DriverID) + ' · ' + esc(d.Mobile) + (d.UserID ? '' : ' · <b>no login linked</b>') + '</div></span>' + badge(d.Active) + '</a></li>';
      }).join('') || '<li><div class="row">No drivers yet</div></li>') + '</ul>' + (can('drivers.manage') ? '<div class="btn-row"><button class="btn" id="dNew">+ Driver</button></div>' : '') + '</div>';
      html += '<div class="card"><h2>Vehicles</h2><ul class="list">' + (vans.map(function (v, i) {
        return '<li><a class="row" role="button" tabindex="0" style="cursor:pointer" data-v="' + i + '"><span class="main-t"><div class="t1">' + esc(v.RegistrationNo) + ' · ' + esc(v.VehicleType) + '</div><div class="t2">Capacity ' + (v.CapacityCartons === '' ? '—' : v.CapacityCartons + ' cartons') + (v.DefaultDriverName ? ' · ' + esc(v.DefaultDriverName) : '') + (v.DefaultHelper ? ' · helper ' + esc(v.DefaultHelper) : '') + '</div></span>' + badge(v.Active) + '</a></li>';
      }).join('') || '<li><div class="row">No vehicles yet</div></li>') + '</ul>' + (can('vehicles.manage') ? '<div class="btn-row"><button class="btn" id="vNew">+ Vehicle</button></div>' : '') + '</div>';
      var root = shell('Fleet', html);
      var dModal = function (d) {
        var f = [{ name: 'Name', label: 'Name', required: true }, { name: 'Mobile', label: 'Mobile', type: 'tel', required: true }, { name: 'LicenseNo', label: 'Licence no.' },
          { name: 'UserID', label: 'Login (user with Driver role)', type: 'select', options: logins.filter(function (l) { return !l.linked || (d && l.linked === d.DriverID); }).map(function (l) { return { value: l.id, label: l.label }; }) },
          { name: 'Active', label: 'Active', type: 'checkbox', dflt: true }];
        modal(d ? d.Name : 'New driver', '<form id="df">' + formHtml(f, d) + '<div class="btn-row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" id="dc">Cancel</button></div></form>', function (m, close) {
          $('#dc', m).onclick = close; var fm = $('#df', m);
          fm.onsubmit = function (ev) { ev.preventDefault(); var b = $('button[type=submit]', fm); busy(b, true); var x = readForm(fm, f); if (d) x.DriverID = d.DriverID;
            API.call('fleet.saveDriver', x).then(function () { close(); toast('Driver saved.'); render(); }).catch(function (e) { busy(b, false); fieldError(fm, e); }); };
        });
      };
      var vModal = function (v) {
        var f = [{ name: 'RegistrationNo', label: 'Registration no.', required: true }, { name: 'VehicleType', label: 'Type', placeholder: 'e.g. Suzuki Ravi, Shehzore' },
          { name: 'CapacityCartons', label: 'Capacity (cartons)', type: 'number' },
          { name: 'DefaultDriverID', label: 'Usual driver', type: 'select', options: drivers.filter(function (x) { return x.Active; }).map(function (x) { return { value: x.DriverID, label: x.Name }; }) },
          { name: 'DefaultHelper', label: 'Usual helper' }, { name: 'Active', label: 'Active', type: 'checkbox', dflt: true }];
        modal(v ? v.RegistrationNo : 'New vehicle', '<form id="vf">' + formHtml(f, v) + '<div class="btn-row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" id="vc">Cancel</button></div></form>', function (m, close) {
          $('#vc', m).onclick = close; var fm = $('#vf', m);
          fm.onsubmit = function (ev) { ev.preventDefault(); var b = $('button[type=submit]', fm); busy(b, true); var x = readForm(fm, f); if (v) x.VehicleID = v.VehicleID;
            API.call('fleet.saveVehicle', x).then(function () { close(); toast('Vehicle saved.'); render(); }).catch(function (e) { busy(b, false); fieldError(fm, e); }); };
        });
      };
      if ($('#dNew', root)) $('#dNew', root).onclick = function () { dModal(null); };
      if ($('#vNew', root)) $('#vNew', root).onclick = function () { vModal(null); };
      $all('[data-d]', root).forEach(function (a) { a.onclick = function () { if (can('drivers.manage')) dModal(drivers[Number(a.dataset.d)]); }; });
      $all('[data-v]', root).forEach(function (a) { a.onclick = function () { if (can('vehicles.manage')) vModal(vans[Number(a.dataset.v)]); }; });
    }).catch(showError);
  };

  // ---------- planning ----------
  function tripFormFields(drivers, vans, rec) {
    return [
      { name: 'DeliveryDate', label: 'Delivery date', type: 'date', required: true, dflt: todayStr() },
      { name: 'VehicleID', label: 'Vehicle', type: 'select', required: true, options: vans.filter(function (v) { return v.Active; }).map(function (v) { return { value: v.VehicleID, label: v.RegistrationNo + ' (' + (v.CapacityCartons || '?') + ' ctn)' }; }) },
      { name: 'DriverID', label: 'Driver', type: 'select', required: true, options: drivers.filter(function (d) { return d.Active; }).map(function (d) { return { value: d.DriverID, label: d.Name + (d.UserID ? '' : ' (no login)') }; }) },
      { name: 'Helper', label: 'Helper' }, { name: 'Route', label: 'Route / area', placeholder: 'e.g. Saddar – Committee Chowk' }
    ];
  }

  VIEWS.planning = function (r) {
    var q = r.q;
    loading('Delivery planning');
    Promise.all([API.call('delivery.ready', { q: q.q, area: q.area }), API.call('fleet.drivers', {}), API.call('fleet.vehicles', {})]).then(function (res) {
      var list = res[0], drivers = res[1].items, vans = res[2].items, sel = {};
      var fields = tripFormFields(drivers, vans);
      var html = '<div class="toolbar"><input type="search" class="search" id="plq" placeholder="Order no., shop, area" value="' + esc(q.q || '') + '">' +
        '<select id="plArea"><option value="">All areas</option>' + list.areas.map(function (a) { return '<option' + (a === q.area ? ' selected' : '') + '>' + esc(a) + '</option>'; }).join('') + '</select>' +
        '<button class="btn" id="plAll">Select all</button><a class="btn" href="#/trips">Trips</a></div>';
      html += list.items.length ? '<ul class="list">' + list.items.map(function (o, i) {
        return '<li><label class="row" style="cursor:pointer"><input type="checkbox" data-o="' + i + '" style="width:22px;height:22px"><span class="main-t"><div class="t1">' + esc(o.CustomerName) + ' · ' + esc(o.OrderNo) + '</div>' +
          '<div class="t2">' + esc(o.Area) + ' · ' + esc(o.Address) + ' · ' + esc(o.SalespersonName) + (o.Status === 'PARTIALLY_DELIVERED' ? ' · <b>balance of partial delivery</b>' : '') + '</div></span>' +
          '<span style="text-align:right;white-space:nowrap"><b>' + o.RemainingCartons + ' ctn</b><br><small>' + money(o.RemainingValue) + '</small><br>' + (o.HasGPS ? '<span class="badge good">GPS</span>' : '<span class="badge warn">No GPS</span>') + '</span></label></li>';
      }).join('') + '</ul>' : '<div class="empty card">No orders are waiting for delivery.</div>';
      html += '<form class="card" id="tripForm" style="margin-top:14px"><h2>Create trip</h2><p id="selSum" style="margin:0 0 10px;font-weight:600">0 orders selected</p>' + formHtml(fields) +
        '<div class="btn-row"><button class="btn primary" type="submit">Create trip</button></div></form>';
      var root = shell('Delivery planning', html);
      var vanCap = {}; vans.forEach(function (v) { vanCap[v.VehicleID] = Number(v.CapacityCartons) || 0; });
      var dv = {}; vans.forEach(function (v) { dv[v.VehicleID] = v; });
      var f = $('#tripForm', root);
      var updateSum = function () {
        var ids = Object.keys(sel), ctn = 0, val = 0;
        ids.forEach(function (i) { ctn += list.items[i].RemainingCartons; val += list.items[i].RemainingValue; });
        var cap = vanCap[f.VehicleID.value] || 0;
        $('#selSum', root).innerHTML = ids.length + ' orders · ' + (Math.round(ctn * 100) / 100) + ' cartons · ' + money(Math.round(val * 100) / 100) +
          (cap ? ' · vehicle holds ' + cap + (ctn > cap ? ' <span class="badge bad">over capacity</span>' : '') : '');
      };
      f.VehicleID.onchange = function () { var v = dv[f.VehicleID.value]; if (v && v.DefaultDriverID && !f.DriverID.value) f.DriverID.value = v.DefaultDriverID; if (v && v.DefaultHelper && !f.Helper.value) f.Helper.value = v.DefaultHelper; updateSum(); };
      $all('[data-o]', root).forEach(function (cb) { cb.onchange = function () { if (cb.checked) sel[cb.dataset.o] = 1; else delete sel[cb.dataset.o]; updateSum(); }; });
      $('#plAll', root).onclick = function () { $all('[data-o]', root).forEach(function (cb) { cb.checked = true; sel[cb.dataset.o] = 1; }); updateSum(); };
      var t; $('#plq', root).oninput = function (ev) { clearTimeout(t); var sq = renderSeq; t = setTimeout(function () { if (sq !== renderSeq) return; go('planning?q=' + encodeURIComponent(ev.target.value) + (q.area ? '&area=' + encodeURIComponent(q.area) : '')); }, 450); };
      $('#plArea', root).onchange = function (ev) { go('planning?area=' + encodeURIComponent(ev.target.value)); };
      f.onsubmit = function (ev) {
        ev.preventDefault();
        var ids = Object.keys(sel).map(function (i) { return list.items[i].OrderID; });
        if (!ids.length) return toast('Select at least one order.', true);
        var data = readForm(f, fields); data.OrderIDs = ids;
        var b = $('button[type=submit]', f);
        var send = function (confirmCap) {
          busy(b, true); data.ConfirmOverCapacity = !!confirmCap;
          API.call('delivery.createTrip', data).then(function (trip) { toast('Trip ' + trip.TripNo + ' created.'); go('trips/' + encodeURIComponent(trip.DeliveryID)); })
            .catch(function (e) { busy(b, false); if (e.code === 'OVER_CAPACITY') return confirmBox('Over capacity', e.message, 'Create anyway').then(function (y) { if (y) send(true); }); fieldError(f, e); });
        };
        send(false);
      };
      updateSum();
    }).catch(showError);
  };

  // ---------- trips ----------
  VIEWS.trips = function (r) {
    if (r.seg[1] && r.seg[2] === 'stop') return stopView(r.seg[1], r.seg[3]);
    if (r.seg[1] && r.seg[2] === 'print') return tripPrint(r.seg[1]);
    if (r.seg[1] && r.seg[2] === 'summary') return tripSummaryPrint(r.seg[1]);
    if (r.seg[1]) return tripDetail(r.seg[1]);
    var q = r.q, from = q.from || todayStr(), to = q.to || '';
    loading('Trips');
    API.call('delivery.trips', { from: from, to: to, status: q.status }).then(function (list) {
      var html = '<div class="toolbar"><input type="date" id="tFrom" value="' + esc(from) + '"><input type="date" id="tTo" value="' + esc(to) + '">' +
        '<select id="tSt"><option value="">All statuses</option>' + Object.keys(TRIP_LABELS).map(function (k) { return '<option value="' + k + '"' + (q.status === k ? ' selected' : '') + '>' + TRIP_LABELS[k] + '</option>'; }).join('') + '</select>' +
        (can('delivery.plan') ? '<a class="btn primary" href="#/planning">+ Plan trip</a>' : '') + '</div>';
      html += list.items.length ? '<ul class="list">' + list.items.map(function (t) {
        return '<li><a class="row" href="#/trips/' + encodeURIComponent(t.DeliveryID) + '"><span class="main-t"><div class="t1">' + esc(t.TripNo) + ' · ' + esc(t.VehicleNo) + ' · ' + esc(t.DriverName) + '</div>' +
          '<div class="t2">' + fmtDate(t.DeliveryDate, false) + (t.Route ? ' · ' + esc(t.Route) : '') + ' · ' + t.Stops + ' stops: ' + t.Delivered + ' delivered, ' + t.Partial + ' partial, ' + t.Failed + ' not delivered, ' + t.Pending + ' pending</div></span>' +
          tripBadge(t.Status) + (t.GPSFlags ? ' <span class="badge bad">' + t.GPSFlags + ' GPS</span>' : '') + '</a></li>';
      }).join('') + '</ul>' : '<div class="empty card">No trips in this period.</div>';
      var root = shell('Trips', html);
      var setQ = function (p) { var n = Object.assign({ from: from, to: to }, q, p); go('trips?' + Object.keys(n).filter(function (k) { return n[k]; }).map(function (k) { return k + '=' + encodeURIComponent(n[k]); }).join('&')); };
      $('#tFrom', root).onchange = function (ev) { setQ({ from: ev.target.value }); };
      $('#tTo', root).onchange = function (ev) { setQ({ to: ev.target.value }); };
      $('#tSt', root).onchange = function (ev) { setQ({ status: ev.target.value }); };
    }).catch(showError);
  };

  function tripDetail(id) {
    loading('Trip', can('delivery.plan') ? 'trips' : 'deliveries');
    API.call('delivery.trip', { DeliveryID: id }).then(drawTrip).catch(function (e) { showError(e); go(can('delivery.plan') ? 'trips' : 'deliveries'); });
  }

  function drawTrip(t) {
    var planner = t.CanPlan, editable = planner && (t.Status === 'PLANNED' || t.Status === 'OUT');
    var html = '<div class="card"><div style="display:flex;justify-content:space-between;gap:8px"><div><h2 style="margin:0">' + esc(t.TripNo) + '</h2><div style="color:var(--muted);font-size:14px">' + fmtDate(t.DeliveryDate, false) + ' · ' + esc(t.VehicleNo) + ' · ' + esc(t.DriverName) + (t.Helper ? ' + ' + esc(t.Helper) : '') + (t.Route ? ' · ' + esc(t.Route) : '') + '</div></div>' + tripBadge(t.Status) + '</div>' +
      '<p style="margin:10px 0 0">' + t.Stops + ' stops · to deliver ' + t.Totals.cartons + ' ctn / ' + money(t.Totals.value) + ' · delivered ' + money(t.Totals.delivered) + (t.VehicleCapacity ? ' · capacity ' + t.VehicleCapacity + ' ctn' : '') + '</p>' +
      '<div class="btn-row">' + ((t.IsMyTrip || planner) && t.Status === 'PLANNED' ? '<button class="btn primary" id="tStart">Start trip</button>' : '') +
      ((t.IsMyTrip || planner) && t.Status === 'OUT' ? '<button class="btn" id="tFinish">Finish trip</button>' : '') +
      (routeLink(t.StopsList) ? '<a class="btn" target="_blank" rel="noopener" href="' + routeLink(t.StopsList) + '">🗺 Route in Google Maps</a>' : '') +
      (editable ? '<button class="btn" id="tAdd">+ Add orders</button><button class="btn" id="tEdit">Change van / driver / date</button>' : '') +
      (planner && t.Status === 'PLANNED' ? '<button class="btn danger" id="tCancel">Cancel trip</button>' : '') +
      '<a class="btn" href="#/trips/' + encodeURIComponent(t.DeliveryID) + '/print">Print</a>' + (t.StopsList.some(function (s) { return s.Status !== 'PENDING'; }) ? '<a class="btn" href="#/trips/' + encodeURIComponent(t.DeliveryID) + '/summary">Delivery summary</a>' : '') + '</div></div>';
    html += '<ul class="list">' + t.StopsList.map(function (s, i) {
      return '<li><div class="row"><span style="font-weight:800;width:26px;text-align:center">' + s.Sequence + '</span><a class="main-t" style="text-decoration:none;color:inherit" href="#/trips/' + encodeURIComponent(t.DeliveryID) + '/stop/' + encodeURIComponent(s.DeliveryOrderID) + '">' +
        '<div class="t1">' + esc(s.Customer.ShopName) + '</div><div class="t2">' + esc(s.OrderNo) + ' · ' + esc(s.Customer.Area) + ' · ' + (s.Status === 'PENDING' ? s.Remaining.cartons + ' ctn · ' + money(s.Remaining.value) : 'delivered ' + money(s.DeliveredNet)) + '</div>' +
        '<div style="margin-top:4px">' + stopBadge(s.Status) + ' ' + gpsStopBadge(s) + (s.LocalPending ? ' <span class="badge warn">Waiting to send</span>' : '') + (s.Customer.Latitude === '' ? ' <span class="badge warn">No shop GPS</span>' : '') + '</div></a>' +
        '<span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">' +
        (s.Status === 'PENDING' ? '<a class="btn" style="min-height:40px;padding:0 12px" target="_blank" rel="noopener" href="' + navLink(s.Customer) + '">Navigate</a>' : '') +
        (editable && s.Status === 'PENDING' ? '<button class="btn" style="min-height:40px;padding:0 10px" data-up="' + i + '" aria-label="Move up">↑</button><button class="btn" style="min-height:40px;padding:0 10px" data-down="' + i + '" aria-label="Move down">↓</button><button class="btn danger" style="min-height:40px;padding:0 10px" data-rm="' + i + '" aria-label="Remove">✕</button>' : '') +
        '</span></div></li>';
    }).join('') + '</ul>';
    var root = shell(t.TripNo, html, { back: planner ? 'trips' : 'deliveries' });
    var update = function (payload, msg, btn) {
      busy(btn, true);
      var send = function (confirmCap) {
        API.call('delivery.updateTrip', Object.assign({ DeliveryID: t.DeliveryID, Version: t.Version, ConfirmOverCapacity: !!confirmCap }, payload)).then(function (fresh) { toast(msg); drawTrip(fresh); })
          .catch(function (e) { busy(btn, false); if (e.code === 'OVER_CAPACITY') return confirmBox('Over capacity', e.message, 'Continue').then(function (y) { if (y) send(true); }); showError(e); });
      };
      send(false);
    };
    var ids = t.StopsList.map(function (s) { return s.DeliveryOrderID; });
    $all('[data-up]', root).forEach(function (b) { b.onclick = function () { var i = Number(b.dataset.up); if (i === 0) return; var o = ids.slice(); o.splice(i - 1, 0, o.splice(i, 1)[0]); update({ StopOrder: o }, 'Order of stops updated.', b); }; });
    $all('[data-down]', root).forEach(function (b) { b.onclick = function () { var i = Number(b.dataset.down); if (i >= ids.length - 1) return; var o = ids.slice(); o.splice(i + 1, 0, o.splice(i, 1)[0]); update({ StopOrder: o }, 'Order of stops updated.', b); }; });
    $all('[data-rm]', root).forEach(function (b) { b.onclick = function () { var s = t.StopsList[Number(b.dataset.rm)];
      confirmBox('Remove stop', 'Take ' + s.Customer.ShopName + ' (' + s.OrderNo + ') off this trip? The order goes back to the planning list.', 'Remove').then(function (y) { if (y) update({ RemoveStopIDs: [s.DeliveryOrderID] }, 'Stop removed.', b); }); }; });
    if ($('#tStart', root)) $('#tStart', root).onclick = function () { var b = this; busy(b, true); API.call('delivery.startTrip', { DeliveryID: t.DeliveryID }).then(function (f) { toast(savedMsg(f, 'Trip started. Drive safely.')); drawTrip(f); }).catch(function (e) { busy(b, false); showError(e); }); };
    if ($('#tFinish', root)) $('#tFinish', root).onclick = function () {
      var pending = t.StopsList.filter(function (s) { return s.Status === 'PENDING'; }).length;
      confirmBox('Finish trip', pending ? pending + ' stop(s) were not attempted. They will be marked "Not delivered" and go back to planning.' : 'Mark this trip as completed?', 'Finish').then(function (y) {
        if (!y) return; API.call('delivery.finishTrip', { DeliveryID: t.DeliveryID }).then(function (f) { toast('Trip finished.'); drawTrip(f); }).catch(showError);
      });
    };
    if ($('#tCancel', root)) $('#tCancel', root).onclick = function () {
      modal('Cancel trip ' + t.TripNo, '<div class="field"><label>Reason *</label><input type="text" id="cr"><div class="ferr" data-err="Reason"></div></div><div class="btn-row"><button class="btn danger" id="cok">Cancel trip</button><button class="btn" id="cno">Back</button></div>', function (m, close) {
        $('#cno', m).onclick = close;
        $('#cok', m).onclick = function () { var b = this; busy(b, true); API.call('delivery.cancelTrip', { DeliveryID: t.DeliveryID, Reason: $('#cr', m).value }).then(function (f) { close(); toast('Trip cancelled; orders released.'); drawTrip(f); }).catch(function (e) { busy(b, false); fieldError(m, e); }); };
      });
    };
    if ($('#tAdd', root)) $('#tAdd', root).onclick = function () {
      API.call('delivery.ready', {}).then(function (list) {
        modal('Add orders to ' + t.TripNo, (list.items.length ? '<ul class="list" style="max-height:50vh;overflow:auto">' + list.items.map(function (o, i) {
          return '<li><label class="row"><input type="checkbox" data-a="' + i + '" style="width:22px;height:22px"><span class="main-t"><div class="t1">' + esc(o.CustomerName) + ' · ' + esc(o.OrderNo) + '</div><div class="t2">' + esc(o.Area) + ' · ' + o.RemainingCartons + ' ctn · ' + money(o.RemainingValue) + '</div></span></label></li>';
        }).join('') + '</ul>' : '<p>No orders waiting.</p>') + '<div class="btn-row"><button class="btn primary" id="aok">Add selected</button><button class="btn" id="ano">Cancel</button></div>', function (m, close) {
          $('#ano', m).onclick = close;
          $('#aok', m).onclick = function () { var sel = $all('[data-a]:checked', m).map(function (c) { return list.items[Number(c.dataset.a)].OrderID; }); if (!sel.length) return; close(); update({ AddOrderIDs: sel }, sel.length + ' order(s) added.', $('#tAdd')); };
        });
      }).catch(showError);
    };
    if ($('#tEdit', root)) $('#tEdit', root).onclick = function () {
      Promise.all([API.call('fleet.drivers', {}), API.call('fleet.vehicles', {})]).then(function (res) {
        var fields = tripFormFields(res[0].items, res[1].items);
        modal('Trip details', '<form id="tef">' + formHtml(fields, t) + '<div class="btn-row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" id="tec">Cancel</button></div></form>', function (m, close) {
          $('#tec', m).onclick = close; var fm = $('#tef', m);
          fm.onsubmit = function (ev) { ev.preventDefault(); close(); update(readForm(fm, fields), 'Trip updated.', $('#tEdit')); };
        });
      }).catch(showError);
    };
  }

  // ---------- driver: stop screen ----------
  function stopView(tripId, stopId) {
    loading('Delivery', 'trips/' + encodeURIComponent(tripId));
    API.call('delivery.trip', { DeliveryID: tripId }).then(function (t) {
      var s = t.StopsList.filter(function (x) { return x.DeliveryOrderID === stopId; })[0];
      if (!s) { toast('Stop not found.', true); return go('trips/' + encodeURIComponent(tripId)); }
      drawStop(t, s);
    }).catch(showError);
  }

  function drawStop(t, s) {
    var c = s.Customer, pending = s.Status === 'PENDING', mine = t.IsMyTrip || t.CanPlan;
    var html = '<div class="card"><div style="display:flex;justify-content:space-between;gap:8px"><div><h2 style="margin:0">' + esc(c.ShopName) + '</h2><div style="color:var(--muted);font-size:14px">' + esc(s.OrderNo) + ' · stop ' + s.Sequence + ' of ' + t.Stops + '</div></div>' + stopBadge(s.Status) + '</div>' +
      '<p style="margin:10px 0">' + esc(c.Address) + ', ' + esc(c.Area) + ', ' + esc(c.City) + (c.ContactPerson ? '<br>' + esc(c.ContactPerson) : '') + '</p>' +
      '<div class="btn-row">' + (pending ? '<a class="btn primary" target="_blank" rel="noopener" href="' + navLink(c) + '" id="navBtn">🧭 Navigate</a>' : '') +
      (c.Mobile ? '<a class="btn" href="tel:' + esc(c.Mobile) + '">📞 Call</a>' : '') + (c.WhatsApp ? '<a class="btn" target="_blank" rel="noopener" href="https://wa.me/' + esc(c.WhatsApp.replace(/^0/, '92').replace(/^\+/, '')) + '">WhatsApp</a>' : '') + '</div>' +
      (c.Latitude === '' ? '<div class="alert warn" style="margin-top:10px">This shop has no saved GPS location — navigation uses the written address.</div>' : '') +
      (s.OrderRemarks ? '<p style="font-size:14px"><b>Order note:</b> ' + esc(s.OrderRemarks) + '</p>' : '') + '</div>';
    if (pending && mine) {
      html += '<form class="card" id="delForm"><h2>Delivered quantities</h2><div class="btn-row" style="margin:0 0 10px"><button type="button" class="btn" id="qAll">Deliver everything</button><button type="button" class="btn" id="qNone">Clear</button></div>' +
        s.Lines.map(function (l, i) {
          return '<div style="border-top:1px solid var(--line);padding:10px 0"><div style="font-weight:600">' + esc(l.ProductName) + ' <small style="color:var(--muted)">' + esc(l.SKU) + '</small></div>' +
            '<div style="font-size:13px;color:var(--muted)">To deliver: <b>' + qty(l.Outstanding) + ' ' + esc(l.Unit) + '</b> (' + qty(l.Outstanding / l.UnitsPerCarton) + ' ctn of ' + l.UnitsPerCarton + ')' + (l.Delivered ? ' · already delivered ' + qty(l.Delivered) : '') + '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px"><label style="font-size:13px">Cartons<input type="number" inputmode="numeric" min="0" step="1" data-ctn="' + i + '"></label>' +
            '<label style="font-size:13px">Loose ' + esc(l.Unit) + '<input type="number" inputmode="decimal" min="0" step="any" data-loose="' + i + '"></label></div>' +
            '<div style="font-size:13px;margin-top:4px" data-sum="' + i + '"></div></div>';
        }).join('') +
        '<div class="field" style="margin-top:12px"><label>Remarks</label><input type="text" id="dRem" placeholder="e.g. received by owner"></div>' +
        '<div class="field"><label>Delivery photo (optional)</label><input type="file" accept="image/*" capture="environment" id="dPhoto"><img id="dPhotoPrev" alt="" style="max-width:160px;display:none;margin-top:6px;border-radius:8px"></div>' +
        '<div class="field"><label>Customer signature (optional)</label><canvas id="sig" width="600" height="200" style="width:100%;max-width:420px;height:140px;border:1px solid var(--line);border-radius:10px;background:#fff;touch-action:none"></canvas><div><button type="button" class="btn" id="sigClear" style="min-height:36px;margin-top:6px">Clear signature</button></div></div>' +
        '<div class="btn-row"><button class="btn primary" type="submit" id="dOk">✔ Confirm delivery</button><button class="btn danger" type="button" id="dFail">Could not deliver</button></div>' +
        '<p class="hint" style="font-size:12px;color:var(--muted)">Your GPS position is recorded and compared with the shop location.</p></form>';
    } else {
      html += '<div class="card"><h2>Result</h2>' + (s.LocalPending ? '<div class="alert warn">Saved on this phone — waiting to be sent. Values shown are estimates until the office receives it.</div>' : '') + '<dl class="kv"><dt>Status</dt><dd>' + stopBadge(s.Status) + '</dd><dt>When</dt><dd>' + fmtDate(s.DeliveredAt) + ' · ' + esc(s.ConfirmedByName) + '</dd>' +
        '<dt>GPS</dt><dd>' + (gpsStopBadge(s) || '—') + (s.OverrideReason ? '<br><small>' + esc(s.OverrideReason) + '</small>' : '') + '</dd>' + (s.Remarks ? '<dt>Remarks</dt><dd>' + esc(s.Remarks) + '</dd>' : '') +
        '<dt>Delivered value</dt><dd>' + money(s.DeliveredNet) + '</dd></dl>' +
        '<table class="tbl" style="margin-top:10px"><tr><th>Product</th><th>This stop</th><th>Still to deliver</th></tr>' + s.Lines.map(function (l) {
          return '<tr><td>' + esc(l.ProductName) + '</td><td>' + (l.ThisStopQty === '' ? '—' : qty(l.ThisStopQty) + ' ' + esc(l.Unit)) + '</td><td>' + (l.Outstanding > 0 ? '<b>' + qty(l.Outstanding) + '</b>' : '0') + '</td></tr>';
        }).join('') + '</table>' +
        '<div class="btn-row">' + (s.HasPhoto ? '<button class="btn" id="vPhoto">View photo</button>' : '') + (s.HasSignature ? '<button class="btn" id="vSig">View signature</button>' : '') +
        (can('returns.create') && s.Lines.some(function (l) { return l.Delivered > l.Returned; }) ? '<button class="btn" id="dRet">Record return</button>' : '') + '</div></div>';
    }
    var root = shell(c.ShopName, html, { back: 'trips/' + encodeURIComponent(t.DeliveryID) });
    var proofView = function (kind) { API.call('delivery.proof', { DeliveryOrderID: s.DeliveryOrderID, kind: kind }).then(function (p) {
      modal(kind === 'photo' ? 'Delivery photo' : 'Signature', '<img src="' + p.dataUrl + '" style="max-width:100%;border-radius:8px" alt=""><div class="btn-row"><button class="btn" id="pc">Close</button></div>', function (m, close) { $('#pc', m).onclick = close; });
    }).catch(showError); };
    if ($('#vPhoto', root)) $('#vPhoto', root).onclick = function () { proofView('photo'); };
    if ($('#vSig', root)) $('#vSig', root).onclick = function () { proofView('signature'); };
    if ($('#dRet', root)) $('#dRet', root).onclick = function () { returnModal(s.Lines, function () { stopView(t.DeliveryID, s.DeliveryOrderID); }); };
    if (!(pending && mine)) return;

    // quantities
    var units = function (i) { var l = s.Lines[i]; return (Number($('[data-ctn="' + i + '"]', root).value) || 0) * l.UnitsPerCarton + (Number($('[data-loose="' + i + '"]', root).value) || 0); };
    var showSum = function (i) { var l = s.Lines[i], u = units(i); var el = $('[data-sum="' + i + '"]', root);
      el.innerHTML = '= ' + qty(u) + ' ' + esc(l.Unit) + (u > l.Outstanding ? ' <span class="badge bad">more than ordered</span>' : u < l.Outstanding && u > 0 ? ' <span class="badge warn">partial — ' + qty(l.Outstanding - u) + ' left</span>' : u === 0 ? ' <span class="badge">none</span>' : ' <span class="badge good">all</span>'); };
    var setAll = function (full) { s.Lines.forEach(function (l, i) {
      var o = full ? l.Outstanding : 0, ctn = Math.floor(o / l.UnitsPerCarton + 1e-9);
      $('[data-ctn="' + i + '"]', root).value = ctn; $('[data-loose="' + i + '"]', root).value = Math.round((o - ctn * l.UnitsPerCarton) * 1000) / 1000; showSum(i); }); };
    $all('[data-ctn],[data-loose]', root).forEach(function (inp) { inp.oninput = function () { showSum(Number(inp.dataset.ctn || inp.dataset.loose)); }; });
    $('#qAll', root).onclick = function () { setAll(true); };
    $('#qNone', root).onclick = function () { setAll(false); };
    setAll(true);

    // photo (resized on the phone to keep uploads small)
    var photoData = null;
    $('#dPhoto', root).onchange = function (ev) {
      var file = ev.target.files && ev.target.files[0]; if (!file) return;
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var scale = Math.min(1, 1280 / Math.max(img.width, img.height)), cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        photoData = cv.toDataURL('image/jpeg', 0.72);
        URL.revokeObjectURL(url);
        var pv = $('#dPhotoPrev', root); pv.src = photoData; pv.style.display = 'block';
      };
      img.onerror = function () { toast('Could not read that photo.', true); };
      img.src = url;
    };
    // signature pad
    var cv = $('#sig', root), ctx2 = cv.getContext('2d'), drawing = false, signed = false;
    ctx2.lineWidth = 3; ctx2.lineCap = 'round'; ctx2.strokeStyle = '#111';
    var pt = function (e) { var r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height }; };
    cv.addEventListener('pointerdown', function (e) { drawing = true; signed = true; var p = pt(e); ctx2.beginPath(); ctx2.moveTo(p.x, p.y); cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', function (e) { if (!drawing) return; var p = pt(e); ctx2.lineTo(p.x, p.y); ctx2.stroke(); });
    cv.addEventListener('pointerup', function () { drawing = false; });
    $('#sigClear', root).onclick = function () { ctx2.clearRect(0, 0, cv.width, cv.height); signed = false; };

    var clientUUID = uuid();
    $('#delForm', root).onsubmit = function (ev) {
      ev.preventDefault();
      var lines = s.Lines.map(function (l, i) { return { OrderLineID: l.OrderLineID, Quantity: Math.round(units(i) * 1000) / 1000 }; });
      if (!lines.some(function (l) { return l.Quantity > 0; })) return toast('Enter what was delivered, or use "Could not deliver".', true);
      var btn = $('#dOk', root); busy(btn, true);
      var payload = { DeliveryOrderID: s.DeliveryOrderID, ClientUUID: clientUUID, Lines: lines, Remarks: $('#dRem', root).value, Photo: photoData, Signature: signed ? cv.toDataURL('image/png') : null };
      var send = function (extra) {
        return API.call('delivery.confirm', Object.assign({}, payload, extra || {})).then(function (fresh) {
          toast(savedMsg(fresh, 'Delivery confirmed.'));
          var next = fresh.StopsList.filter(function (x) { return x.Status === 'PENDING'; })[0];
          if (next) go('trips/' + encodeURIComponent(fresh.DeliveryID) + '/stop/' + encodeURIComponent(next.DeliveryOrderID)); else go('trips/' + encodeURIComponent(fresh.DeliveryID));
        });
      };
      var withGps = function (pos) {
        var g = pos ? { Latitude: pos.lat, Longitude: pos.lng, Accuracy: pos.accuracy, DeviceTime: new Date().toISOString() } : {};
        if (!pos && t.CanPlan && !t.IsMyTrip) {
          return new Promise(function (res, rej) {
            modal('Confirm for the driver', '<div class="field"><label>Why are you confirming instead of the driver? *</label><input type="text" id="obr"><div class="ferr" data-err="OnBehalfReason"></div></div><div class="btn-row"><button class="btn primary" id="obok">Confirm</button><button class="btn" id="obno">Back</button></div>', function (m, close) {
              $('#obno', m).onclick = function () { close(); rej({ message: 'Not confirmed.' }); };
              $('#obok', m).onclick = function () { close(); send({ OnBehalfReason: $('#obr', m).value }).then(res, rej); };
            });
          });
        }
        return send(g).catch(function (e) {
          if (e.code !== 'GPS_MISMATCH') throw e;
          return new Promise(function (res, rej) {
            modal('Location warning', '<div class="alert bad">' + esc(e.message) + '</div><div class="field"><label>Reason *</label><input type="text" id="ovr" placeholder="e.g. customer met us at another branch"><div class="ferr" data-err="OverrideReason"></div></div>' +
              '<div class="btn-row"><button class="btn primary" id="ovok">Confirm anyway</button><button class="btn" id="ovno">Back</button></div>', function (m, close) {
              $('#ovno', m).onclick = function () { close(); rej({ message: 'Delivery not confirmed.' }); };
              $('#ovok', m).onclick = function () { var b = this; busy(b, true); send(Object.assign({ OverrideReason: $('#ovr', m).value }, g)).then(function (r) { close(); res(r); }).catch(function (e2) { busy(b, false); fieldError(m, e2); }); };
            });
          });
        });
      };
      getPosition().then(withGps, function (gpsErr) { if (t.CanPlan && !t.IsMyTrip) return withGps(null); throw gpsErr; })
        .catch(function (e) { busy(btn, false); showError(e); });
    };
    $('#dFail', root).onclick = function () {
      modal('Could not deliver', '<div class="field"><label>Reason *</label><select id="fr">' + FAIL_REASONS.map(function (r) { return '<option>' + esc(r) + '</option>'; }).join('') + '<option value="">Other…</option></select></div>' +
        '<div class="field"><label>Details</label><input type="text" id="frx" placeholder="Required for Other"><div class="ferr" data-err="Reason"></div></div>' +
        '<div class="btn-row"><button class="btn danger" id="fok">Save</button><button class="btn" id="fno">Back</button></div>', function (m, close) {
        $('#fno', m).onclick = close;
        $('#fok', m).onclick = function () {
          var b = this; busy(b, true);
          var reason = ($('#fr', m).value + ($('#frx', m).value ? ' — ' + $('#frx', m).value : '')).replace(/^ — /, '');
          var send = function (pos) {
            return API.call('delivery.fail', Object.assign({ DeliveryOrderID: s.DeliveryOrderID, ClientUUID: clientUUID, Reason: reason },
              pos ? { Latitude: pos.lat, Longitude: pos.lng, Accuracy: pos.accuracy } : {}));
          };
          getPosition().then(send, function () { return send(null); }).then(function (fresh) { close(); toast(savedMsg(fresh, 'Saved. The order goes back for re-delivery.')); go('trips/' + encodeURIComponent(fresh.DeliveryID)); })
            .catch(function (e) { busy(b, false); fieldError(m, e); });
        };
      });
    };
  }

  // ---------- returns ----------
  function returnModal(lines, done) {
    var opts = lines.filter(function (l) { return (l.Delivered || l.DeliveredQty) > (l.Returned || l.ReturnedQty || 0); });
    if (!opts.length) return toast('Nothing delivered that can be returned.', true);
    var lid = function (l) { return l.OrderLineID || l.LineID; };
    modal('Record return', '<div class="field"><label>Product *</label><select id="rl">' + opts.map(function (l, i) {
      var d = l.Delivered !== undefined ? l.Delivered : l.DeliveredQty, r = l.Returned !== undefined ? l.Returned : l.ReturnedQty;
      return '<option value="' + i + '">' + esc(l.ProductName) + ' — delivered ' + qty(d) + ', returned ' + qty(r || 0) + ' ' + esc(l.Unit) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>Quantity returned (' + esc(opts[0].Unit) + ') *</label><input type="number" id="rq" inputmode="decimal" min="0" step="any"><div class="ferr" data-err="Quantity"></div></div>' +
      '<div class="field"><label>Reason *</label><select id="rr">' + Object.keys(RETURN_REASON_LABELS).map(function (k) { return '<option value="' + k + '">' + RETURN_REASON_LABELS[k] + '</option>'; }).join('') + '</select><div class="ferr" data-err="Reason"></div></div>' +
      '<div class="field"><label>Remarks</label><input type="text" id="rm"></div><p class="hint" style="font-size:12px;color:var(--muted)">The return needs approval before it changes the order (and later the commission).</p>' +
      '<div class="btn-row"><button class="btn primary" id="rok">Save return</button><button class="btn" id="rno">Cancel</button></div>', function (m, close) {
        var cu = uuid();
        $('#rno', m).onclick = close;
        $('#rok', m).onclick = function () {
          var b = this, l = opts[Number($('#rl', m).value)]; busy(b, true);
          API.call('returns.create', { ClientUUID: cu, OrderLineID: lid(l), Quantity: $('#rq', m).value, Reason: $('#rr', m).value, Remarks: $('#rm', m).value })
            .then(function (r) { close(); toast(savedMsg(r, 'Return ' + r.ReturnNo + ' recorded — waiting for approval.')); if (done) done(); })
            .catch(function (e) { busy(b, false); fieldError(m, e); });
        };
      });
  }

  VIEWS.returns = function (r) {
    var q = r.q;
    loading('Returns');
    API.call('returns.list', { status: q.status, page: Number(q.page) || 1 }).then(function (list) {
      var html = '<div class="toolbar">' + [['', 'All'], ['PENDING', 'Waiting approval'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected']].map(function (x) {
        return '<a class="btn' + ((q.status || '') === x[0] ? ' primary' : '') + '" href="#/returns' + (x[0] ? '?status=' + x[0] : '') + '">' + x[1] + '</a>'; }).join('') + '</div>';
      html += list.items.length ? '<ul class="list">' + list.items.map(function (x, i) {
        return '<li><div class="row"><span class="main-t"><div class="t1">' + esc(x.ReturnNo) + ' · ' + esc(x.CustomerName) + '</div>' +
          '<div class="t2"><a href="#/orders/' + encodeURIComponent(x.OrderID) + '">' + esc(x.OrderNo) + '</a> · ' + esc(x.ProductName) + ' · ' + qty(x.Quantity) + ' ' + esc(x.Unit) + ' (' + qty(x.Cartons) + ' ctn) · ' + money(x.NetValue) + '</div>' +
          '<div class="t2">' + esc(RETURN_REASON_LABELS[x.Reason] || x.Reason) + (x.Remarks ? ' · ' + esc(x.Remarks) : '') + ' · by ' + esc(x.CreatedByName) + ' ' + fmtDate(x.CreatedAt) + (x.RejectReason ? ' · rejected: ' + esc(x.RejectReason) : '') + '</div></span>' +
          '<span style="display:flex;flex-direction:column;gap:6px;align-items:flex-end"><span class="badge ' + ({ APPROVED: 'good', REJECTED: 'bad', PENDING: 'warn' }[x.Status]) + '">' + esc(x.Status) + '</span>' +
          (x.CanDecide ? '<span style="display:flex;gap:6px"><button class="btn primary" style="min-height:34px;padding:0 10px" data-ap="' + i + '">Approve</button><button class="btn danger" style="min-height:34px;padding:0 10px" data-rj="' + i + '">Reject</button></span>' : '') + '</span></div></li>';
      }).join('') + '</ul>' : '<div class="empty card">No returns.</div>';
      var pg = pager(list, function (p) { go('returns?page=' + p + (q.status ? '&status=' + q.status : '')); });
      var root = shell('Returns', html + pg.html); pg.bind(root);
      $all('[data-ap]', root).forEach(function (b) { b.onclick = function () { var x = list.items[Number(b.dataset.ap)]; busy(b, true);
        API.call('returns.decide', { ReturnID: x.ReturnID, decision: 'APPROVE' }).then(function () { toast(x.ReturnNo + ' approved.'); render(); }).catch(function (e) { busy(b, false); showError(e); }); }; });
      $all('[data-rj]', root).forEach(function (b) { b.onclick = function () { var x = list.items[Number(b.dataset.rj)];
        modal('Reject ' + x.ReturnNo, '<div class="field"><label>Reason *</label><input type="text" id="rjr"><div class="ferr" data-err="Reason"></div></div><div class="btn-row"><button class="btn danger" id="rjok">Reject</button><button class="btn" id="rjno">Back</button></div>', function (m, close) {
          $('#rjno', m).onclick = close;
          $('#rjok', m).onclick = function () { var bb = this; busy(bb, true); API.call('returns.decide', { ReturnID: x.ReturnID, decision: 'REJECT', Reason: $('#rjr', m).value }).then(function () { close(); toast('Rejected.'); render(); }).catch(function (e) { busy(bb, false); fieldError(m, e); }); };
        }); }; });
    }).catch(showError);
  };

  // ---------- GPS review ----------
  VIEWS.gpsreview = function (r) {
    var showAll = r.q.all === '1';
    loading('GPS review');
    API.call('delivery.gpsExceptions', { reviewed: showAll ? '' : 'false' }).then(function (list) {
      var html = '<p style="color:var(--muted);margin:0 0 10px">Deliveries confirmed far from the saved shop location, or without the driver\'s GPS. <a href="#/gpsreview' + (showAll ? '' : '?all=1') + '">' + (showAll ? 'Show only unreviewed' : 'Show reviewed too') + '</a></p>';
      html += list.items.length ? '<ul class="list">' + list.items.map(function (x, i) {
        var both = x.CustomerLat !== '' && x.DriverLat !== '';
        return '<li><div class="row"><span class="main-t"><div class="t1">' + esc(x.CustomerName) + ' · ' + esc(x.OrderNo) + '</div>' +
          '<div class="t2">' + esc(x.TripNo) + ' · ' + esc(x.DriverName) + ' · ' + fmtDate(x.DeliveredAt) + '</div><div class="t2" style="white-space:normal">' + gpsStopBadge(x) + ' ' + esc(x.OverrideReason) + '</div></span>' +
          '<span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">' + (both ? '<a class="btn" style="min-height:34px;padding:0 10px" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&origin=' + x.CustomerLat + ',' + x.CustomerLng + '&destination=' + x.DriverLat + ',' + x.DriverLng + '">Shop → driver</a>' : '') +
          (x.GPSReviewedAt ? '<span class="badge good">Reviewed</span>' : can('delivery.gps_override') ? '<button class="btn primary" style="min-height:34px;padding:0 10px" data-rv="' + i + '">Mark reviewed</button>' : '') + '</span></div></li>';
      }).join('') + '</ul>' : '<div class="empty card">Nothing to review.</div>';
      var root = shell('GPS review', html);
      $all('[data-rv]', root).forEach(function (b) { b.onclick = function () { var x = list.items[Number(b.dataset.rv)]; busy(b, true);
        API.call('delivery.reviewGps', { DeliveryOrderID: x.DeliveryOrderID }).then(function () { toast('Marked reviewed.'); render(); }).catch(function (e) { busy(b, false); showError(e); }); }; });
    }).catch(showError);
  };

  // ---------- driver views ----------
  function myOpenTrips() { return API.call('delivery.trips', { status: 'PLANNED,OUT' }); }

  VIEWS.deliveries = function () {
    loading('Deliveries');
    myOpenTrips().then(function (list) {
      if (!list.items.length) return shell('Deliveries', '<div class="empty card">No deliveries assigned to you right now.</div>');
      if (list.items.length === 1) return go('trips/' + encodeURIComponent(list.items[0].DeliveryID));
      shell('Deliveries', '<ul class="list">' + list.items.map(function (t) {
        return '<li><a class="row" href="#/trips/' + encodeURIComponent(t.DeliveryID) + '"><span class="main-t"><div class="t1">' + esc(t.TripNo) + ' · ' + esc(t.VehicleNo) + '</div><div class="t2">' + fmtDate(t.DeliveryDate, false) + ' · ' + t.Pending + ' of ' + t.Stops + ' stops to do</div></span>' + tripBadge(t.Status) + '</a></li>';
      }).join('') + '</ul>');
    }).catch(showError);
  };

  VIEWS.map = function () {
    loading('Map');
    myOpenTrips().then(function (list) {
      return Promise.all(list.items.map(function (t) { return API.call('delivery.trip', { DeliveryID: t.DeliveryID }); }));
    }).then(function (trips) {
      if (!trips.length) return shell('Map', '<div class="empty card">No open trips.</div>');
      var html = trips.map(function (t) {
        var pend = t.StopsList.filter(function (s) { return s.Status === 'PENDING'; }), rl = routeLink(t.StopsList);
        return '<div class="card"><h2>' + esc(t.TripNo) + ' — ' + pend.length + ' stops left</h2>' + (rl ? '<a class="btn primary block" target="_blank" rel="noopener" href="' + rl + '">🗺 Open route in Google Maps</a><p class="hint" style="font-size:12px;color:var(--muted)">Route follows your stop order' + (pend.length > 10 ? ' (first 10 stops)' : '') + '. Stops without saved GPS are not in the route.</p>' : '') +
          '<ul class="list" style="margin-top:10px">' + pend.map(function (s) {
            return '<li><div class="row"><span style="font-weight:800;width:26px;text-align:center">' + s.Sequence + '</span><span class="main-t"><div class="t1">' + esc(s.Customer.ShopName) + '</div><div class="t2">' + esc(s.Customer.Address) + ', ' + esc(s.Customer.Area) + '</div></span>' +
              '<a class="btn" style="min-height:40px" target="_blank" rel="noopener" href="' + navLink(s.Customer) + '">Navigate</a></div></li>';
          }).join('') + '</ul></div>';
      }).join('');
      shell('Map', html);
    }).catch(showError);
  };

  VIEWS.completed = function () {
    loading('Completed');
    API.call('delivery.trips', { from: todayStr() }).then(function (list) {
      return Promise.all(list.items.map(function (t) { return API.call('delivery.trip', { DeliveryID: t.DeliveryID }); }));
    }).then(function (trips) {
      var done = [];
      trips.forEach(function (t) { t.StopsList.forEach(function (s) { if (s.Status !== 'PENDING') done.push({ t: t, s: s }); }); });
      var total = done.reduce(function (a, x) { return a + x.s.DeliveredNet; }, 0);
      shell('Completed', '<p style="margin:0 0 10px">' + done.length + ' stops today · delivered ' + money(Math.round(total * 100) / 100) + '</p>' + (done.length ? '<ul class="list">' + done.map(function (x) {
        return '<li><a class="row" href="#/trips/' + encodeURIComponent(x.t.DeliveryID) + '/stop/' + encodeURIComponent(x.s.DeliveryOrderID) + '"><span class="main-t"><div class="t1">' + esc(x.s.Customer.ShopName) + '</div><div class="t2">' + esc(x.s.OrderNo) + ' · ' + fmtDate(x.s.DeliveredAt) + ' · ' + money(x.s.DeliveredNet) + '</div></span>' + stopBadge(x.s.Status) + '</a></li>';
      }).join('') + '</ul>' : '<div class="empty card">Nothing completed yet today.</div>'));
    }).catch(showError);
  };

  // ---------- prints ----------
  function tripPrint(id) {
    loading('Print', 'trips/' + encodeURIComponent(id));
    API.call('delivery.trip', { DeliveryID: id }).then(function (t) {
      var st = State.settings;
      var head = function (title) { return '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px"><div><div style="font-size:20px;font-weight:800">' + esc(st.COMPANY_NAME || 'Prosol Foods') + '</div><div style="font-size:12px">' + esc(st.COMPANY_ADDRESS || '') + ' ' + esc(st.COMPANY_PHONE || '') + '</div></div><div style="text-align:right"><div style="font-size:17px;font-weight:700">' + title + '</div><div>' + esc(t.TripNo) + ' · ' + fmtDate(t.DeliveryDate, false) + '</div></div></div>'; };
      var html = '<div class="print-doc"><div class="btn-row noprint" style="margin-bottom:12px"><button class="btn primary" id="doPrint">Print / Save PDF</button><a class="btn" href="#/trips/' + encodeURIComponent(t.DeliveryID) + '">Back</a></div>';
      html += '<div class="card" style="page-break-after:always">' + head('TRIP SHEET') + '<p style="font-size:14px">Vehicle ' + esc(t.VehicleNo) + ' · Driver ' + esc(t.DriverName) + (t.Helper ? ' · Helper ' + esc(t.Helper) : '') + (t.Route ? ' · Route ' + esc(t.Route) : '') + '</p>' +
        '<table class="tbl"><tr><th>#</th><th>Shop</th><th>Order</th><th>Cartons</th><th>Value</th><th>Received / signature</th></tr>' + t.StopsList.map(function (s) {
          return '<tr><td>' + s.Sequence + '</td><td>' + esc(s.Customer.ShopName) + '<br><small>' + esc(s.Customer.Address) + ', ' + esc(s.Customer.Area) + ' · ' + esc(s.Customer.Mobile) + '</small></td><td>' + esc(s.OrderNo) + '</td><td>' + s.Remaining.cartons + '</td><td>' + money(s.Remaining.value) + '</td><td style="width:22%"></td></tr>';
        }).join('') + '<tr><td colspan="3" style="text-align:right"><b>Total</b></td><td><b>' + t.Totals.cartons + '</b></td><td><b>' + money(t.Totals.value) + '</b></td><td></td></tr></table>' +
        '<div style="display:flex;justify-content:space-between;margin-top:40px;font-size:13px"><div>____________________<br>Loaded by</div><div>____________________<br>Driver</div></div></div>';
      html += t.StopsList.filter(function (s) { return s.Status === 'PENDING'; }).map(function (s) {
        return '<div class="card" style="page-break-after:always">' + head('DELIVERY NOTE') + '<p style="font-size:14px"><b>' + esc(s.Customer.ShopName) + '</b> (' + esc(s.Customer.Code) + ')<br>' + esc(s.Customer.Address) + ', ' + esc(s.Customer.Area) + ', ' + esc(s.Customer.City) + ' · ' + esc(s.Customer.Mobile) + '<br>Order ' + esc(s.OrderNo) + '</p>' +
          '<table class="tbl"><tr><th>Product</th><th>Qty</th><th>Cartons</th><th>Delivered</th><th>Returned</th></tr>' + s.Lines.filter(function (l) { return l.Outstanding > 0; }).map(function (l) {
            return '<tr><td>' + esc(l.ProductName) + '<br><small>' + esc(l.SKU) + '</small></td><td>' + qty(l.Outstanding) + ' ' + esc(l.Unit) + '</td><td>' + qty(l.Outstanding / l.UnitsPerCarton) + '</td><td style="width:16%"></td><td style="width:16%"></td></tr>';
          }).join('') + '</table><p style="font-size:14px">Value: <b>' + money(s.Remaining.value) + '</b></p>' +
          '<div style="display:flex;justify-content:space-between;margin-top:40px;font-size:13px"><div>____________________<br>Driver</div><div>____________________<br>Customer signature &amp; stamp</div></div></div>';
      }).join('') + '</div>';
      var root = shell('Print ' + t.TripNo, html, { back: 'trips/' + encodeURIComponent(t.DeliveryID) });
      $('#doPrint', root).onclick = function () { window.print(); };
      paperControl(root);
    }).catch(showError);
  }

  // ---------- commission ----------
  var CTYPE_LABEL = { FIXED_PER_CARTON: 'PKR / carton', PERCENTAGE: '%', NO_COMMISSION: 'No commission' };
  var GROUP_LABEL = { salesperson: 'Salesperson', product: 'Product', customer: 'Customer', date: 'Date', order: 'Order', period: 'Period' };
  var NEXT_GROUP = { salesperson: 'product', product: 'customer', customer: 'order', period: 'salesperson', date: 'salesperson' };
  function pkr(n) { return Number(n || 0).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
  function rateText(t, r) { return t === 'PERCENTAGE' ? r + '%' : t === 'FIXED_PER_CARTON' ? 'PKR ' + r + '/ctn' : '—'; }

  /** Quick ranges in Pakistan time. Weeks run Monday–Sunday. */
  function quickRange(key) {
    var d = new Date(todayStr() + 'T12:00:00Z'), day = 86400000, iso = function (x) { return x.toISOString().substring(0, 10); };
    var y = d.getUTCFullYear(), m = d.getUTCMonth(), dow = (d.getUTCDay() + 6) % 7;
    var mon = new Date(d.getTime() - dow * day);
    switch (key) {
      case 'today': return [iso(d), iso(d)];
      case 'week': return [iso(mon), iso(new Date(mon.getTime() + 6 * day))];
      case 'lastweek': return [iso(new Date(mon.getTime() - 7 * day)), iso(new Date(mon.getTime() - day))];
      case 'month': return [iso(new Date(Date.UTC(y, m, 1))), iso(new Date(Date.UTC(y, m + 1, 0)))];
      case 'lastmonth': return [iso(new Date(Date.UTC(y, m - 1, 1))), iso(new Date(Date.UTC(y, m, 0)))];
      case 'quarter': var q = Math.floor(m / 3) * 3; return [iso(new Date(Date.UTC(y, q, 1))), iso(new Date(Date.UTC(y, q + 3, 0)))];
      case 'year': return [y + '-01-01', y + '-12-31'];
      default: return null;
    }
  }
  var QUICK = [['today', 'Today'], ['week', 'This week'], ['lastweek', 'Last week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['quarter', 'This quarter'], ['year', 'This year']];

  /** One CSV cell. Text that Excel would run as a formula (=, +, -, @, tab, CR at the start) gets a leading apostrophe,
   *  so a shop name like =HYPERLINK(...) opens as text. Real numbers (-250, +5) are left alone. */
  function csvCell(v) {
    v = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(v) && !/^[+-]?\d+(\.\d+)?$/.test(v)) v = "'" + v;
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function downloadCsv(name, header, rows) {
    var esc2 = csvCell;
    var csv = '﻿' + [header.map(function (h) { return esc2(h[1]); }).join(',')].concat(rows.map(function (r) { return header.map(function (h) { return esc2(r[h[0]]); }).join(','); })).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  var DETAIL_COLS = [['TxnDate', 'Date'], ['Period', 'Period'], ['SourceType', 'Source'], ['OrderNo', 'Order'], ['TripNo', 'Delivery trip'], ['Salesperson', 'Salesperson'],
    ['Customer', 'Customer'], ['Area', 'Area'], ['Product', 'Product'], ['SKU', 'SKU'], ['Quantity', 'Delivered qty'], ['Cartons', 'Cartons'], ['CommissionType', 'Type'],
    ['Rate', 'Rate'], ['RuleSource', 'Rule from'], ['BaseType', 'Base'], ['BaseAmount', 'Base amount'], ['FractionRule', 'Fraction rule'], ['SalesValue', 'Sales value'],
    ['Commission', 'Commission'], ['Status', 'Status'], ['Note', 'Note']];

  var commCache = { sp: null, products: null };
  function commOptions() {
    var ps = [];
    if (!commCache.products) ps.push(API.call('products.list', { pageSize: 200 }).then(function (r) { commCache.products = r.items; }));
    if (!commCache.sp && can('commission.view.all')) ps.push(API.call('salespersons.options').then(function (r) { commCache.sp = r; }));
    return Promise.all(ps);
  }

  VIEWS.commission = function (r) {
    var q = r.q, tab = q.tab || 'report';
    var all = can('commission.view.all');
    var tabs = [['report', 'Report'], ['payable', 'Payable']].concat(can('commission.approve') ? [['approve', 'Approve']] : [])
      .concat([['adjustments', 'Adjustments'], ['payments', 'Payments']]).concat(all ? [['periods', 'Periods']] : []);
    var tabBar = '<div class="toolbar noprint">' + tabs.map(function (t) { return '<a class="btn' + (t[0] === tab ? ' primary' : '') + '" href="#/commission?tab=' + t[0] + '">' + t[1] + '</a>'; }).join('') + '</div>';
    var title = all ? 'Commission' : 'My commission';
    loading(title);
    var setQ = function (p) { var n = Object.assign({}, q, p); go('commission?' + Object.keys(n).filter(function (k) { return n[k] !== '' && n[k] !== undefined && n[k] !== null; }).map(function (k) { return k + '=' + encodeURIComponent(n[k]); }).join('&')); };

    if (tab === 'report') {
      var range = q.quick && quickRange(q.quick) || [q.from || quickRange('month')[0], q.to || quickRange('month')[1]];
      var group = q.group || (all ? 'salesperson' : 'product');
      var filt = { from: range[0], to: range[1], salespersonId: q.sp, productId: q.product, customerId: q.customer, area: q.area, status: q.status, groupBy: group, page: Number(q.page) || 1 };
      commOptions().then(function () { return API.call('commission.report', filt); }).then(function (res) {
        var html = tabBar + '<div class="card noprint"><div class="toolbar" style="margin:0 0 8px">' + QUICK.map(function (x) { return '<button class="btn' + (q.quick === x[0] || (!q.quick && !q.from && x[0] === 'month') ? ' primary' : '') + '" data-quick="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>' +
          '<div class="toolbar" style="margin:0"><label style="font-size:13px">From <input type="date" id="cFrom" value="' + range[0] + '"></label><label style="font-size:13px">To <input type="date" id="cTo" value="' + range[1] + '"></label>' +
          (all ? '<select id="cSp"><option value="">All salespersons</option>' + commCache.sp.map(function (s) { return '<option value="' + esc(s.id) + '"' + (q.sp === s.id ? ' selected' : '') + '>' + esc(s.label) + '</option>'; }).join('') + '</select>' : '') +
          '<select id="cProd"><option value="">All products</option>' + commCache.products.map(function (p) { return '<option value="' + esc(p.ProductID) + '"' + (q.product === p.ProductID ? ' selected' : '') + '>' + esc(p.Name) + '</option>'; }).join('') + '</select>' +
          '<input type="text" id="cArea" placeholder="Area" value="' + esc(q.area || '') + '" style="max-width:140px">' +
          '<select id="cStatus"><option value="">Calculated + approved + paid</option>' + ['CALCULATED', 'APPROVED', 'PAID', 'CANCELLED'].map(function (s) { return '<option' + (q.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>' +
          '<select id="cGroup">' + Object.keys(GROUP_LABEL).map(function (g) { return '<option value="' + g + '"' + (g === group ? ' selected' : '') + '>By ' + GROUP_LABEL[g].toLowerCase() + '</option>'; }).join('') + '</select></div>' +
          ((q.customer || q.product || (q.sp && all)) ? '<p style="margin:8px 0 0;font-size:13px">Drill-down filter active · <a href="#/commission?tab=report' + (q.quick ? '&quick=' + q.quick : '&from=' + range[0] + '&to=' + range[1]) + '">clear</a></p>' : '') + '</div>';
        html += '<div class="card"><h2>SALESPERSON COMMISSION REPORT — ' + fmtDate(range[0], false) + ' to ' + fmtDate(range[1], false) + '</h2><div class="scroll-x"><table class="tbl"><tr><th>' + GROUP_LABEL[group] + '</th><th style="text-align:right">Delivered cartons</th><th style="text-align:right">Returned ctn</th><th style="text-align:right">Net sales</th><th>Rates</th><th style="text-align:right">Commission</th></tr>' +
          res.summary.map(function (x, i) {
            return '<tr><td>' + (NEXT_GROUP[group] || group === 'order' ? '<a role="button" tabindex="0" style="cursor:pointer" data-drill="' + i + '">' + esc(x.Label) + '</a>' : esc(x.Label)) + '</td><td style="text-align:right">' + pkr(x.DeliveredCartons) + '</td><td style="text-align:right">' + (x.ReturnedCartons ? pkr(x.ReturnedCartons) : '') + '</td><td style="text-align:right">' + pkr(x.Sales) + '</td><td><small>' + x.Rates.map(function (k) { var p = k.split(':'); return rateText(p[0], p[1]); }).join(', ') + '</small></td><td style="text-align:right"><b>' + pkr(x.Commission) + '</b></td></tr>';
          }).join('') + '<tr><td><b>TOTAL</b></td><td style="text-align:right"><b>' + pkr(res.totals.DeliveredCartons) + '</b></td><td style="text-align:right">' + (res.totals.ReturnedCartons ? pkr(res.totals.ReturnedCartons) : '') + '</td><td style="text-align:right"><b>' + pkr(res.totals.Sales) + '</b></td><td></td><td style="text-align:right"><b>' + pkr(res.totals.Commission) + '</b></td></tr></table></div>' +
          (res.summary.length ? '' : '<div class="empty">No commission in this period.</div>') +
          '<div class="btn-row noprint"><button class="btn primary" id="cXlsx">Excel (all calculations)</button><button class="btn" id="cCsv">CSV</button><button class="btn" id="cPdf">PDF</button><button class="btn" id="cPrint">Print</button></div></div>';
        html += '<div class="card"><h2>Detail — every line traceable to its delivery</h2><div class="scroll-x"><table class="tbl" style="font-size:13px"><tr><th>Date</th><th>Order / trip</th><th>Customer</th><th>Product</th><th style="text-align:right">Qty</th><th style="text-align:right">Ctn</th><th>Type / rate</th><th style="text-align:right">Base</th><th style="text-align:right">Commission</th><th>Status</th></tr>' +
          res.detail.items.map(function (d) {
            return '<tr' + (d.SourceType === 'RETURN' ? ' style="color:var(--bad)"' : '') + '><td>' + fmtDate(d.TxnDate, false) + '</td><td><a href="#/orders/' + encodeURIComponent(d.OrderID) + '">' + esc(d.OrderNo) + '</a><br><small>' + esc(d.TripNo) + (d.SourceType === 'RETURN' ? ' · return' : '') + '</small></td><td>' + esc(d.Customer) + (all ? '<br><small>' + esc(d.Salesperson) + '</small>' : '') + '</td><td>' + esc(d.Product) + '</td>' +
              '<td style="text-align:right">' + pkr(d.Quantity) + '</td><td style="text-align:right">' + pkr(d.Cartons) + '</td><td>' + rateText(d.CommissionType, d.Rate) + (d.CommissionType === 'PERCENTAGE' ? '<br><small>' + esc(d.BaseType) + '</small>' : d.CommissionType === 'FIXED_PER_CARTON' && d.FractionRule !== 'PROPORTIONAL' ? '<br><small>' + esc(d.FractionRule) + '</small>' : '') + (d.RuleSource === 'SALESPERSON' ? '<br><small>personal rate</small>' : '') + '</td>' +
              '<td style="text-align:right">' + (d.CommissionType === 'PERCENTAGE' ? pkr(d.BaseAmount) : '') + '</td><td style="text-align:right"><b>' + pkr(d.Commission) + '</b></td><td><small>' + esc(d.Status) + (d.Note ? '<br>' + esc(d.Note) : '') + '</small></td></tr>';
          }).join('') + '</table></div>';
        var pg = pager(res.detail, function (p) { setQ({ page: p }); });
        html += pg.html + '</div>';
        var root = shell(title, html); pg.bind(root);
        $all('[data-quick]', root).forEach(function (b) { b.onclick = function () { setQ({ quick: b.dataset.quick, from: '', to: '', page: '' }); }; });
        var custom = function () { setQ({ quick: '', from: $('#cFrom', root).value, to: $('#cTo', root).value, page: '' }); };
        $('#cFrom', root).onchange = custom; $('#cTo', root).onchange = custom;
        if ($('#cSp', root)) $('#cSp', root).onchange = function (ev) { setQ({ sp: ev.target.value, page: '' }); };
        $('#cProd', root).onchange = function (ev) { setQ({ product: ev.target.value, page: '' }); };
        $('#cStatus', root).onchange = function (ev) { setQ({ status: ev.target.value, page: '' }); };
        $('#cGroup', root).onchange = function (ev) { setQ({ group: ev.target.value, page: '' }); };
        var t; $('#cArea', root).oninput = function (ev) { clearTimeout(t); var sq = renderSeq; t = setTimeout(function () { if (sq !== renderSeq) return; setQ({ area: ev.target.value, page: '' }); }, 600); };
        $all('[data-drill]', root).forEach(function (a) { a.onclick = function () {
          var x = res.summary[Number(a.dataset.drill)], p = { page: '' };
          if (group === 'salesperson') p.sp = x.Key; else if (group === 'product') p.product = x.Key; else if (group === 'customer') p.customer = x.Key;
          else if (group === 'date') { p.from = x.Key; p.to = x.Key; p.quick = ''; } else if (group === 'period') { p.from = x.Key + '-01'; p.to = x.Key + '-31'; p.quick = ''; }
          if (group === 'order') return go('orders/' + encodeURIComponent(x.Key));
          p.group = NEXT_GROUP[group]; setQ(p);
        }; });
        $('#cPrint', root).onclick = function () { window.print(); };
        $('#cXlsx', root).onclick = function () { commissionExcel(filt, range, this); };
        $('#cPdf', root).onclick = function () { exportPdf(Object.assign({ report: 'commission' }, filt), this); };
        $('#cCsv', root).onclick = function () { var b = this; busy(b, true);
          API.call('commission.report', Object.assign({}, filt, { all: true })).then(function (full) { busy(b, false);
            downloadCsv('prosol-commission-' + range[0] + '-to-' + range[1] + '.csv', DETAIL_COLS, full.detail.items); toast(full.detail.items.length + ' lines exported.'); })
            .catch(function (e) { busy(b, false); showError(e); }); };
      }).catch(showError);
      return;
    }

    if (tab === 'payable') {
      Promise.all([API.call('commission.statement', { period: q.period }), commOptions()]).then(function (res) {
        var st = res[0];
        var html = tabBar + '<div class="toolbar noprint"><label style="font-size:13px">Period <input type="month" id="pPer" value="' + esc(q.period || '') + '"></label>' + (q.period ? '<a class="btn" href="#/commission?tab=payable">All periods</a>' : '') + '</div>' +
          '<div class="card"><h2>Commission payable' + (q.period ? ' — ' + esc(q.period) : ' — all periods') + '</h2><div class="scroll-x"><table class="tbl"><tr><th>Salesperson</th><th style="text-align:right">Earned</th><th style="text-align:right">Less: returns</th><th style="text-align:right">Adjustments</th><th style="text-align:right">Less: paid</th><th style="text-align:right">Payable</th><th style="text-align:right">Approved, unpaid</th><th class="noprint"></th></tr>' +
          st.rows.map(function (x, i) {
            return '<tr><td>' + esc(x.SalespersonName) + '</td><td style="text-align:right">' + pkr(x.Earned) + '</td><td style="text-align:right">' + pkr(x.ReturnAdj) + '</td><td style="text-align:right">' + pkr(x.ManualAdj) + (x.PendingAdj ? '<br><small>' + pkr(x.PendingAdj) + ' pending</small>' : '') + '</td><td style="text-align:right">' + pkr(x.Paid) + '</td>' +
              '<td style="text-align:right"><b>' + pkr(x.Payable) + '</b></td><td style="text-align:right">' + pkr(x.ApprovedPayable) + (x.Calculated ? '<br><small>' + pkr(x.Calculated) + ' not approved</small>' : '') + '</td>' +
              '<td class="noprint">' + (can('commission.pay') && q.period && x.ApprovedPayable > 0 ? '<button class="btn primary" style="min-height:34px;padding:0 10px" data-pay="' + i + '">Pay</button>' : '') + '</td></tr>';
          }).join('') + '<tr><td><b>TOTAL</b></td><td style="text-align:right"><b>' + pkr(st.totals.Earned) + '</b></td><td style="text-align:right">' + pkr(st.totals.ReturnAdj) + '</td><td style="text-align:right">' + pkr(st.totals.ManualAdj) + '</td><td style="text-align:right">' + pkr(st.totals.Paid) + '</td><td style="text-align:right"><b>' + pkr(st.totals.Payable) + '</b></td><td style="text-align:right">' + pkr(st.totals.ApprovedPayable) + '</td><td class="noprint"></td></tr></table></div>' +
          (can('commission.pay') && !q.period ? '<p class="hint noprint" style="font-size:13px;color:var(--muted)">Choose a period to record payments.</p>' : '') +
          '<p class="hint" style="font-size:12px;color:var(--muted)">Payable = earned − returns ± adjustments − paid. Only approved commission can be paid.</p><div class="btn-row noprint"><button class="btn" id="payPrint">Print</button></div></div>';
        var root = shell(title, html);
        $('#pPer', root).onchange = function (ev) { setQ({ period: ev.target.value }); };
        $('#payPrint', root).onclick = function () { window.print(); };
        $all('[data-pay]', root).forEach(function (b) { b.onclick = function () {
          var x = st.rows[Number(b.dataset.pay)];
          var f = [{ name: 'Amount', label: 'Amount (max ' + pkr(x.ApprovedPayable) + ')', type: 'number', required: true, dflt: x.ApprovedPayable },
            { name: 'PaymentDate', label: 'Payment date', type: 'date', required: true, dflt: todayStr() },
            { name: 'Method', label: 'Method', type: 'select', required: true, options: [['CASH', 'Cash'], ['BANK', 'Bank transfer'], ['CHEQUE', 'Cheque'], ['OTHER', 'Other']].map(function (o) { return { value: o[0], label: o[1] }; }) },
            { name: 'Reference', label: 'Reference (transfer / cheque no.)' }, { name: 'Remarks', label: 'Remarks' }];
          modal('Pay ' + x.SalespersonName + ' — ' + q.period, '<form id="payf">' + formHtml(f) + '<div class="btn-row"><button class="btn primary" type="submit">Record payment</button><button class="btn" type="button" id="payc">Cancel</button></div></form>', function (m, close) {
            $('#payc', m).onclick = close; var fm = $('#payf', m);
            fm.onsubmit = function (ev) { ev.preventDefault(); var bb = $('button[type=submit]', fm); busy(bb, true);
              API.call('commission.pay', Object.assign(readForm(fm, f), { SalespersonID: x.SalespersonID, Period: q.period })).then(function (pmt) { close(); toast('Payment ' + pmt.PaymentID + ' recorded.'); render(); }).catch(function (e) { busy(bb, false); fieldError(fm, e); }); };
          });
        }; });
      }).catch(showError);
      return;
    }

    if (tab === 'approve') {
      API.call('commission.report', { status: 'CALCULATED', groupBy: 'period', all: true }).then(function (res) {
        var byKey = {};
        res.detail.items.forEach(function (d) { var k = d.Period + '|' + d.Salesperson; var x = byKey[k] || (byKey[k] = { Period: d.Period, Salesperson: d.Salesperson, Lines: 0, Amount: 0, ids: [] }); x.Lines++; x.Amount += d.Commission; x.ids.push(d.CommissionID); });
        var list = Object.keys(byKey).sort().map(function (k) { return byKey[k]; });
        var html = tabBar + '<div class="card"><h2>Commission waiting for approval</h2>' + (list.length ? '<table class="tbl"><tr><th>Period</th><th>Salesperson</th><th style="text-align:right">Lines</th><th style="text-align:right">Amount</th><th></th></tr>' + list.map(function (x, i) {
          return '<tr><td>' + esc(x.Period) + '</td><td>' + esc(x.Salesperson) + '</td><td style="text-align:right">' + x.Lines + '</td><td style="text-align:right"><b>' + pkr(Math.round(x.Amount * 100) / 100) + '</b></td><td><button class="btn primary" style="min-height:34px;padding:0 10px" data-ap="' + i + '">Approve</button> <a class="btn" style="min-height:34px;padding:0 10px" href="#/commission?tab=report&status=CALCULATED&from=' + x.Period + '-01&to=' + x.Period + '-31">Review lines</a></td></tr>';
        }).join('') + '</table>' : '<div class="empty">Nothing waiting.</div>') + '</div>';
        var root = shell(title, html);
        $all('[data-ap]', root).forEach(function (b) { b.onclick = function () { var x = list[Number(b.dataset.ap)]; busy(b, true);
          API.call('commission.approve', { CommissionIDs: x.ids }).then(function (r2) { toast(r2.approved + ' lines approved (' + pkr(r2.amount) + ').'); render(); }).catch(function (e) { busy(b, false); showError(e); }); }; });
      }).catch(showError);
      return;
    }

    if (tab === 'adjustments') {
      Promise.all([API.call('commission.adjustments', { status: q.status }), commOptions()]).then(function (res) {
        var list = res[0];
        var html = tabBar + '<div class="toolbar">' + [['', 'All'], ['PENDING', 'Pending'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected']].map(function (x) { return '<a class="btn' + ((q.status || '') === x[0] ? ' primary' : '') + '" href="#/commission?tab=adjustments' + (x[0] ? '&status=' + x[0] : '') + '">' + x[1] + '</a>'; }).join('') +
          (can('commission.adjust') ? '<button class="btn primary" id="adjNew">+ Manual adjustment</button>' : '') + '</div>';
        html += list.items.length ? '<ul class="list">' + list.items.map(function (a, i) {
          return '<li><div class="row"><span class="main-t"><div class="t1">' + esc(a.AdjustmentID) + ' · ' + esc(a.SalespersonName) + ' · ' + esc(a.Period) + ' · <span style="color:' + (a.Amount < 0 ? 'var(--bad)' : 'var(--good)') + '">' + pkr(a.Amount) + '</span></div>' +
            '<div class="t2" style="white-space:normal"><b>' + esc(a.Reason) + '</b> — ' + esc(a.Remarks) + '</div><div class="t2">by ' + esc(a.CreatedByName) + ' ' + fmtDate(a.CreatedAt) + (a.ApprovedByName ? ' · ' + a.Status.toLowerCase() + ' by ' + esc(a.ApprovedByName) : '') + '</div></span>' +
            '<span style="display:flex;flex-direction:column;gap:6px;align-items:flex-end"><span class="badge ' + ({ APPROVED: 'good', REJECTED: 'bad', PENDING: 'warn' }[a.Status]) + '">' + a.Status + '</span>' +
            (a.CanDecide ? '<span style="display:flex;gap:6px"><button class="btn primary" style="min-height:34px;padding:0 10px" data-ok="' + i + '">Approve</button><button class="btn danger" style="min-height:34px;padding:0 10px" data-no="' + i + '">Reject</button></span>' : '') + '</span></div></li>';
        }).join('') + '</ul>' : '<div class="empty card">No adjustments.</div>';
        var root = shell(title, html);
        var decide = function (b, a, d) { busy(b, true); API.call('commission.decideAdjustment', { AdjustmentID: a.AdjustmentID, decision: d }).then(function () { toast('Adjustment ' + d.toLowerCase() + 'd.'); render(); }).catch(function (e) { busy(b, false); showError(e); }); };
        $all('[data-ok]', root).forEach(function (b) { b.onclick = function () { decide(b, list.items[Number(b.dataset.ok)], 'APPROVE'); }; });
        $all('[data-no]', root).forEach(function (b) { b.onclick = function () { decide(b, list.items[Number(b.dataset.no)], 'REJECT'); }; });
        if ($('#adjNew', root)) $('#adjNew', root).onclick = function () {
          var f = [{ name: 'SalespersonID', label: 'Salesperson', type: 'select', required: true, options: commCache.sp.map(function (s) { return { value: s.id, label: s.label }; }) },
            { name: 'Period', label: 'Period (open month)', type: 'month', required: true, dflt: todayStr().substring(0, 7) },
            { name: 'Amount', label: 'Amount (negative to deduct)', type: 'number', required: true },
            { name: 'Reason', label: 'Reason', required: true, placeholder: 'e.g. recovery of advance' },
            { name: 'Remarks', label: 'Supporting remarks', type: 'textarea', required: true, placeholder: 'Voucher no., approval reference, calculation' }];
          modal('Manual commission adjustment', '<form id="adjf">' + formHtml(f) + '<p class="hint" style="font-size:12px;color:var(--muted)">Another authorised person must approve it before it counts.</p><div class="btn-row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" id="adjc">Cancel</button></div></form>', function (m, close) {
            $('#adjc', m).onclick = close; var fm = $('#adjf', m);
            fm.onsubmit = function (ev) { ev.preventDefault(); var bb = $('button[type=submit]', fm); busy(bb, true);
              API.call('commission.createAdjustment', readForm(fm, f)).then(function (a) { close(); toast(a.AdjustmentID + ' saved — waiting for approval.'); render(); }).catch(function (e) { busy(bb, false); fieldError(fm, e); }); };
          });
        };
      }).catch(showError);
      return;
    }

    if (tab === 'payments') {
      API.call('commission.payments', {}).then(function (list) {
        var html = tabBar + '<div class="card scroll-x"><table class="tbl"><tr><th>Payment</th><th>Date</th><th>Salesperson</th><th>Period</th><th>Method / ref</th><th style="text-align:right">Amount</th><th>Recorded by</th></tr>' + list.items.map(function (x) {
          return '<tr><td>' + esc(x.PaymentID) + '</td><td>' + fmtDate(x.PaymentDate, false) + '</td><td>' + esc(x.SalespersonName) + '</td><td>' + esc(x.Period) + '</td><td>' + esc(x.Method) + (x.Reference ? ' · ' + esc(x.Reference) : '') + (x.Remarks ? '<br><small>' + esc(x.Remarks) + '</small>' : '') + '</td><td style="text-align:right"><b>' + pkr(x.Amount) + '</b></td><td>' + esc(x.CreatedByName) + '</td></tr>';
        }).join('') + '</table>' + (list.items.length ? '' : '<div class="empty">No payments yet.</div>') + '</div>';
        shell(title, html);
      }).catch(showError);
      return;
    }

    if (tab === 'periods') {
      API.call('commission.periods').then(function (list) {
        var html = tabBar + '<div class="card"><h2>Commission periods</h2><p class="hint" style="font-size:13px;color:var(--muted)">Closing a month locks it: nothing in it can be approved, cancelled or adjusted afterwards. Later corrections go into an open month as adjustments; late deliveries dated in a closed month are posted to the next open month.</p>' +
          '<table class="tbl"><tr><th>Period</th><th>Status</th><th>Waiting approval</th><th></th></tr>' + list.map(function (p, i) {
            return '<tr><td>' + esc(p.Period) + '</td><td>' + (p.Status === 'CLOSED' ? '<span class="badge">CLOSED</span><br><small>' + esc(p.ClosedByName) + ' ' + fmtDate(p.ClosedAt) + '</small>' : '<span class="badge good">OPEN</span>') + '</td><td>' + (p.PendingLines || p.PendingAdjustments ? p.PendingLines + ' lines, ' + p.PendingAdjustments + ' adjustments' : '—') + '</td>' +
              '<td>' + (p.CanClose && can('commission.close') ? '<button class="btn" style="min-height:34px;padding:0 10px" data-close="' + i + '">Close period</button>' : '') + '</td></tr>';
          }).join('') + '</table></div>';
        var root = shell(title, html);
        $all('[data-close]', root).forEach(function (b) { b.onclick = function () { var p = list[Number(b.dataset.close)];
          confirmBox('Close ' + p.Period, 'Close commission period ' + p.Period + '? This cannot be undone.', 'Close period').then(function (y) {
            if (!y) return; API.call('commission.closePeriod', { Period: p.Period }).then(function () { toast(p.Period + ' closed.'); render(); }).catch(showError); }); }; });
      }).catch(showError);
    }
  };

  VIEWS.commrules = function () {
    loading('Commission rates');
    Promise.all([API.call('commission.rules', {}), commOptions(), can('commission.rules') ? API.call('salespersons.options') : Promise.resolve([])]).then(function (res) {
      var data = res[0], sps = res[2], edit = can('commission.rules');
      var html = '<div class="card"><h2>Current product rates</h2><div class="scroll-x"><table class="tbl"><tr><th>Product</th><th>Carton</th><th>Rate today</th>' + (edit ? '<th></th>' : '') + '</tr>' + data.current.map(function (p, i) {
        return '<tr><td>' + esc(p.Name) + '<br><small>' + esc(p.SKU) + '</small></td><td>' + p.UnitsPerCarton + ' units</td><td>' + rateText(p.CommissionType, p.Rate) + '</td>' + (edit ? '<td><button class="btn" style="min-height:34px;padding:0 10px" data-set="' + i + '">Change</button></td>' : '') + '</tr>';
      }).join('') + '</table></div>' + (edit ? '<div class="btn-row"><button class="btn" id="spRule">+ Salesperson-specific rate</button></div>' : '') + '</div>';
      html += '<div class="card"><h2>All rules (with dates)</h2><div class="scroll-x"><table class="tbl" style="font-size:13px"><tr><th>Product</th><th>For</th><th>Rate</th><th>Base / fraction</th><th>From</th><th>To</th><th>State</th>' + (edit ? '<th></th>' : '') + '</tr>' + data.rules.map(function (r, i) {
        return '<tr><td>' + esc(r.ProductName) + '</td><td>' + (r.SalespersonName ? esc(r.SalespersonName) : 'All salespersons') + '</td><td>' + rateText(r.CommissionType, r.Rate) + '</td><td>' + esc(r.BaseType || 'default') + ' / ' + esc(r.FractionRule || 'default') + '</td><td>' + esc(r.EffectiveFrom) + '</td><td>' + esc(r.EffectiveTo || '—') + '</td>' +
          '<td><span class="badge ' + ({ CURRENT: 'good', FUTURE: 'warn' }[r.State] || '') + '">' + r.State + '</span></td>' + (edit ? '<td>' + (r.Kind === 'SALESPERSON' && (r.State === 'CURRENT' || r.State === 'FUTURE') && !r.EffectiveTo ? '<button class="btn" style="min-height:34px;padding:0 10px" data-end="' + i + '">End</button>' : '') + '</td>' : '') + '</tr>';
      }).join('') + '</table></div></div>';
      html += '<div class="card"><h2>Change history</h2><table class="tbl" style="font-size:13px"><tr><th>When</th><th>By</th><th>Product / salesperson</th><th>Old</th><th>New</th><th>Effective</th></tr>' + data.history.map(function (h2) {
        return '<tr><td>' + fmtDate(h2.ChangedAt) + '</td><td>' + esc(h2.ChangedByName) + '</td><td>' + esc(h2.ProductName) + (h2.SalespersonName ? '<br><small>' + esc(h2.SalespersonName) + '</small>' : '') + '</td><td><small>' + esc(h2.OldValue) + '</small></td><td><small>' + esc(h2.NewValue) + '</small></td><td>' + esc(h2.EffectiveFrom) + '</td></tr>';
      }).join('') + '</table><p class="hint" style="font-size:12px;color:var(--muted)">Changing a rate never changes commission already calculated — each commission line keeps the rate it was calculated with.</p></div>';
      var root = shell('Commission rates', html);
      var ruleModal = function (product, withSp) {
        var f = (withSp ? [{ name: 'SalespersonID', label: 'Salesperson', type: 'select', required: true, options: sps.map(function (s) { return { value: s.id, label: s.label }; }) }] : [])
          .concat(product ? [] : [{ name: 'ProductID', label: 'Product', type: 'select', required: true, options: commCache.products.map(function (p) { return { value: p.ProductID, label: p.Name + ' (' + p.SKU + ')' }; }) }])
          .concat([{ name: 'CommissionType', label: 'Type', type: 'select', required: true, options: [['FIXED_PER_CARTON', 'Fixed PKR per carton'], ['PERCENTAGE', 'Percentage of sales'], ['NO_COMMISSION', 'No commission']].map(function (o) { return { value: o[0], label: o[1] }; }) },
            { name: 'Rate', label: 'Rate (PKR per carton, or %)', type: 'number' },
            { name: 'BaseType', label: 'Percentage base', type: 'select', options: [['NET_EXCL_TAX', 'Net after discount, excl. tax'], ['GROSS', 'Gross'], ['NET_INCL_TAX', 'Net incl. tax']].map(function (o) { return { value: o[0], label: o[1] }; }), hint: 'Blank = system default' },
            { name: 'FractionRule', label: 'Part cartons', type: 'select', options: [['PROPORTIONAL', 'Proportional (½ carton = ½ rate)'], ['ROUND_DOWN', 'Round down'], ['ROUND_UP', 'Round up']].map(function (o) { return { value: o[0], label: o[1] }; }), hint: 'Blank = system default' },
            { name: 'EffectiveFrom', label: 'Effective from', type: 'date', required: true, dflt: todayStr() }]);
        modal((withSp ? 'Salesperson rate' : 'Rate') + (product ? ' — ' + product.Name : ''), '<form id="rf">' + formHtml(f, product ? { CommissionType: product.CommissionType, Rate: product.Rate } : null) +
          '<div class="btn-row"><button class="btn primary" type="submit">Save new rate</button><button class="btn" type="button" id="rc">Cancel</button></div></form>', function (m, close) {
          $('#rc', m).onclick = close; var fm = $('#rf', m);
          fm.onsubmit = function (ev) { ev.preventDefault(); var b = $('button[type=submit]', fm); busy(b, true); var d = readForm(fm, f); if (product) d.ProductID = product.ProductID;
            API.call('commission.setRule', d).then(function () { close(); toast('Rate saved.'); render(); }).catch(function (e) { busy(b, false); fieldError(fm, e); }); };
        });
      };
      $all('[data-set]', root).forEach(function (b) { b.onclick = function () { ruleModal(data.current[Number(b.dataset.set)], false); }; });
      if ($('#spRule', root)) $('#spRule', root).onclick = function () { ruleModal(null, true); };
      $all('[data-end]', root).forEach(function (b) { b.onclick = function () { var r = data.rules[Number(b.dataset.end)];
        confirmBox('End personal rate', 'End ' + r.SalespersonName + "'s personal rate for " + r.ProductName + ' today? From tomorrow the product default applies.', 'End rate').then(function (y) {
          if (y) API.call('commission.endRule', { RuleID: r.RuleID }).then(function () { toast('Personal rate ended.'); render(); }).catch(showError); }); }; });
    }).catch(showError);
  };


  // =====================================================================================================
  // ---------- exports: Excel (.xlsx written in the browser, no library), CSV, PDF (built on the server) ----------
  // =====================================================================================================
  var Xlsx = (function () {
    var XMLDECL = '<' + '?xml version="1.0" encoding="UTF-8" standalone="yes"?' + '>'; // split so Apps Script does not read it as a template tag
    var CRC = (function () { var t = [], c, n, k; for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    function crc32(b) { var c = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
    function utf8(s) { return new TextEncoder().encode(s); }
    /** ZIP container with stored (uncompressed) entries — a valid .xlsx package. */
    function zip(files) {
      var parts = [], central = [], offset = 0, now = new Date();
      var dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
      files.forEach(function (f) {
        var name = utf8(f.name), data = utf8(f.data), crc = crc32(data);
        var lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
        lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
        parts.push(new Uint8Array(lh.buffer), name, data);
        var ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
        ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
        ch.setUint32(42, offset, true);
        central.push(new Uint8Array(ch.buffer), name);
        offset += 30 + name.length + data.length;
      });
      var cdSize = central.reduce(function (s, p) { return s + p.length; }, 0);
      var end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
      return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    }
    function x(s) { return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function col(i) { var s = ''; i++; while (i) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
    var EPOCH = Date.UTC(1899, 11, 30);
    function dateSerial(v) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v)); return m ? (Date.UTC(+m[1], +m[2] - 1, +m[3]) - EPOCH) / 864e5 : null; }
    function dtSerial(v) { var t = new Date(v).getTime(); return isNaN(t) ? null : (t + 5 * 3600000 - EPOCH) / 864e5; } // Pakistan time (UTC+5, no daylight saving)
    // style index per column type (see styles below); +20 = same style in bold for the totals row
    var STY = { text: 0, money: 3, qty: 4, int: 5, date: 6, datetime: 7, pct: 8, coord: 9, m: 10 };
    var STYLES = XMLDECL + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="6"><numFmt numFmtId="164" formatCode="#,##0.###"/><numFmt numFmtId="165" formatCode="dd\\-mmm\\-yyyy"/><numFmt numFmtId="166" formatCode="dd\\-mmm\\-yyyy hh:mm"/>' +
      '<numFmt numFmtId="167" formatCode="0.0%"/><numFmt numFmtId="168" formatCode="0.000000"/><numFmt numFmtId="169" formatCode="#,##0&quot; m&quot;"/></numFmts>' +
      '<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF555555"/><name val="Calibri"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE3EFE7"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF888888"/></top><bottom style="thin"><color rgb="FF888888"/></bottom><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="31">' +
      // 0 text, 1 title, 2 header, 3 money, 4 qty, 5 int, 6 date, 7 datetime, 8 pct, 9 coord, 10 metres, 11 subtitle, 12-19 spare
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment wrapText="1" vertical="center"/></xf>' +
      '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="169" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' + new Array(9).join('<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>') +
      // 20.. bold copies for totals
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>' +
      '<xf numFmtId="4" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>' +
      '<xf numFmtId="3" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/><xf numFmtId="165" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' +
      '<xf numFmtId="166" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/><xf numFmtId="167" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' +
      '<xf numFmtId="168" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/><xf numFmtId="169" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' +
      '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

    function cell(ref, v, t, bold) {
      var s = (STY[t] || 0) + (bold ? 20 : 0);
      if (v === '' || v === null || v === undefined) return bold ? '<c r="' + ref + '" s="' + s + '"/>' : '';
      var num = null;
      if (t === 'date') num = dateSerial(v);
      else if (t === 'datetime') num = dtSerial(v);
      else if (t === 'pct') num = isFinite(Number(v)) ? Number(v) / 100 : null;
      else if (['money', 'qty', 'int', 'coord', 'm'].indexOf(t) >= 0) num = isFinite(Number(v)) ? Number(v) : null;
      if (num !== null) return '<c r="' + ref + '" s="' + s + '"><v>' + num + '</v></c>';
      return '<c r="' + ref + '" t="inlineStr" s="' + (bold ? 20 : 0) + '"><is><t xml:space="preserve">' + x(v) + '</t></is></c>';
    }
    function sheetXml(sh) {
      var cols = sh.columns, out = [], r = 1, widths = cols.map(function (c) { return Math.max(8, String(c.label).length + 2); });
      var txt = function (ref, v, s) { return '<c r="' + ref + '" t="inlineStr" s="' + s + '"><is><t xml:space="preserve">' + x(v) + '</t></is></c>'; };
      out.push('<row r="1">' + txt('A1', sh.title, 1) + '</row>');
      if (sh.subtitle) out.push('<row r="2">' + txt('A2', sh.subtitle, 11) + '</row>');
      var head = 4;
      out.push('<row r="' + head + '">' + cols.map(function (c, i) { return txt(col(i) + head, c.label, 2); }).join('') + '</row>');
      r = head;
      sh.rows.forEach(function (row) {
        r++;
        out.push('<row r="' + r + '">' + cols.map(function (c, i) {
          var v = row[c.k]; if (v !== '' && v !== null && v !== undefined) widths[i] = Math.min(60, Math.max(widths[i], String(c.t === 'money' ? Number(v).toFixed(2) : v).length + 2));
          return cell(col(i) + r, v, c.t, false);
        }).join('') + '</row>');
      });
      var last = r;
      if (sh.totals) {
        r++;
        out.push('<row r="' + r + '">' + cols.map(function (c, i) { var v = sh.totals[c.k]; return cell(col(i) + r, i === 0 && (v === undefined || v === '') ? 'TOTAL' : v, i === 0 && (v === undefined || v === '') ? 'text' : c.t, true); }).join('') + '</row>');
      }
      (sh.footer || []).forEach(function (line) { r += 2; out.push('<row r="' + r + '">' + txt('A' + r, line, 11) + '</row>'); });
      var dims = 'A1:' + col(cols.length - 1) + Math.max(r, head);
      return XMLDECL + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<dimension ref="' + dims + '"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="' + head + '" topLeftCell="A' + (head + 1) + '" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
        '<sheetFormatPr defaultRowHeight="15"/><cols>' + widths.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols>' +
        '<sheetData>' + out.join('') + '</sheetData>' + (last > head ? '<autoFilter ref="A' + head + ':' + col(cols.length - 1) + last + '"/>' : '') +
        '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToHeight="0"/></worksheet>';
    }
    function sheetName(n, used) {
      var s = String(n).replace(/[\[\]:*?\/\\]/g, ' ').substring(0, 31).trim() || 'Sheet', base = s, i = 2;
      while (used[s.toLowerCase()]) s = base.substring(0, 28) + ' ' + (i++);
      used[s.toLowerCase()] = 1; return s;
    }
    /** sheets: [{ name, title, subtitle, columns:[{k,label,t}], rows:[{}], totals, footer:[text] }] → Blob */
    function build(sheets) {
      var used = {}, names = sheets.map(function (s) { return sheetName(s.name, used); });
      var files = [
        { name: '[Content_Types].xml', data: XMLDECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
          sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') + '</Types>' },
        { name: '_rels/.rels', data: XMLDECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>' },
        { name: 'docProps/core.xml', data: XMLDECL + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
          '<dc:title>' + x(sheets[0].title) + '</dc:title><dc:creator>' + x((State.me && State.me.fullName) || 'Prosol Foods') + '</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">' + new Date().toISOString().replace(/\.\d+Z$/, 'Z') + '</dcterms:created></cp:coreProperties>' },
        { name: 'xl/workbook.xml', data: XMLDECL + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<bookViews><workbookView/></bookViews><sheets>' + names.map(function (n, i) { return '<sheet name="' + x(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') + '</sheets>' +
          '<definedNames>' + sheets.map(function (s, i) { return s.rows.length ? '<definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">\'' + x(names[i].replace(/'/g, "''")) + '\'!$A$4:$' + col(s.columns.length - 1) + '$' + (4 + s.rows.length) + '</definedName>' : ''; }).join('') + '</definedNames></workbook>' },
        { name: 'xl/_rels/workbook.xml.rels', data: XMLDECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
          '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
        { name: 'xl/styles.xml', data: STYLES }
      ].concat(sheets.map(function (s, i) { return { name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(s) }; }));
      return zip(files);
    }
    return { build: build };
  })();

  function downloadBlob(name, blob) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function fileSafe(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 70); }
  function printedLine() { return 'Printed ' + fmtDate(new Date().toISOString()) + ' by ' + (State.me ? State.me.fullName : '') + ' — ' + (State.settings.COMPANY_NAME || 'Prosol Foods'); }
  function exportXlsx(name, sheets) { downloadBlob(fileSafe(name) + '.xlsx', Xlsx.build(sheets)); }
  function exportCsvCols(name, cols, rows, totals) {
    downloadCsv(fileSafe(name) + '.csv', cols.map(function (c) { return [c.k, c.label]; }), totals ? rows.concat([Object.assign({}, totals, totals[cols[0].k] === undefined ? (function () { var o = {}; o[cols[0].k] = 'TOTAL'; return o; })() : {})]) : rows);
  }
  function exportPdf(payload, btn) {
    busy(btn, true);
    return API.call('reports.pdf', payload).then(function (r) {
      if (r.mime === 'text/html') return printHtml(r, btn);   // Supabase version: the report page is printed / saved as PDF by the phone
      var bin = atob(r.base64), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      downloadBlob(r.fileName, new Blob([bytes], { type: 'application/pdf' })); busy(btn, false); toast('PDF ready: ' + r.fileName);
    }).catch(function (e) { busy(btn, false); showError(e); });
  }

  /** Prints a report page sent by the server (choose "Save as PDF" in the print window). A hidden frame: no pop-up to block. */
  function printHtml(r, btn) {
    var bin = atob(r.base64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var html = new TextDecoder('utf-8').decode(bytes);
    var old = document.getElementById('printFrame'); if (old) old.remove();
    var fr = document.createElement('iframe');
    fr.id = 'printFrame'; fr.title = 'Report for printing';
    fr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    fr.setAttribute('sandbox', 'allow-modals allow-same-origin');   // the page has no scripts; it may only be printed
    document.body.appendChild(fr);
    fr.srcdoc = html.replace(/<title>[\s\S]*?<\/title>/i, '').replace('<head>', '<head><title>' + esc(String(r.fileName).replace(/\.html$/, '')) + '</title>');
    fr.onload = function () {
      busy(btn, false);
      toast('Choose "Save as PDF" in the print window to keep a PDF.');
      try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (e) { showError({ message: 'Printing is not available on this device.' }); }
    };
  }

  // ---------- paper size for printouts: A4 or 80 mm thermal roll ----------
  function paperControl(root) {
    var cur = safeGet('prosol.paper') || 'a4';
    var apply = function (v) {
      document.body.classList.toggle('paper-80', v === '80');
      var st = document.getElementById('pageSize') || document.head.appendChild(Object.assign(document.createElement('style'), { id: 'pageSize' }));
      st.textContent = v === '80' ? '@page { size: 80mm auto; margin: 3mm; }' : '@page { size: A4; margin: 12mm; }';
      $all('.span-total', root).forEach(function (td) { if (!td.dataset.span) td.dataset.span = td.colSpan; td.colSpan = v === '80' ? 2 : Number(td.dataset.span); });
    };
    var row = $('.btn-row.noprint', root);
    if (row) {
      var sel = document.createElement('select'); sel.id = 'paperSel'; sel.style.maxWidth = '190px';
      sel.innerHTML = '<option value="a4">Paper: A4</option><option value="80">Paper: 80 mm thermal</option>';
      sel.value = cur; sel.onchange = function () { safeSet('prosol.paper', sel.value); apply(sel.value); };
      row.appendChild(sel);
    }
    apply(cur);
  }
  window.addEventListener('hashchange', function () { document.body.classList.remove('paper-80'); });

  // =====================================================================================================
  // ---------- reports ----------
  // =====================================================================================================
  var RPT_GROUP = { day: 'Day', week: 'Week', month: 'Month', salesperson: 'Salesperson', customer: 'Customer', product: 'Product', area: 'Area', order: 'Order',
    driver: 'Driver', vehicle: 'Vehicle', date: 'Date', trip: 'Trip', stop: 'Every stop' };
  var RPT_ORDER_STATUS = [['PENDING', 'Pending approval'], ['APPROVED', 'Approved'], ['QB_SYNCED', 'QuickBooks synced'], ['READY', 'Ready / on van'], ['DELIVERED', 'Delivered'],
    ['PARTIAL', 'Partially delivered'], ['CANCELLED', 'Cancelled'], ['DRAFT', 'Draft']];
  var RPT_QB_STATUS = [['PENDING', 'Waiting'], ['SYNCED', 'Synced'], ['FAILED', 'Retrying'], ['EXCEPTION', 'Needs action'], ['CANCELLED', 'Cancelled']];
  var RPT_GPS_STATUS = { gps_visits: [['VERIFIED', 'At shop'], ['NEAR', 'Near'], ['MISMATCH', 'Mismatch'], ['NO_SHOP_GPS', 'Shop GPS missing']],
    gps_deliveries: [['VERIFIED', 'Verified'], ['NEAR', 'Near'], ['MISMATCH', 'Mismatch'], ['NO_CUSTOMER_GPS', 'Shop GPS missing'], ['NO_DRIVER_GPS', 'No driver GPS'], ['RECORDED', 'Not delivered (recorded)']] };
  var rptCat = null;

  function fmtCell(v, t) {
    if (v === '' || v === null || v === undefined) return '';
    switch (t) {
      case 'money': return pkr(Math.round(Number(v) * 100) / 100);
      case 'qty': return qty(v);
      case 'int': return Number(v).toLocaleString('en-US');
      case 'pct': return v + '%';
      case 'm': return Number(v) >= 1000 ? (Number(v) / 1000).toFixed(1) + ' km' : Math.round(Number(v)) + ' m';
      case 'coord': return Number(v).toFixed(6);
      case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtDate(v + 'T12:00:00Z', false) : esc(v);
      case 'datetime': return fmtDate(v);
      default: return esc(v);
    }
  }
  function isNum(t) { return ['money', 'qty', 'int', 'pct', 'm'].indexOf(t) >= 0; }
  function reportTable(res, opts) {
    opts = opts || {};
    var cols = res.columns;
    return '<div class="scroll-x"><table class="tbl rpt"><thead><tr>' + cols.map(function (c) { return '<th' + (isNum(c.t) ? ' class="n"' : '') + '>' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      res.rows.map(function (r, i) {
        return '<tr>' + cols.map(function (c, j) {
          var v = fmtCell(r[c.k], c.t);
          if (j === 0 && (r._drill || r._link) && !opts.noLinks) v = '<a role="button" tabindex="0" style="cursor:pointer" data-row="' + i + '">' + (v || '—') + '</a>';
          return '<td' + (isNum(c.t) ? ' class="n"' : '') + '>' + v + '</td>';
        }).join('') + '</tr>';
      }).join('') +
      (res.totals ? '<tr class="tot">' + cols.map(function (c, j) { var v = res.totals[c.k]; return '<td' + (isNum(c.t) ? ' class="n"' : '') + '>' + (j === 0 && (v === undefined || v === '') ? 'TOTAL' : fmtCell(v, c.t)) + '</td>'; }).join('') + '</tr>' : '') +
      '</tbody></table></div>';
  }
  function summaryTiles(sum) {
    if (!sum || !sum.length) return '';
    return '<div class="grid" style="margin-bottom:12px">' + sum.map(function (s) { return '<div class="stat"><div class="v"' + (s.t === 'money' ? ' style="font-size:17px"' : '') + '>' + fmtCell(s.value, s.t) + '</div><div class="l">' + esc(s.label) + '</div></div>'; }).join('') + '</div>';
  }

  VIEWS.reports = function (r) {
    loading('Reports', r.seg[1] ? 'reports' : null);
    (rptCat ? Promise.resolve(rptCat) : API.call('reports.catalog')).then(function (cat) {
      rptCat = cat;
      if (!r.seg[1]) return drawReportCatalog(cat);
      var def = cat.reports.filter(function (x) { return x.id === r.seg[1]; })[0];
      if (!def) { toast('You do not have access to that report.', true); return go('reports'); }
      runReport(def, cat, r.q);
    }).catch(showError);
  };

  function drawReportCatalog(cat) {
    var groups = {};
    cat.reports.forEach(function (x) { (groups[x.group] = groups[x.group] || []).push({ title: x.title, desc: x.description, href: '#/reports/' + x.id }); });
    if (cat.commission) groups.Commission = [
      { title: 'Weekly commission', desc: 'This week by salesperson: delivered cartons, sales and commission.', href: '#/commission?tab=report&quick=week&group=salesperson' },
      { title: 'Monthly commission', desc: 'This month by salesperson.', href: '#/commission?tab=report&quick=month&group=salesperson' },
      { title: 'Commission by product', desc: 'Delivered cartons, rate and commission per product.', href: '#/commission?tab=report&quick=month&group=product' },
      { title: 'Commission by customer', desc: 'Which shops earned the commission.', href: '#/commission?tab=report&quick=month&group=customer' },
      { title: 'Detailed / custom period', desc: 'Any dates, drill-down to every delivery line; Excel with all calculations.', href: '#/commission?tab=report&quick=month' }];
    if (cat.customerMap) (groups.Customers = groups.Customers || []).unshift({ title: 'Customer map', desc: 'Shops on Google Maps with last visit and last order; filters by salesperson, area and date.', href: '#/custmap' });
    var order = ['Sales', 'Orders', 'Delivery', 'Salesperson', 'Commission', 'Customers', 'GPS', 'QuickBooks'];
    var html = order.filter(function (g) { return groups[g]; }).map(function (g) {
      return '<div class="group-title">' + esc(g) + '</div><ul class="list">' + groups[g].map(function (x) {
        return '<li><a class="row" href="' + x.href + '"><span class="main-t"><div class="t1">' + esc(x.title) + '</div><div class="t2" style="white-space:normal">' + esc(x.desc) + '</div></span><span>›</span></a></li>';
      }).join('') + '</ul>';
    }).join('');
    shell('Reports', html || '<div class="empty card">No reports are available for your role.</div>');
  }

  function runReport(def, cat, q) {
    var o = cat.options || {}, f = def.filters, isStatement = def.id === 'statement';
    var params = Object.assign({}, def.defaults || {}, q);
    if (f.indexOf('dates') >= 0 && !params.from && !params.to) { var mr = quickRange(isStatement ? 'month' : 'month'); params.from = mr[0]; params.to = mr[1]; params.quick = params.quick || 'month'; }
    var setQ = function (patch) {
      var n = Object.assign({}, q, patch); if (patch.from !== undefined || patch.to !== undefined) n.quick = patch.quick || '';
      go('reports/' + def.id + '?' + Object.keys(n).filter(function (k) { return n[k] !== '' && n[k] !== undefined && n[k] !== null; }).map(function (k) { return k + '=' + encodeURIComponent(n[k]); }).join('&'));
    };
    var sel = function (id, list, val, all) { return '<select id="' + id + '">' + (all !== false ? '<option value="">' + esc(all) + '</option>' : '') + list.map(function (x) { var v = x.id !== undefined ? x.id : x[0], l = x.label !== undefined ? x.label : x[1]; return '<option value="' + esc(v) + '"' + (String(v) === String(val || '') ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('') + '</select>'; };
    var html = '<div class="card noprint">';
    if (f.indexOf('dates') >= 0) {
      html += '<div class="toolbar" style="margin:0 0 8px">' + QUICK.map(function (x) { return '<button class="btn' + (params.quick === x[0] ? ' primary' : '') + '" data-quick="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>' +
        '<div class="toolbar" style="margin:0 0 8px"><label style="font-size:13px">From <input type="date" id="rFrom" value="' + esc(params.from || '') + '"></label><label style="font-size:13px">To <input type="date" id="rTo" value="' + esc(params.to || '') + '"></label></div>';
    }
    html += '<div class="toolbar" style="margin:0">';
    if (f.indexOf('basis') >= 0) html += sel('rBasis', [['BOOKED', 'Booked orders'], ['DELIVERED', 'Delivered sales']], params.basis, false);
    if (f.indexOf('groupBy') >= 0 && def.groupBy) html += sel('rGroup', def.groupBy.map(function (g) { return [g, 'By ' + RPT_GROUP[g].toLowerCase()]; }), params.groupBy, false);
    if (f.indexOf('salesperson') >= 0 && o.salespersons) html += sel('rSp', o.salespersons, params.salespersonId, 'All salespersons');
    if (f.indexOf('area') >= 0 && o.areas && o.areas.length) html += sel('rArea', o.areas.map(function (a) { return [a, a]; }), params.area, 'All areas');
    if (f.indexOf('product') >= 0 && o.products) html += sel('rProd', o.products, params.productId, 'All products');
    if (f.indexOf('driver') >= 0 && o.drivers) html += sel('rDrv', o.drivers, params.driverId, 'All drivers');
    if (f.indexOf('vehicle') >= 0 && o.vehicles) html += sel('rVeh', o.vehicles, params.vehicleId, 'All vehicles');
    if (f.indexOf('orderStatus') >= 0) html += sel('rSt', RPT_ORDER_STATUS, params.status, 'All statuses');
    if (f.indexOf('qbStatus') >= 0) html += sel('rSt', RPT_QB_STATUS, params.status, 'All statuses');
    if (f.indexOf('gpsStatus') >= 0) html += sel('rGps', RPT_GPS_STATUS[def.id] || [], params.gpsStatus, 'Any GPS result');
    if (f.indexOf('gps') >= 0) html += sel('rHasGps', [['captured', 'GPS captured'], ['missing', 'GPS missing']], params.gps, 'GPS: any');
    if (f.indexOf('active') >= 0) html += sel('rAct', [['true', 'Active'], ['false', 'Inactive']], params.active, 'Active + inactive');
    html += '</div>';
    if (f.indexOf('customer') >= 0) html += '<div class="field" style="margin:10px 0 0;max-width:460px"><label>' + (isStatement ? 'Customer *' : 'Customer') + '</label>' +
      (params.customerId ? '<div class="toolbar" style="margin:0"><b id="rCustName">' + esc(params.customerName || 'Selected customer') + '</b><button class="btn" id="rCustClr">Change</button></div>'
        : '<input type="search" id="rCust" placeholder="Search shop name, code or phone" autocomplete="off"><ul class="list" id="rCustRes" style="margin-top:6px"></ul>') + '</div>';
    var active = ['salespersonId', 'area', 'productId', 'customerId', 'driverId', 'vehicleId', 'status', 'gpsStatus', 'gps', 'active'].some(function (k) { return q[k]; });
    if (active) html += '<p style="margin:8px 0 0;font-size:13px">Filters active · <a href="#/reports/' + def.id + (q.quick ? '?quick=' + q.quick : q.from ? '?from=' + q.from + '&to=' + (q.to || '') : '') + '">clear filters</a></p>';
    html += '</div><div id="rOut"><div class="spinner">Loading…</div></div>';
    var root = shell(def.title, html, { back: 'reports' });
    $all('[data-quick]', root).forEach(function (b) { b.onclick = function () { var x = quickRange(b.dataset.quick); setQ({ from: x[0], to: x[1], quick: b.dataset.quick }); }; });
    if ($('#rFrom', root)) { var cust = function () { setQ({ from: $('#rFrom', root).value, to: $('#rTo', root).value }); }; $('#rFrom', root).onchange = cust; $('#rTo', root).onchange = cust; }
    [['rBasis', 'basis'], ['rGroup', 'groupBy'], ['rSp', 'salespersonId'], ['rArea', 'area'], ['rProd', 'productId'], ['rDrv', 'driverId'], ['rVeh', 'vehicleId'], ['rSt', 'status'], ['rGps', 'gpsStatus'], ['rHasGps', 'gps'], ['rAct', 'active']]
      .forEach(function (x) { var el = $('#' + x[0], root); if (el) el.onchange = function () { var p = {}; p[x[1]] = el.value; setQ(p); }; });
    if ($('#rCustClr', root)) $('#rCustClr', root).onclick = function () { setQ({ customerId: '', customerName: '' }); };
    if ($('#rCust', root)) {
      var inp = $('#rCust', root), t;
      inp.oninput = function () {
        clearTimeout(t); if (inp.value.trim().length < 2) { $('#rCustRes', root).innerHTML = ''; return; }
        t = setTimeout(function () {
          API.call('customers.list', { q: inp.value, pageSize: 10 }).then(function (res) {
            $('#rCustRes', root).innerHTML = res.items.map(function (c, i) { return '<li><a class="row" role="button" tabindex="0" style="cursor:pointer" data-cu="' + i + '"><span class="main-t"><div class="t1">' + esc(c.ShopName) + '</div><div class="t2">' + esc(c.Code) + ' · ' + esc(c.Area) + ' · ' + esc(c.Mobile) + '</div></span></a></li>'; }).join('') || '<li><div class="row">No match</div></li>';
            $all('[data-cu]', root).forEach(function (a) { a.onclick = function () { var c = res.items[Number(a.dataset.cu)]; setQ({ customerId: c.CustomerID, customerName: c.ShopName }); }; });
          }).catch(showError);
        }, 300);
      };
      if (isStatement) inp.focus();
    }
    if (isStatement && !params.customerId) { $('#rOut', root).innerHTML = '<div class="empty card">Choose a customer to see the statement.</div>'; return; }

    var payload = { report: def.id };
    ['from', 'to', 'basis', 'groupBy', 'salespersonId', 'area', 'productId', 'customerId', 'driverId', 'vehicleId', 'status', 'gpsStatus', 'gps', 'active'].forEach(function (k) { if (params[k]) payload[k] = params[k]; });
    API.call('reports.run', payload).then(function (res) {
      var out = $('#rOut', root); if (!out) return;
      var head = '<div class="printonly print-head"><div style="font-size:18px;font-weight:800">' + esc(State.settings.COMPANY_NAME || 'Prosol Foods') + '</div><div style="font-size:16px;font-weight:700">' + esc(res.title) + '</div><div style="font-size:12px">' + esc(res.subtitle) + '</div><div style="font-size:11px">' + esc(printedLine()) + '</div></div>';
      var body = '';
      if (isStatement) body = statementHtml(res);
      else {
        body = summaryTiles(res.summary) + '<div class="card"><h2 class="noprint" style="margin-bottom:4px">' + esc(res.title) + '</h2><p class="noprint" style="margin:0 0 8px;color:var(--muted);font-size:13px">' + esc(res.subtitle) + ' · ' + res.rowCount + ' row' + (res.rowCount === 1 ? '' : 's') + '</p>' +
          (res.rows.length ? reportTable(res) : '<div class="empty">Nothing in this period with these filters.</div>') +
          (res.truncated ? '<div class="alert warn">Showing the first ' + res.rows.length + ' of ' + res.rowCount + ' rows. Narrow the filters, or use Excel for everything up to this limit.</div>' : '') +
          (res.note ? '<p class="hint" style="font-size:12px;color:var(--muted)">' + esc(res.note) + '</p>' : '') + '</div>';
      }
      body += '<div class="btn-row noprint"><button class="btn primary" id="xXlsx">Excel</button><button class="btn" id="xCsv">CSV</button><button class="btn" id="xPdf">PDF</button><button class="btn" id="xPrint">Print</button></div>';
      out.innerHTML = (isStatement ? '' : head) + body;
      paperControl(out);
      $all('[data-row]', out).forEach(function (a) { a.onclick = function () {
        var row = res.rows[Number(a.dataset.row)];
        if (row._drill) { var d = Object.assign({}, row._drill); var target = d.report || def.id; delete d.report;
          var n = Object.assign({}, target === def.id ? q : { from: params.from, to: params.to }, d); if (d.from) n.quick = '';
          return go('reports/' + target + '?' + Object.keys(n).filter(function (k) { return n[k]; }).map(function (k) { return k + '=' + encodeURIComponent(n[k]); }).join('&')); }
        if (row._link) go(row._link);
      }; });
      var name = res.title + ' ' + (params.from || '') + (params.to ? ' to ' + params.to : '');
      var sheets = isStatement ? statementSheets(res) : [{ name: res.title, title: res.title, subtitle: res.subtitle + ' · ' + printedLine(), columns: res.columns, rows: res.rows, totals: res.totals,
        footer: [res.note, res.truncated ? 'First ' + res.rows.length + ' of ' + res.rowCount + ' rows.' : ''].filter(Boolean) }].concat(res.summary && res.summary.length ? [{ name: 'Summary', title: res.title + ' — summary', subtitle: res.subtitle,
          columns: [{ k: 'label', label: 'Measure', t: 'text' }, { k: 'value', label: 'Value', t: 'money' }], rows: res.summary.map(function (s) { return { label: s.label, value: s.value }; }) }] : []);
      $('#xXlsx', out).onclick = function () { exportXlsx(name, sheets); toast('Excel file ready.'); };
      $('#xCsv', out).onclick = function () { exportCsvCols(name, res.columns, res.rows, res.totals); };
      $('#xPdf', out).onclick = function () { exportPdf(payload, this); };
      $('#xPrint', out).onclick = function () { window.print(); };
    }).catch(function (e) { var out = $('#rOut', root); if (out) out.innerHTML = '<div class="alert bad">' + esc(e.message || 'Could not run the report.') + '</div>'; });
  }

  // ---------- customer statement ----------
  function statementHtml(res) {
    var c = res.customer;
    return '<div class="card print-doc"><div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px"><div><div style="font-size:20px;font-weight:800">' + esc(State.settings.COMPANY_NAME || 'Prosol Foods') + '</div>' +
      '<div style="font-size:13px">' + esc(State.settings.COMPANY_ADDRESS || '') + ' ' + esc(State.settings.COMPANY_PHONE || '') + '</div></div><div style="text-align:right"><div style="font-size:18px;font-weight:700">CUSTOMER STATEMENT</div>' +
      '<div>' + fmtDate(res.filters.from + 'T12:00:00Z', false) + ' to ' + fmtDate(res.filters.to + 'T12:00:00Z', false) + '</div></div></div>' +
      '<hr style="border:0;border-top:1px solid var(--line);margin:12px 0"><div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;font-size:14px"><div><b>' + esc(c.ShopName) + '</b> (' + esc(c.Code) + ')<br>' + esc(c.Address) + ', ' + esc(c.Area) + ', ' + esc(c.City) + '<br>' + esc(c.Mobile) + '</div>' +
      '<div>Salesperson: ' + esc(c.Salesperson) + '<br>Credit limit: ' + money(c.CreditLimit) + (c.PaymentTerms ? '<br>Terms: ' + esc(c.PaymentTerms) : '') + '</div></div>' +
      '<div class="alert ' + (c.QBBalanceAsOf ? 'good' : 'warn') + '" style="margin-top:12px"><b>Outstanding balance (QuickBooks): ' + (c.QBBalanceAsOf ? money(c.QBBalance) + '</b> as of ' + fmtDate(c.QBBalanceAsOf) : 'not synced yet</b>') + '</div>' +
      summaryTiles(res.summary) +
      '<h2 style="font-size:15px">Deliveries and returns</h2>' + (res.rows.length ? reportTable(res) : '<div class="empty">No deliveries or returns in this period.</div>') +
      (res.open.rows.length ? '<h2 style="font-size:15px;margin-top:14px">Open orders not yet delivered</h2>' + reportTable(res.open) : '') +
      '<p class="hint" style="font-size:12px;color:var(--muted)">' + esc(res.note) + '</p>' +
      '<div style="display:flex;justify-content:space-between;margin-top:36px;font-size:13px"><div>______________________<br>For ' + esc(State.settings.COMPANY_NAME || 'Prosol Foods') + '</div><div>______________________<br>Customer signature &amp; stamp</div></div></div>';
  }
  function statementSheets(res) {
    var c = res.customer;
    return [{ name: 'Statement', title: 'Customer statement — ' + c.ShopName + ' (' + c.Code + ')', subtitle: res.filters.from + ' to ' + res.filters.to + ' · Outstanding (QuickBooks): ' +
      (c.QBBalanceAsOf ? c.QBBalance + ' as of ' + fmtDate(c.QBBalanceAsOf) : 'not synced') + ' · ' + printedLine(), columns: res.columns, rows: res.rows, totals: res.totals, footer: [res.note] },
    { name: 'Open orders', title: 'Open orders not yet delivered — ' + c.ShopName, subtitle: printedLine(), columns: res.open.columns, rows: res.open.rows, totals: res.open.totals }];
  }

  // ---------- customer map: separate page (map.html) so the Google Maps script never runs inside the main app ----------
  VIEWS.custmap = function () {
    if (!hasGsr) { location.href = 'map.html'; return; }
    shell('Customer map', '<div class="card"><p>The customer map opens on the company app address (it needs Google Maps, which is limited to that address).</p><p><b>https://app.pro-sol.pk/map.html</b></p></div>', { back: 'reports' });
  };

  // ---------- trip delivery summary (printable) ----------
  function tripSummaryPrint(id) {
    loading('Delivery summary', 'trips/' + encodeURIComponent(id));
    API.call('delivery.trip', { DeliveryID: id }).then(function (t) {
      var ctn = function (s) { return Math.round(s.Lines.reduce(function (a, l) { return a + (Number(l.ThisStopQty) || 0) / l.UnitsPerCarton; }, 0) * 100) / 100; };
      var tot = { stops: t.StopsList.length, del: 0, part: 0, fail: 0, pend: 0, ctn: 0, val: 0 };
      t.StopsList.forEach(function (s) { tot[{ DELIVERED: 'del', PARTIAL: 'part', FAILED: 'fail' }[s.Status] || 'pend']++; tot.ctn += ctn(s); tot.val += Number(s.DeliveredNet) || 0; });
      var st = State.settings;
      var html = '<div class="print-doc"><div class="btn-row noprint" style="margin-bottom:12px"><button class="btn primary" id="doPrint">Print / Save PDF</button><a class="btn" href="#/trips/' + encodeURIComponent(t.DeliveryID) + '">Back</a></div>' +
        '<div class="card"><div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px"><div><div style="font-size:20px;font-weight:800">' + esc(st.COMPANY_NAME || 'Prosol Foods') + '</div><div style="font-size:12px">' + esc(st.COMPANY_ADDRESS || '') + ' ' + esc(st.COMPANY_PHONE || '') + '</div></div>' +
        '<div style="text-align:right"><div style="font-size:17px;font-weight:700">DELIVERY SUMMARY</div><div>' + esc(t.TripNo) + ' · ' + fmtDate(t.DeliveryDate, false) + '</div><div style="font-size:12px">' + esc(TRIP_LABELS[t.Status] || t.Status) + '</div></div></div>' +
        '<p style="font-size:14px">Vehicle ' + esc(t.VehicleNo) + ' · Driver ' + esc(t.DriverName) + (t.Helper ? ' · Helper ' + esc(t.Helper) : '') + (t.Route ? ' · Route ' + esc(t.Route) : '') + '</p>' +
        '<p style="font-size:14px"><b>' + tot.stops + '</b> stops: <b>' + tot.del + '</b> delivered, <b>' + tot.part + '</b> partial, <b>' + tot.fail + '</b> not delivered' + (tot.pend ? ', <b>' + tot.pend + '</b> pending' : '') + ' · <b>' + qty(tot.ctn) + '</b> cartons · <b>' + money(Math.round(tot.val * 100) / 100) + '</b></p>' +
        '<table class="tbl"><tr><th class="wide">#</th><th>Shop</th><th class="wide">Order</th><th>Result</th><th class="n">Ctn</th><th class="n">Value</th><th class="wide">GPS</th><th>Reason / remarks</th></tr>' + t.StopsList.map(function (s) {
          return '<tr><td class="wide">' + s.Sequence + '</td><td>' + esc(s.Customer.ShopName) + '<br><small>' + esc(s.Customer.Area) + '</small></td><td class="wide">' + esc(s.OrderNo) + '</td><td>' + esc(STOP_LABELS[s.Status] || s.Status) + (s.DeliveredAt ? '<br><small>' + fmtDate(s.DeliveredAt) + '</small>' : '') + '</td>' +
            '<td class="n">' + (s.Status === 'FAILED' || s.Status === 'PENDING' ? '' : qty(ctn(s))) + '</td><td class="n">' + (s.DeliveredNet ? pkr(s.DeliveredNet) : '') + '</td><td class="wide">' + (gpsStopBadge(s) || '') + '</td><td>' + esc(s.OverrideReason || s.Remarks || '') + '</td></tr>';
        }).join('') + '<tr class="tot"><td class="wide"></td><td>TOTAL</td><td class="wide"></td><td></td><td class="n">' + qty(tot.ctn) + '</td><td class="n">' + pkr(Math.round(tot.val * 100) / 100) + '</td><td class="wide"></td><td></td></tr></table>' +
        '<div style="display:flex;justify-content:space-between;margin-top:40px;font-size:13px"><div>____________________<br>Driver</div><div>____________________<br>Distribution manager</div></div>' +
        '<p style="font-size:11px;color:var(--muted)">' + esc(printedLine()) + '</p></div></div>';
      var root = shell('Summary ' + t.TripNo, html, { back: 'trips/' + encodeURIComponent(t.DeliveryID) });
      $('#doPrint', root).onclick = function () { window.print(); };
      paperControl(root);
    }).catch(showError);
  }

  // ---------- commission Excel (transaction-level, with every calculation input) ----------
  function commissionExcel(filt, range, btn) {
    busy(btn, true);
    API.call('commission.report', Object.assign({}, filt, { all: true })).then(function (full) {
      busy(btn, false);
      var sub = range[0] + ' to ' + range[1] + ' · ' + printedLine();
      var g = full.groupBy;
      exportXlsx('prosol-commission-' + range[0] + '-to-' + range[1], [
        { name: 'Summary by ' + g, title: 'Salesperson commission report — by ' + g, subtitle: sub,
          columns: [{ k: 'Label', label: GROUP_LABEL[g] || g, t: 'text' }, { k: 'DeliveredQty', label: 'Delivered units', t: 'qty' }, { k: 'DeliveredCartons', label: 'Delivered cartons', t: 'qty' },
            { k: 'ReturnedCartons', label: 'Returned cartons', t: 'qty' }, { k: 'NetCartons', label: 'Net cartons', t: 'qty' }, { k: 'Sales', label: 'Net sales', t: 'money' },
            { k: 'RatesText', label: 'Rates', t: 'text' }, { k: 'Lines', label: 'Lines', t: 'int' }, { k: 'Commission', label: 'Commission', t: 'money' }],
          rows: full.summary.map(function (x) { return Object.assign({}, x, { RatesText: x.Rates.map(function (k) { var p = k.split(':'); return rateText(p[0], p[1]); }).join(', ') }); }), totals: full.totals },
        { name: 'Transactions', title: 'Commission transactions — every line traceable to its delivery', subtitle: sub,
          columns: [{ k: 'TxnDate', label: 'Date', t: 'date' }, { k: 'Period', label: 'Period', t: 'text' }, { k: 'SourceType', label: 'Source', t: 'text' }, { k: 'OrderNo', label: 'Order', t: 'text' },
            { k: 'TripNo', label: 'Delivery trip', t: 'text' }, { k: 'Salesperson', label: 'Salesperson', t: 'text' }, { k: 'Customer', label: 'Customer', t: 'text' }, { k: 'Area', label: 'Area', t: 'text' },
            { k: 'Product', label: 'Product', t: 'text' }, { k: 'SKU', label: 'SKU', t: 'text' }, { k: 'Quantity', label: 'Delivered qty (units)', t: 'qty' }, { k: 'Cartons', label: 'Cartons', t: 'qty' },
            { k: 'CommissionType', label: 'Type', t: 'text' }, { k: 'Rate', label: 'Rate (PKR/ctn or %)', t: 'qty' }, { k: 'RuleSource', label: 'Rule from', t: 'text' }, { k: 'BaseType', label: 'Base', t: 'text' },
            { k: 'BaseAmount', label: 'Base amount', t: 'money' }, { k: 'FractionRule', label: 'Fraction rule', t: 'text' }, { k: 'SalesValue', label: 'Sales value', t: 'money' },
            { k: 'Commission', label: 'Commission', t: 'money' }, { k: 'Status', label: 'Status', t: 'text' }, { k: 'Note', label: 'Note', t: 'text' }],
          rows: full.detail.items, totals: { Quantity: full.totals.DeliveredQty, Commission: full.totals.Commission, SalesValue: full.totals.Sales },
          footer: ['Fixed per carton: commission = cartons × rate (fraction rule applied). Percentage: commission = base amount × rate %. Returns reverse at the original rate.'] }
      ]);
      toast(full.detail.items.length + ' lines exported to Excel.');
    }).catch(function (e) { busy(btn, false); showError(e); });
  }

  // ---------- Google Maps key (Settings) ----------
  function mapsKeyCard(root) {
    var box = document.createElement('div'); box.className = 'card'; root.appendChild(box);
    API.call('maps.config').then(function (c) {
      box.innerHTML = '<h2>Google Maps (customer map)</h2><p style="font-size:14px">Key: ' + (c.configured ? '<span class="badge good">set</span>' : '<span class="badge warn">not set</span>') +
        '. Use a key restricted to <b>https://app.pro-sol.pk/*</b> and to the <b>Maps JavaScript API</b> only. It is stored in Script Properties, not in the spreadsheet.</p>' +
        '<div class="field"><label>New API key</label><input type="password" id="mkKey" autocomplete="off" placeholder="AIza…"><div class="ferr" data-err="key"></div></div>' +
        '<div class="btn-row"><button class="btn primary" id="mkSave">Save key</button>' + (c.configured ? '<button class="btn danger" id="mkDel">Remove key</button>' : '') + '</div>';
      $('#mkSave', box).onclick = function () { var b = this, v = $('#mkKey', box).value.trim(); if (!v) return toast('Paste the key first.', true); busy(b, true);
        API.call('maps.saveKey', { key: v }).then(function () { toast('Maps key saved.'); render(); }).catch(function (e) { busy(b, false); fieldError(box, e); }); };
      if ($('#mkDel', box)) $('#mkDel', box).onclick = function () { confirmBox('Remove key', 'The customer map stops working until a new key is saved.', 'Remove').then(function (y) {
        if (y) API.call('maps.saveKey', { key: '' }).then(function () { toast('Maps key removed.'); render(); }).catch(showError); }); };
    }).catch(function () { box.remove(); });
  }

  // ---------- system: database capacity and archive ----------
  function capBar(pct) {
    var cls = pct >= 85 ? 'bad' : pct >= 70 ? 'warn' : 'good';
    return '<div class="cap"><span class="cap-' + cls + '" style="width:' + Math.min(100, pct) + '%"></span></div>';
  }
  /** System screen of the Supabase version: database size against the plan, no archive (all history stays in one database). */
  function systemSupabase(hl) {
    var mb = function (b) { return (Math.round(b / 1024 / 1024 * 10) / 10).toLocaleString() + ' MB'; };
    var html = (hl.warnings || []).map(function (w) { return '<div class="alert warn">' + esc(w) + '</div>'; }).join('') +
      '<div class="card"><h2>Database size</h2><p style="font-size:14px;color:var(--muted)">The database is on Supabase (Postgres). All history stays in one database; nothing needs archiving.</p>' +
      '<dl class="kv"><dt>Live database</dt><dd>' + capBar(hl.main.pct) + hl.main.pct + '% · ' + mb(hl.main.bytes) + ' of ' + mb(hl.limit) + '</dd>' +
      '<dt>Orders</dt><dd>' + (hl.main.orders || 0).toLocaleString() + (hl.main.firstOrder ? ' since ' + fmtDate(hl.main.firstOrder + 'T12:00:00Z', false) : '') + '</dd>' +
      '<dt>Backups</dt><dd>Only on the Supabase Pro plan (daily, kept 7 days; Supabase dashboard → Database → Backups). The Free plan has NO automatic backups.</dd></dl></div>' +
      '<div class="card"><h2>Archive</h2><p>' + esc(hl.archive && hl.archive.message || 'No archive is needed.') + '</p></div>';
    shell('System & archive', html);
  }

  VIEWS.system = function () {
    loading('System & archive');
    API.call('system.health').then(function (hl) {
      if (hl.supabase) return systemSupabase(hl);
      var a = hl.archive;
      var html = (hl.warnings || []).map(function (w) { return '<div class="alert warn">' + esc(w) + '</div>'; }).join('') +
        '<div class="card"><h2>Database size</h2><p style="font-size:14px;color:var(--muted)">Google Sheets allows 10,000,000 cells per spreadsheet (empty cells count too). Finished history is moved to monthly archive spreadsheets automatically every night.</p>' +
        '<dl class="kv"><dt>Live database</dt><dd>' + capBar(hl.main.pct) + hl.main.pct + '% · ' + hl.main.cells.toLocaleString() + ' cells</dd>' +
        '<dt>Log spreadsheet</dt><dd>' + capBar(hl.logs.pct) + hl.logs.pct + '%' + (hl.logs.older ? ' · ' + hl.logs.older + ' older log file(s)' : '') + '</dd>' +
        '<dt>Growth</dt><dd>' + (hl.growth.cellsPerDay ? '≈ ' + hl.growth.cellsPerDay.toLocaleString() + ' cells a day over the last ' + hl.growth.liveDays + ' days' : 'not enough data yet') + '</dd>' +
        '<dt>Room left</dt><dd>' + (hl.growth.daysUntil85 === null ? '—' : hl.growth.daysUntil85 > 3650 ? 'years' : 'about ' + hl.growth.daysUntil85 + ' days until 85% (without archiving)') + '</dd></dl>' +
        '<details style="margin-top:8px"><summary>Largest tables</summary><table class="tbl"><tr><th>Table</th><th class="n">Rows</th><th class="n">Cells</th></tr>' +
        hl.main.tables.slice(0, 12).map(function (t) { return '<tr><td>' + esc(t.table) + '</td><td class="n">' + t.rows.toLocaleString() + '</td><td class="n">' + t.cells.toLocaleString() + '</td></tr>'; }).join('') + '</table></details></div>';
      html += '<div class="card"><h2>Archive</h2><dl class="kv"><dt>Archived up to</dt><dd>' + (a.cutoff ? fmtDate(a.cutoff + 'T12:00:00Z', false) : 'nothing archived yet') + '</dd>' +
        '<dt>Archive months</dt><dd>' + (a.months.length ? esc(a.months.join(', ')) : '—') + '</dd><dt>Archived orders</dt><dd>' + a.archivedOrders.toLocaleString() + '</dd>' +
        '<dt>Keep live</dt><dd>' + a.keepDays + ' days (Settings → Archive keep days)</dd></dl>' +
        '<p class="hint" style="font-size:13px;color:var(--muted)">Archived orders still appear in reports, statements and the commission report, and open read-only from Orders (search by order number). Nothing is ever deleted.</p>' +
        '<div class="btn-row"><button class="btn" id="arPreview">Preview</button><button class="btn primary" id="arRun">Archive now</button></div><div id="arOut"></div>' +
        (a.log.length ? '<h2 style="font-size:15px;margin-top:14px">Recent runs</h2><ul class="list">' + a.log.map(function (l) {
          return '<li><div class="row"><span class="main-t"><div class="t1">' + esc(l.Message || l.Status) + '</div><div class="t2">' + fmtDate(l.At) + ' · ' + esc(l.By) + '</div></span><span class="badge ' + (l.Status === 'OK' ? 'good' : 'bad') + '">' + esc(l.Status) + '</span></div></li>';
        }).join('') + '</ul>' : '') + '</div>';
      var root = shell('System & archive', html);
      var show = function (r) {
        var c = r.counts || {}, kept = r.kept || {};
        $('#arOut', root).innerHTML = '<div class="alert ' + (r.dryRun ? 'warn' : 'good') + '" style="margin-top:12px">' + (r.dryRun ? 'Would archive ' : 'Archived ') + '<b>' + r.orders + '</b> order(s) dated before ' + fmtDate(r.cutoff + 'T12:00:00Z', false) +
          (r.periods && r.periods.length ? ' and commission months ' + esc(r.periods.join(', ')) : '') + ' · ' + Object.keys(c).filter(function (k) { return c[k]; }).map(function (k) { return k + ' ' + c[k]; }).join(', ') + '</div>' +
          '<p style="font-size:13px">Kept live: ' + [['tooRecent', 'recent'], ['notFinished', 'not finished'], ['pendingStop', 'on an open trip'], ['pendingReturn', 'return pending'], ['quickbooks', 'not in QuickBooks yet'], ['commission', 'commission month not closed and paid']]
            .filter(function (x) { return kept[x[0]]; }).map(function (x) { return kept[x[0]] + ' ' + x[1]; }).join(' · ') + '</p>' +
          ((r.blockers || []).length ? '<h2 style="font-size:15px">Old orders holding history back</h2><ul class="list">' + r.blockers.map(function (b) {
            return '<li><a class="row" href="#/orders/' + encodeURIComponent(b.OrderID) + '"><span class="main-t"><div class="t1">' + esc(b.OrderNo) + ' · ' + fmtDate(b.OrderDate + 'T12:00:00Z', false) + '</div><div class="t2">' + esc(b.Reason) + '</div></span><span class="badge warn">' + esc(b.Status) + '</span></a></li>';
          }).join('') + '</ul>' : '');
      };
      $('#arPreview', root).onclick = function () { var b = this; busy(b, true); API.call('archive.run', { dryRun: true }).then(function (r) { busy(b, false); show(r); }).catch(function (e) { busy(b, false); showError(e); }); };
      $('#arRun', root).onclick = function () {
        confirmBox('Archive now', 'Finished history is moved to the monthly archive spreadsheets. While it runs (up to a few minutes) other users may see "system busy". It runs by itself every night at 03:00 — use this only when needed.', 'Archive now').then(function (y) {
          if (!y) return; var b = $('#arRun', root); busy(b, true);
          API.call('archive.run', {}).then(function (r) { busy(b, false); show(r); toast('Archive finished.'); }).catch(function (e) { busy(b, false); showError(e); });
        });
      };
    }).catch(showError);
  };

  // ---------- boot ----------
  function render(opts) {
    if (!State.token) return renderLogin();
    if (!State.me) return boot();
    if (State.me.mustChangePassword) return renderChangePassword(true);
    renderSeq++; uiTouched = false;
    var keepY = opts && opts.keepScroll ? window.scrollY : null;
    var r = parseHash(), name = r.seg[0] || 'home';
    var nav = NAV.find(function (n) { return n.path === name; });
    if (!VIEWS[name] || (nav && !(nav.routePerm ? can(nav.routePerm) : navAllowed(nav)))) { go('home'); return; }
    if (keepY === null) window.scrollTo(0, 0);
    VIEWS[name](r);
    if (keepY !== null) setTimeout(function () { window.scrollTo(0, keepY); }, 0);
  }

  function boot() {
    if (!State.token) return renderLogin();
    $('#root').innerHTML = '<div class="spinner">Loading…</div>';
    return Local.init().then(function () { return API.call('auth.me'); }).then(function (d) {
      State.me = d.me; State.settings = d.settings || {};
      return Local.loadUser(d.me.userId);
    }).then(function () {
      render();
      if (!Net.down()) Sync.run().then(function (sent) { if (!sent) Pack.refresh(); });
    }).catch(function (e) {
      if (e.code === 'PASSWORD_CHANGE_REQUIRED') return;
      if (e.code === 'OFFLINE') return renderOfflineStart();
      State.clear(); renderLogin(e.message);
    });
  }

  /** Signed in before, but this phone has never opened the app with internet since: nothing to work from yet. */
  function renderOfflineStart() {
    $('#root').innerHTML = '<div class="login-wrap"><div class="login-card"><div class="logo">PROSOL FOODS</div><div class="card"><h2>No internet</h2>' +
      '<p>Open the app once with internet so your customers, products and deliveries can be saved on this phone. After that it also works without signal.</p>' +
      '<button class="btn primary block" id="retryBoot">Try again</button></div></div></div>';
    $('#retryBoot').onclick = function () { Net.isDown = false; boot(); };
  }

  if (!hasGsr && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* the app still works online */ }); });
  }

  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();

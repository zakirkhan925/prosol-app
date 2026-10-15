/* Prosol Foods — customer map (map.html). A separate page so the Google Maps script, which needs a looser
 * Content-Security-Policy, never runs inside the main app. Uses the same sign-in (session token on this device).
 * The Maps key comes from the server only for users allowed to see customers; it must be restricted in Google Cloud
 * to https://app.pro-sol.pk/* and to the Maps JavaScript API. */
(function () {
  'use strict';
  if (window.top !== window.self) { document.body.textContent = 'Open the customer map directly.'; return; }
  var CONFIG = window.PROSOL_CONFIG || {}, token = null;
  try { token = localStorage.getItem('prosol.token'); } catch (e) { /* storage blocked */ }
  var $ = function (s) { return document.querySelector(s); };
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (k) { if (k) e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k); });
    return e;
  }
  function fmt(iso, withTime) {
    if (!iso) return '';
    var d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T12:00:00Z' : iso); if (isNaN(d)) return iso;
    var o = { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Karachi' }; if (withTime) { o.hour = '2-digit'; o.minute = '2-digit'; }
    return d.toLocaleString('en-GB', o);
  }
  function money(n) { return 'PKR ' + Number(n || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 }); }
  function call(action, payload) {
    return fetch(CONFIG.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: action, payload: payload || {}, token: token }), redirect: 'follow', cache: 'no-store' })
      .then(function (r) { return r.json(); }, function () { throw { message: 'Could not reach the server. The customer map needs internet.', code: 'NETWORK' }; })
      .then(function (res) { if (res && res.ok) return res.data; throw (res && res.error) || { message: 'Unexpected response.' }; });
  }
  function fail(msg, signIn) {
    $('#count').innerHTML = '<div class="alert bad">' + esc(msg) + (signIn ? ' <a href="./">Sign in</a>' : '') + '</div>';
    $('#map').style.display = 'none';
  }
  function q() {
    var o = {}; (location.hash.replace(/^#\??/, '')).split('&').forEach(function (kv) { if (!kv) return; var x = kv.split('='); o[decodeURIComponent(x[0])] = decodeURIComponent(x[1] || ''); }); return o;
  }
  function setQ(patch) {
    var n = Object.assign(q(), patch);
    location.hash = Object.keys(n).filter(function (k) { return n[k]; }).map(function (k) { return k + '=' + encodeURIComponent(n[k]); }).join('&');
  }

  var map = null, markers = [], info = null, cfg = null, advanced = false, first = true;
  function colorOf(p) {
    if (!p.active) return '#8a8a8a';
    if (p.lastOrder && (Date.now() - new Date(p.lastOrder.date + 'T12:00:00Z').getTime()) < 30 * 86400000) return '#1e8e4e';
    return '#e0a100';
  }
  function infoNode(p) {
    var dl = el('dl', {}, []);
    var row = function (k, v) { if (v) { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', {}, [v])); } };
    row('Phone', p.mobile ? el('a', { href: 'tel:' + p.mobile, text: p.mobile }) : null);
    row('Address', p.address);
    row('Salesperson', p.salesperson);
    row('Last visit', p.lastVisit ? fmt(p.lastVisit.at, true) + ' · ' + p.lastVisit.type.replace(/_/g, ' ').toLowerCase() + (p.lastVisit.by ? ' · ' + p.lastVisit.by : '') : 'none');
    row('Last order', p.lastOrder ? p.lastOrder.no + ' · ' + fmt(p.lastOrder.date) + ' · ' + money(p.lastOrder.net) + ' · ' + p.lastOrder.status : 'none');
    row('Location', p.lat.toFixed(6) + ', ' + p.lng.toFixed(6) + (p.acc ? ' (±' + Math.round(p.acc) + ' m)' : '') + (p.capturedAt ? ' · ' + fmt(p.capturedAt) : ''));
    return el('div', { class: 'iw' }, [el('h3', { text: p.shop }), el('div', { text: p.code + (p.active ? '' : ' · INACTIVE') }), dl,
      el('div', {}, [el('a', { href: './#/customers/' + encodeURIComponent(p.id), text: 'Open customer' }),
        el('a', { href: 'https://www.google.com/maps/dir/?api=1&destination=' + p.lat + ',' + p.lng, target: '_blank', rel: 'noopener', text: 'Navigate' })])]);
  }
  function draw(data) {
    markers.forEach(function (m) { if (advanced) m.map = null; else m.setMap(null); });
    markers = [];
    var bounds = new google.maps.LatLngBounds();
    data.points.forEach(function (p) {
      var pos = { lat: p.lat, lng: p.lng }, m;
      if (advanced) {
        var pin = new google.maps.marker.PinElement({ background: colorOf(p), borderColor: '#ffffff', glyphColor: '#ffffff' });
        m = new google.maps.marker.AdvancedMarkerElement({ map: map, position: pos, title: p.shop, content: pin.element, gmpClickable: true });
        m.addListener('click', function () { info.setContent(infoNode(p)); info.open({ map: map, anchor: m }); });
      } else {
        m = new google.maps.Marker({ map: map, position: pos, title: p.shop,
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: colorOf(p), fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2 } });
        m.addListener('click', function () { info.setContent(infoNode(p)); info.open({ map: map, anchor: m }); });
      }
      m.__prosol = p.id; markers.push(m); bounds.extend(pos);
    });
    if (data.points.length === 1) { map.setCenter({ lat: data.points[0].lat, lng: data.points[0].lng }); map.setZoom(16); }
    else if (data.points.length) map.fitBounds(bounds, 40);
    window.__prosolMarkers = markers; // used by automated tests
  }
  function load() {
    var f = q();
    $('#count').textContent = 'Loading…';
    return call('reports.customerMap', { salespersonId: f.sp, area: f.area, q: f.q, active: f.active, from: f.from, to: f.to }).then(function (data) {
      if (first) { filters(data, f); first = false; }
      $('#count').textContent = data.points.length + ' shop' + (data.points.length === 1 ? '' : 's') + ' on the map · ' + data.missing.length + ' without GPS';
      $('#missing').innerHTML = data.missing.length ? '<div class="group-title">Shops without a saved location</div><ul class="list">' + data.missing.map(function (m) {
        return '<li><a class="row" href="./#/customers/' + encodeURIComponent(m.id) + '"><span class="main-t"><div class="t1">' + esc(m.shop) + '</div><div class="t2">' + esc(m.code) + ' · ' + esc(m.address) + ' · ' + esc(m.salesperson) + '</div></span><span class="badge warn">No GPS</span></a></li>';
      }).join('') + '</ul>' : '';
      if (map) draw(data);
      return data;
    }).catch(function (e) { fail(e.message || 'Could not load customers.', e.code === 'SESSION'); });
  }
  function filters(data, f) {
    var box = $('#filters'), h = '';
    if (data.salespersons) h += '<select id="fSp"><option value="">All salespersons</option>' + data.salespersons.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === f.sp ? ' selected' : '') + '>' + esc(s.label) + '</option>'; }).join('') + '</select>';
    h += '<select id="fArea"><option value="">All areas</option>' + data.areas.map(function (a) { return '<option' + (a === f.area ? ' selected' : '') + '>' + esc(a) + '</option>'; }).join('') + '</select>';
    h += '<input type="search" id="fQ" placeholder="Shop, code, phone" value="' + esc(f.q || '') + '">';
    h += '<select id="fAct"><option value="">Active + inactive</option><option value="true"' + (f.active === 'true' ? ' selected' : '') + '>Active</option><option value="false"' + (f.active === 'false' ? ' selected' : '') + '>Inactive</option></select>';
    h += '<label style="font-size:13px;display:flex;gap:4px;align-items:center">Visited/ordered from <input type="date" id="fFrom" value="' + esc(f.from || '') + '"></label><label style="font-size:13px;display:flex;gap:4px;align-items:center">to <input type="date" id="fTo" value="' + esc(f.to || '') + '"></label>';
    box.innerHTML = h;
    var on = function (id, k) { var e = $('#' + id); if (e) e.onchange = function () { var p = {}; p[k] = e.value; setQ(p); }; };
    on('fSp', 'sp'); on('fArea', 'area'); on('fAct', 'active'); on('fFrom', 'from'); on('fTo', 'to');
    var t; $('#fQ').oninput = function () { clearTimeout(t); t = setTimeout(function () { setQ({ q: $('#fQ').value }); }, 500); };
  }
  window.addEventListener('hashchange', load);

  window.gm_authFailure = function () { fail('Google refused the Maps key. In Google Cloud, allow https://app.pro-sol.pk/* for this key and enable the Maps JavaScript API (with billing).'); };
  window.prosolMapReady = function () {
    advanced = !!(cfg.mapId && google.maps.marker && google.maps.marker.AdvancedMarkerElement);
    var opts = { center: { lat: 33.6, lng: 73.05 }, zoom: 12, mapTypeControl: false, streetViewControl: false, fullscreenControl: true, clickableIcons: false };
    if (advanced) opts.mapId = cfg.mapId;
    map = new google.maps.Map($('#map'), opts);
    info = new google.maps.InfoWindow();
    load();
  };

  if (!token) return fail('You are not signed in on this device.', true);
  call('maps.config').then(function (c) {
    cfg = c;
    if (!c.configured) { load(); $('#map').innerHTML = '<div class="card" style="margin:16px">The Google Maps key has not been set yet (Settings → Google Maps). Shops are listed below without the map.</div>'; return; }
    var s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(c.key) + '&v=weekly&loading=async&callback=prosolMapReady' + (c.mapId ? '&libraries=marker' : '');
    s.async = true; s.onerror = function () { load(); fail('Google Maps could not be loaded (no internet, or blocked).'); };
    document.head.appendChild(s);
  }).catch(function (e) { fail(e.message || 'Could not open the map.', e.code === 'SESSION'); });
})();

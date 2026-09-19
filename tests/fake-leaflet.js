// テスト用の最小Leaflet代替。実際のタイル取得・DOM描画を行わずに、
// ダッシュボードが呼び出す地図APIだけを記録・再現する。
// window.__fakeLeaflet から生成されたマップ・マーカーを検査できる。
(function () {
  window.__fakeLeaflet = { maps: {}, markers: [], circleMarkers: [], polylines: [], layerGroups: [], tileLayers: [] };

  function FakeLayer() { this._map = null; }
  FakeLayer.prototype.addTo = function (map) {
    this._map = map;
    if (map && map._layers) map._layers.push(this);
    return this;
  };
  FakeLayer.prototype.remove = function () { this._map = null; return this; };

  function FakeTileLayer(url, opts) {
    FakeLayer.call(this);
    this.url = url; this.opts = opts || {};
    window.__fakeLeaflet.tileLayers.push(this);
  }
  FakeTileLayer.prototype = Object.create(FakeLayer.prototype);
  FakeTileLayer.prototype.setUrl = function (u) { this.url = u; return this; };

  function FakeMarker(latlng, opts) {
    FakeLayer.call(this);
    this.latlng = latlng;
    this.opts = opts || {};
    this.icon = this.opts.icon || null;
    this._popupContent = null;
    this._tooltipContent = null;
    this._tooltipOpts = null;
    this._tooltipOpen = false;
    this._handlers = {};
    window.__fakeLeaflet.markers.push(this);
  }
  FakeMarker.prototype = Object.create(FakeLayer.prototype);
  FakeMarker.prototype.bindPopup = function (c) { this._popupContent = c; return this; };
  FakeMarker.prototype.setLatLng = function (ll) { this.latlng = ll; return this; };
  FakeMarker.prototype.setIcon = function (icon) { this.icon = icon; return this; };
  FakeMarker.prototype.bindTooltip = function (c, o) {
    this._tooltipContent = c; this._tooltipOpts = o || {};
    this._tooltipOpen = !!(o && o.permanent);
    return this;
  };
  FakeMarker.prototype.unbindTooltip = function () {
    this._tooltipContent = null; this._tooltipOpts = null; this._tooltipOpen = false; return this;
  };
  FakeMarker.prototype.openTooltip = function () { this._tooltipOpen = true; return this; };
  FakeMarker.prototype.closeTooltip = function () { this._tooltipOpen = false; return this; };
  FakeMarker.prototype.on = function (evt, fn) { (this._handlers[evt] = this._handlers[evt] || []).push(fn); return this; };
  FakeMarker.prototype.fire = function (evt, payload) {
    (this._handlers[evt] || []).forEach(function (fn) { fn(payload || {}); });
    return this;
  };
  FakeMarker.prototype.getElement = function () {
    if (!this._el) {
      this._el = document.createElement("div");
      this._el.innerHTML = this.icon && this.icon.opts ? (this.icon.opts.html || "") : "";
    }
    return this._el;
  };

  function FakeCircleMarker(latlng, opts) {
    FakeLayer.call(this);
    this.latlng = latlng; this.style = opts || {};
    this._popupContent = null; this._front = false;
    window.__fakeLeaflet.circleMarkers.push(this);
  }
  FakeCircleMarker.prototype = Object.create(FakeLayer.prototype);
  FakeCircleMarker.prototype.bindPopup = function (c) { this._popupContent = c; return this; };
  FakeCircleMarker.prototype.setStyle = function (s) { this.style = Object.assign({}, this.style, s); return this; };
  FakeCircleMarker.prototype.bringToFront = function () { this._front = true; return this; };

  function FakePolyline(latlngs, opts) {
    FakeLayer.call(this);
    this.latlngs = latlngs; this.opts = opts || {};
    window.__fakeLeaflet.polylines.push(this);
  }
  FakePolyline.prototype = Object.create(FakeLayer.prototype);

  function FakeLayerGroup() {
    FakeLayer.call(this);
    this._layers = [];
    window.__fakeLeaflet.layerGroups.push(this);
  }
  FakeLayerGroup.prototype = Object.create(FakeLayer.prototype);
  FakeLayerGroup.prototype.clearLayers = function () { this._layers = []; return this; };
  FakeLayerGroup.prototype.addLayer = function (l) { this._layers.push(l); return this; };

  function FakeBounds(latlngs) { this.latlngs = (latlngs || []).slice(); }
  FakeBounds.prototype.extend = function (ll) { this.latlngs.push(ll); return this; };
  FakeBounds.prototype.isValid = function () { return this.latlngs.length > 0; };

  function FakeMap(id, opts) {
    this.id = id; this.opts = opts || {};
    this._layers = [];
    this._view = null; this._zoom = null;
    this._fitBounds = null; this._fitBoundsOpts = null;
    this._panTo = null; this._invalidated = 0;
    this._handlers = {};
    window.__fakeLeaflet.maps[id] = this;
  }
  FakeMap.prototype.setView = function (ll, z) { this._view = ll; if (z != null) this._zoom = z; return this; };
  FakeMap.prototype.panTo = function (ll) { this._panTo = ll; return this; };
  FakeMap.prototype.fitBounds = function (b, o) {
    this._fitBounds = b; this._fitBoundsOpts = o;
    if (this._zoom === null) this._zoom = 12;
    return this;
  };
  FakeMap.prototype.invalidateSize = function () { this._invalidated++; return this; };
  FakeMap.prototype.getZoom = function () { return this._zoom; };
  FakeMap.prototype.setZoom = function (z) {
    this._zoom = z;
    (this._handlers.zoomend || []).forEach(function (fn) { fn({}); });
    return this;
  };
  FakeMap.prototype.on = function (evt, fn) { (this._handlers[evt] = this._handlers[evt] || []).push(fn); return this; };
  FakeMap.prototype.off = function (evt) { delete this._handlers[evt]; return this; };
  FakeMap.prototype.addLayer = function (l) { this._layers.push(l); return this; };
  FakeMap.prototype.removeLayer = function (l) {
    var i = this._layers.indexOf(l);
    if (i >= 0) this._layers.splice(i, 1);
    return this;
  };
  FakeMap.prototype.remove = function () { this._layers = []; return this; };

  window.L = {
    map: function (id, opts) { return new FakeMap(id, opts); },
    tileLayer: function (url, opts) { return new FakeTileLayer(url, opts); },
    marker: function (ll, opts) { return new FakeMarker(ll, opts); },
    circleMarker: function (ll, opts) { return new FakeCircleMarker(ll, opts); },
    polyline: function (ll, opts) { return new FakePolyline(ll, opts); },
    layerGroup: function () { return new FakeLayerGroup(); },
    divIcon: function (opts) { return { opts: opts || {} }; },
    latLngBounds: function (ll) { return new FakeBounds(ll); }
  };
})();

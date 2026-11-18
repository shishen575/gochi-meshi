'use strict';
const { s2ToLatLng } = require('./s2');
// Googleマップのリンクから、店名・座標を取り出す／逆ジオコードの住所から市区町村を選ぶ

const ALLOWED = [/^([a-z0-9-]+\.)?google\.(com|co\.jp)$/i, /^maps\.app\.goo\.gl$/i, /^goo\.gl$/i];
const isAllowedHost = h => ALLOWED.some(r => r.test(h));
const inJapan = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat > 20 && lat < 46.5 && lng > 122 && lng < 154.5;

function safeDecode(s) { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return s; } }
// 短縮リンクの展開先は「?q=〒530-0022 大阪府大阪市北区浪花町４−２３ 王道乃印 天神家 天満店」の形になることがある。
// 住所と店名に分ける（住所は空白を含まない前提）
function splitAddressQuery(v) {
  const m = v.match(/^〒?\s*(\d{3}-?\d{4})\s+(\S+)\s*(.*)$/);
  if (m) return { address: m[2].normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-'), name: m[3].trim() };
  const t = v.trim().split(/\s+/);
  if (/^(北海道|.{2,3}[都府県])/.test(t[0]) && /[0-9０-９]/.test(t[0])) return { address: t[0].normalize('NFKC'), name: t.slice(1).join(' ') };
  return null;
}
const looksLikeCoords = s => /^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/.test(s);

function parseGmapsUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  const out = { name: '', lat: null, lng: null, address: '', hint: null };
  const full = u.pathname + (u.search || '');

  // 店のピンの正確な座標（!3d緯度!4d経度）を優先し、無ければ @緯度,経度
  let m = full.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (!m) m = u.pathname.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (m && inJapan(+m[1], +m[2])) { out.lat = +m[1]; out.lng = +m[2]; }

  const pm = u.pathname.match(/\/maps\/(?:place|search)\/([^/@]+)/);
  if (pm) {
    // /maps/place/〒542-0076 大阪府…難波５丁目１−６０ 店名/ のように、住所＋店名が入っていることがある
    const seg = safeDecode(pm[1]), sp = splitAddressQuery(seg);
    if (sp) { out.address = sp.address; out.name = sp.name; } else out.name = seg;
  }
  for (const k of ['q', 'query', 'destination']) {
    const v = u.searchParams.get(k);
    if (!v) continue;
    if (looksLikeCoords(v)) {
      const [a, b] = v.split(',').map(Number);
      if (out.lat == null && inJapan(a, b)) { out.lat = a; out.lng = b; }
    } else if (!out.name) {
      const sp = k === 'q' ? splitAddressQuery(v) : null;
      if (sp) { out.address = sp.address; out.name = sp.name; } else out.name = v;
    }
  }
  if (looksLikeCoords(out.name)) out.name = '';
  out.name = out.name.replace(/\s+/g, ' ').trim().slice(0, 60);
  // 店ID（ftid=0x…:0x… または !1s0x…:0x…）からおおよその位置のヒントを得る
  const fid = u.searchParams.get('ftid') || (full.match(/!1s(0x[0-9a-f]+):0x[0-9a-f]+/i) || [])[1] || '';
  const hx = (fid.match(/^(0x[0-9a-f]+)/i) || [])[1];
  if (hx) { const h = s2ToLatLng(hx); if (h && inJapan(h.lat, h.lng)) out.hint = { lat: +h.lat.toFixed(5), lng: +h.lng.toFixed(5) }; }
  return out.name || out.address || out.lat != null ? out : null;
}

// 住所文字列（都道府県から始まる）から、都道府県と市区町村を取り出す
function parseAddress(addr, prefs, cities) {
  const a = String(addr || '').normalize('NFKC');
  const pref = prefs.find(p => a.startsWith(p)) || '';
  if (!pref) return { pref: '', city: '' };
  const rest = a.slice(pref.length);
  const city = (cities[pref] || []).filter(c => rest.startsWith(c)).sort((x, y) => y.length - x.length)[0] || '';
  return { pref, city };
}

// Nominatim の address から、市区町村リスト（cities）に載っている名前を選ぶ
function pickCity(addr, cities) {
  const city = addr.city || addr.town || addr.village || addr.municipality || '';
  const ward = addr.city_district || addr.suburb || addr.borough || '';
  const county = addr.county || '';
  const cands = [city + ward, ward && city ? city + ward : '', city, ward, county + city, county + (addr.town || addr.village || '')].filter(Boolean);
  for (const c of cands) if (cities.includes(c)) return c;
  for (const c of [city, ward].filter(Boolean)) {
    const hit = cities.find(x => x.endsWith(c));
    if (hit) return hit;
  }
  return '';
}

// OpenStreetMap は「難波5丁目1-60」より「難波5-1-60」の形のほうが当たりやすいので、表記を変えた候補を作る
function addressVariants(addr) {
  const a = String(addr || '').trim();
  const out = [];
  const dash = a.replace(/(\d+)丁目(\d+)-(\d+)/, '$1-$2-$3').replace(/(\d+)丁目(\d+)$/, '$1-$2');
  if (dash !== a) out.push(dash);
  out.push(a);
  const town = a.match(/^(.*?\d+丁目)/);
  const coarse = town ? town[1] : a.replace(/[\d-]+$/, '');
  return { precise: [...new Set(out)], coarse: coarse && coarse !== a ? coarse : '' };
}

module.exports = { addressVariants, parseAddress, parseGmapsUrl, pickCity, isAllowedHost, inJapan };

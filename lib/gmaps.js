'use strict';
// Googleマップのリンクから、店名・座標を取り出す／逆ジオコードの住所から市区町村を選ぶ

const ALLOWED = [/^([a-z0-9-]+\.)?google\.(com|co\.jp)$/i, /^maps\.app\.goo\.gl$/i, /^goo\.gl$/i];
const isAllowedHost = h => ALLOWED.some(r => r.test(h));
const inJapan = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat > 20 && lat < 46.5 && lng > 122 && lng < 154.5;

function safeDecode(s) { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return s; } }
const looksLikeCoords = s => /^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/.test(s);

function parseGmapsUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  const out = { name: '', lat: null, lng: null };
  const full = u.pathname + (u.search || '');

  // 店のピンの正確な座標（!3d緯度!4d経度）を優先し、無ければ @緯度,経度
  let m = full.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (!m) m = u.pathname.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (m && inJapan(+m[1], +m[2])) { out.lat = +m[1]; out.lng = +m[2]; }

  const pm = u.pathname.match(/\/maps\/(?:place|search)\/([^/@]+)/);
  if (pm) out.name = safeDecode(pm[1]);
  for (const k of ['q', 'query', 'destination']) {
    const v = u.searchParams.get(k);
    if (!v) continue;
    if (looksLikeCoords(v)) {
      const [a, b] = v.split(',').map(Number);
      if (out.lat == null && inJapan(a, b)) { out.lat = a; out.lng = b; }
    } else if (!out.name) out.name = v;
  }
  if (looksLikeCoords(out.name)) out.name = '';
  out.name = out.name.replace(/\s+/g, ' ').trim().slice(0, 60);
  return out.name || out.lat != null ? out : null;
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

module.exports = { parseGmapsUrl, pickCity, isAllowedHost, inJapan };

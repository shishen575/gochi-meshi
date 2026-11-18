'use strict';
const express = require('express');
const crypto = require('crypto');
const { guessGenre } = require('./public/genre.js');
const { createLumi } = require('./lib/lumi');
const { addressVariants, parseGmapsUrl, parseAddress, pickCity, isAllowedHost } = require('./lib/gmaps');
const fs = require('fs');
const path = require('path');

/* ---------- 設定（環境変数） ---------- */
const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const GUILD_ID = process.env.DISCORD_GUILD_ID || '';          // 空なら Discord ログインできる人なら誰でも投稿可
const GOOGLE_MAPS_KEY = (process.env.GOOGLE_MAPS_KEY || '').trim();   // 設定するとGoogleマップで表示（未設定ならOpenStreetMap）
const LUMI_URL = (process.env.LUMI_URL || '').trim();                       // 連携するLumiのアドレス（例: https://lumi.shishen575.net）
const LUMI_CONNECT_TOKEN = (process.env.LUMI_CONNECT_TOKEN || '').trim();   // /integration create で発行した接続用トークン（初回だけ・15分で失効）
const WEBHOOK_URL = (process.env.DISCORD_WEBHOOK_URL || '').trim();   // 設定すると、お店が追加されたときにそのチャンネルへ通知
const PLACES_KEY = (process.env.GOOGLE_PLACES_KEY || '').trim();        // サーバー用キー（Places API (New)）。設定すると営業時間・電話をGoogleから取得
const PLACES_ENDPOINT = process.env.GOOGLE_PLACES_ENDPOINT || 'https://places.googleapis.com/v1/places:searchText';
const WEBHOOK_NAME = (process.env.DISCORD_WEBHOOK_NAME || 'ご当地めし帖').trim().slice(0, 80);   // Webhook通知の表示名（例: Lumi）
const WEBHOOK_AVATAR = (process.env.DISCORD_WEBHOOK_AVATAR || '').trim();                       // Webhook通知のアイコン画像URL（PNG/JPG, https）
const RELAY_URL = (process.env.LUMI_RELAY_URL || '').trim();           // Lumi等のBOT側の受け口（トークンを渡さずに通知。最優先）
const RELAY_SECRET = (process.env.LUMI_RELAY_SECRET || '').trim();
const BOT_TOKEN = (process.env.DISCORD_BOT_TOKEN || '').trim();         // BOT経由で通知する場合（Webhookより優先）
const NOTIFY_CHANNEL_ID = (process.env.DISCORD_CHANNEL_ID || '').trim();
const DISCORD_API = (process.env.DISCORD_API_BASE || 'https://discord.com/api/v10').replace(/\/+$/, '');
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const SECURE = PUBLIC_URL.startsWith('https://');
const SESSION_DAYS = 14;

fs.mkdirSync(DATA_DIR, { recursive: true });
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------- 保存（JSONファイル、原子的に書き込み） ---------- */
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { spots: [], votes: {}, reviews: {}, favs: {}, granted: {}, uploads: {} }; // favs: { userId: [spotId,...] } / votes: { spotId: [userId,...] } / reviews: { spotId: [{id,userId,name,avatar,rating,text,createdAt}] }
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch (e) {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), err => { if (!err) fs.rename(tmp, DB_FILE, () => {}); });
  }, 200);
}

/* ---------- セッション（署名付きCookie） ---------- */
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
let SECRET = process.env.SESSION_SECRET || '';
if (!SECRET) {
  try { SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) {}
  if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 }); }
}
const b64 = b => Buffer.from(b).toString('base64url');
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken(payload) { const body = b64(JSON.stringify(payload)); return body + '.' + sign(body); }
function readToken(tok) {
  if (!tok || typeof tok !== 'string') return null;
  const [body, sig] = tok.split('.');
  if (!body || !sig) return null;
  const a = Buffer.from(sig), c = Buffer.from(sign(body));
  if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch (e) { return null; }
}
function parseCookies(h) {
  const out = {};
  (h || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function setCookie(res, name, value, maxAgeSec) {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE ? '; Secure' : ''}`);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  const G = GOOGLE_MAPS_KEY ? ' https://maps.googleapis.com https://maps.gstatic.com' : '';
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'" + G + "; connect-src 'self'" + G + "; " +
    "img-src 'self' https://cdn.discordapp.com https://tile.openstreetmap.org data: blob:" + (GOOGLE_MAPS_KEY ? ' https://maps.googleapis.com https://maps.gstatic.com https://*.ggpht.com https://*.googleusercontent.com' : '') + "; " +
    "style-src 'self' 'unsafe-inline'" + (GOOGLE_MAPS_KEY ? ' https://fonts.googleapis.com' : '') + "; font-src 'self'" + (GOOGLE_MAPS_KEY ? ' https://fonts.gstatic.com' : '') + "; " +
    "worker-src blob:; frame-ancestors 'none'");
  const c = parseCookies(req.headers.cookie);
  req.user = readToken(c.sid);
  next();
});

/* ---------- Discord OAuth2 ---------- */
const REDIRECT_URI = PUBLIC_URL + '/auth/callback';
app.get('/auth/login', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) return res.status(500).send('DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET が未設定です。');
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, 'oauth_state', state, 600);
  const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'identify guilds', state, prompt: 'none' });
  res.redirect('https://discord.com/oauth2/authorize?' + q);
});

app.get('/auth/callback', async (req, res) => {
  const c = parseCookies(req.headers.cookie);
  const { code, state } = req.query;
  setCookie(res, 'oauth_state', '', 0);
  if (!code || !state || state !== c.oauth_state) return res.status(400).send('ログインの状態が一致しません。もう一度お試しください。');
  try {
    const tr = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code: String(code), redirect_uri: REDIRECT_URI })
    });
    if (!tr.ok) throw new Error('token ' + tr.status);
    const { access_token } = await tr.json();
    const auth = { Authorization: 'Bearer ' + access_token };
    const me = await (await fetch('https://discord.com/api/users/@me', { headers: auth })).json();
    let member = true;
    if (GUILD_ID) {
      const gr = await fetch('https://discord.com/api/users/@me/guilds', { headers: auth });
      const guilds = gr.ok ? await gr.json() : [];
      member = Array.isArray(guilds) && guilds.some(g => g.id === GUILD_ID);
    }
    if (!me.id) throw new Error('no user');
    const user = {
      id: me.id, name: me.global_name || me.username || 'user',
      avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : '',
      member, admin: ADMIN_IDS.includes(me.id), exp: Date.now() + SESSION_DAYS * 864e5
    };
    setCookie(res, 'sid', makeToken(user), SESSION_DAYS * 86400);
    res.redirect('/');
  } catch (e) {
    console.error('oauth error', e.message);
    res.status(502).send('Discordとの連携に失敗しました。時間をおいてもう一度お試しください。');
  }
});

app.post('/auth/logout', (req, res) => { setCookie(res, 'sid', '', 0); res.json({ ok: true }); });

/* ---------- 位置情報（OpenStreetMap Nominatim） ---------- */
const UA = 'gochi-meshi/1.0 (' + PUBLIC_URL + ')';
let geoChain = Promise.resolve();
const inJapan = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat > 20 && lat < 46.5 && lng > 122 && lng < 154.5;
function geocodeOnce(q) {
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q, format: 'jsonv2', limit: '1', countrycodes: 'jp', 'accept-language': 'ja' });
  return fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) })
    .then(r => (r.ok ? r.json() : []))
    .then(a => (a[0] && inJapan(+a[0].lat, +a[0].lon) ? { lat: +(+a[0].lat).toFixed(6), lng: +(+a[0].lon).toFixed(6) } : null))
    .catch(() => null);
}
// Nominatim の利用規約に合わせ、1秒に1リクエストまでに直列化する
function geocode(queries) {
  const job = geoChain.then(async () => {
    for (const q of queries) {
      const r = await geocodeOnce(q);
      await new Promise(res => setTimeout(res, 1100));
      if (r) return r;
    }
    return null;
  });
  geoChain = job.catch(() => {});
  return job;
}
function reverseGeocode(lat, lng) {
  const job = geoChain.then(async () => {
    const url = 'https://nominatim.openstreetmap.org/reverse?' + new URLSearchParams({ lat: String(lat), lon: String(lng), format: 'jsonv2', zoom: '18', 'accept-language': 'ja' });
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) }).then(x => (x.ok ? x.json() : null)).catch(() => null);
    await new Promise(res => setTimeout(res, 1100));
    return r && r.address ? r.address : null;
  });
  geoChain = job.catch(() => {});
  return job;
}
// OSMの opening_hours（例: "Mo-Fr 11:00-21:00; Sa,Su 11:00-20:00; PH off"）を読みやすい日本語に
const DAYS = { Mo: '月', Tu: '火', We: '水', Th: '木', Fr: '金', Sa: '土', Su: '日', PH: '祝' };
const jaHours = raw => String(raw || '').replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, d => DAYS[d]).replace(/\boff\b/g, '休み').split(/\s*;\s*/).filter(Boolean).join('\n').slice(0, 400);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function queue(fn) {
  const job = geoChain.then(async () => { const r = await fn(); await sleep(1100); return r; });
  geoChain = job.catch(() => {});
  return job;
}
function searchRaw(params) {
  return queue(() => fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ format: 'jsonv2', limit: '1', countrycodes: 'jp', 'accept-language': 'ja', ...params }),
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) }).then(r => (r.ok ? r.json() : [])).then(a => a[0] || null).catch(() => null));
}
// 市区町村の中心と範囲。店の位置がこの範囲から外れる検索結果（同名の別の店など）は採用しない
const areaCache = new Map();
async function cityArea(pref, city) {
  const key = pref + city;
  if (areaCache.has(key)) return areaCache.get(key);
  const r = await searchRaw({ q: key });
  let area = null;
  if (r && inJapan(+r.lat, +r.lon) && Array.isArray(r.boundingbox)) {
    const [south, north, west, east] = r.boundingbox.map(Number);
    area = { lat: +(+r.lat).toFixed(6), lng: +(+r.lon).toFixed(6), south, north, west, east };
  }
  if (area) areaCache.set(key, area);
  return area;
}
// 市区町村の範囲内だけで探す。見つからなければ市区町村の中心（geo:'city' = 目安）
async function locateIn(pref, city, queries) {
  const area = await cityArea(pref, city);
  if (!area) return null;
  const pad = 0.005;
  for (const q of queries) {
    const r = await searchRaw({ q, viewbox: `${area.west - pad},${area.north + pad},${area.east + pad},${area.south - pad}`, bounded: '1' });
    if (r && inJapan(+r.lat, +r.lon)) return { lat: +(+r.lat).toFixed(6), lng: +(+r.lon).toFixed(6), geo: 'auto' };
  }
  return { lat: area.lat, lng: area.lng, geo: 'city' };
}
const locateSpot = sp => locateIn(sp.pref, sp.city, [`${sp.name} ${sp.city}`, sp.name]);
// 営業時間などの自動取得: Google Places（キーがある場合）→ OpenStreetMap の順
async function placeInfo(name, pref, city) {
  if (PLACES_KEY) {
    try {
      const r = await fetch(PLACES_ENDPOINT, {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': PLACES_KEY,
          'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.regularOpeningHours.weekdayDescriptions,places.nationalPhoneNumber,places.primaryType' },
        body: JSON.stringify({ textQuery: `${name} ${pref}${city}`, languageCode: 'ja', regionCode: 'JP', maxResultCount: 1 })
      });
      const j = r.ok ? await r.json() : null;
      const pl = j && j.places && j.places[0];
      if (pl && String(pl.formattedAddress || '').includes(pref)) {   // 別の地域の同名店は採用しない
        const hours = ((pl.regularOpeningHours || {}).weekdayDescriptions || []).join('\n').slice(0, 400);
        const phone = String(pl.nationalPhoneNumber || '').replace(/[^0-9+\-()\s]/g, '').slice(0, 30);
        const genre = guessGenre({ name, tags: pl.primaryType || '' });
        if (hours || phone || genre) return { hours, phone, genre, source: 'google' };
      } else if (!r.ok) console.warn('Places API エラー:', r.status);
    } catch (e) { console.warn('Places API 失敗:', e.message); }
  }
  const area = await cityArea(pref, city);
  if (!area) return null;
  const pad = 0.005;
  const hit = await searchRaw({ q: `${name} ${city}`, extratags: '1', viewbox: `${area.west - pad},${area.north + pad},${area.east + pad},${area.south - pad}`, bounded: '1' });
  const t = (hit && hit.extratags) || {};
  const hours = jaHours(t.opening_hours), phone = String(t.phone || t['contact:phone'] || '').replace(/[^0-9+\-()\s]/g, '').slice(0, 30);
  const genre = guessGenre({ name, tags: [t.cuisine, hit && hit.type, hit && hit.category].filter(Boolean).join(' ') });
  return hours || phone || genre ? { hours, phone, genre, source: 'osm' } : null;
}
const spotQueries = s => [`${s.name} ${s.pref}${s.city}`, `${s.pref}${s.city}`];

/* ---------- Discord への新着通知（Webhook） ---------- */
const hookOk = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(WEBHOOK_URL) || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(WEBHOOK_URL);
if (WEBHOOK_URL && !hookOk) console.warn('警告: DISCORD_WEBHOOK_URL の形式が正しくないため、通知は無効です');
const mdEsc = t => String(t).replace(/([\\*_~`|>\[\]()#])/g, '\\$1');
const botOk = !!BOT_TOKEN && /^\d{15,25}$/.test(NOTIFY_CHANNEL_ID);
if ((BOT_TOKEN || NOTIFY_CHANNEL_ID) && !botOk) console.warn('警告: DISCORD_BOT_TOKEN と DISCORD_CHANNEL_ID（数字のID）を両方正しく設定してください。BOT通知は無効です');
const relayOk = /^https:\/\//.test(RELAY_URL) || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(RELAY_URL);
if ((RELAY_URL || RELAY_SECRET) && !(relayOk && RELAY_SECRET.length >= 16)) console.warn('警告: LUMI_RELAY_URL（https）と LUMI_RELAY_SECRET（16文字以上）を両方設定してください。中継通知は無効です');
const relayReady = relayOk && RELAY_SECRET.length >= 16;
/* ---------- Lumi連携（通知・メンバー確認・ランク・ロール付与） ---------- */
const LUMI_MANIFEST = {
  name: 'ご当地めし帖', description: '都道府県・市区町村ごとのおすすめ飯を共有するサイト',
  capabilities: ['notify', 'members', 'rank', 'grant'],
  settings: [
    { key: 'min_posts', type: 'number', label: 'ロールを付与する投稿数', help: 'この件数のお店を投稿した人に、選んだロールを付けます。0で付与しません。' },
    { key: 'members_only', type: 'toggle', label: '投稿・いいね・口コミをサーバーのメンバーに限定', help: 'オンにすると、このサーバーのメンバーだけが書き込めます。' },
    { key: 'show_rank', type: 'toggle', label: '投稿者名の横に活動ランクを表示', help: 'Lumiの活動ランク（ロール名）を、お店のカードに表示します。' },
    { key: 'notify_reviews', type: 'toggle', label: '口コミも通知する', help: 'オフのときは、新しいお店の追加だけを通知します。' },
    { key: 'thread_by_pref', type: 'toggle', label: '都道府県ごとのスレッドにまとめる', help: 'オンにすると、通知を「東京都」のようなスレッドに分けて投稿します（なければ作ります）。' },
    { key: 'channel_hokkaido_tohoku', type: 'channel', label: '通知先：北海道・東北', help: '選ばない地域は、通常の通知先に送ります。' },
    { key: 'channel_kanto', type: 'channel', label: '通知先：関東', help: '' },
    { key: 'channel_chubu', type: 'channel', label: '通知先：中部', help: '' },
    { key: 'channel_kinki', type: 'channel', label: '通知先：近畿', help: '' },
    { key: 'channel_chugoku_shikoku', type: 'channel', label: '通知先：中国・四国', help: '' },
    { key: 'channel_kyushu_okinawa', type: 'channel', label: '通知先：九州・沖縄', help: '' }
  ]
};
const lumi = createLumi({ baseUrl: LUMI_URL, dataDir: DATA_DIR, connectToken: LUMI_CONNECT_TOKEN, manifest: LUMI_MANIFEST });
const toBool = v => v === true || v === 'true' || v === 1 || v === '1';
const toNum = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
let lumiSettings = { t: 0, v: {} };
async function lumiSetting(key, def) {
  if (!lumi.enabled()) return def;
  if (Date.now() - lumiSettings.t > 60000) {
    const r = await lumi.call('GET', '/internal/settings');
    lumiSettings = { t: Date.now(), v: r.ok && r.data ? (r.data.settings || r.data.values || r.data) : {} };
  }
  const v = lumiSettings.v[key];
  return v === undefined || v === null ? def : v;
}
// メンバー確認: true/false、確認できないとき（未設定・Lumi停止中など）は null
const memberCache = new Map();
async function lumiMember(uid) {
  if (!lumi.enabled()) return null;
  const c = memberCache.get(uid);
  if (c && Date.now() - c.t < 300000) return c.v;
  const r = await lumi.call('GET', '/internal/members/' + encodeURIComponent(uid));
  const v = r.status === 404 ? false : r.ok && r.data ? !!r.data.member : null;
  if (v !== null) memberCache.set(uid, { t: Date.now(), v });
  return v;
}
// 活動ランク: キャッシュを返し、古い・無いものは裏で取得（初回は表示されず、次の更新から出る）
const rankCache = new Map(); const rankLoading = new Set();
function rankOf(uid) {
  const c = rankCache.get(uid);
  if ((!c || Date.now() - c.t > 600000) && !rankLoading.has(uid) && rankLoading.size < 5) {
    rankLoading.add(uid);
    lumi.call('GET', '/internal/users/' + encodeURIComponent(uid) + '/rank')
      .then(r => rankCache.set(uid, { t: Date.now(), v: r.ok && r.data && r.data.rankRole ? String(r.data.rankRole).slice(0, 30) : '' }))
      .finally(() => rankLoading.delete(uid));
  }
  return c ? c.v : '';
}
async function maybeGrant(userId) {
  if (!lumi.enabled() || db.granted[userId]) return;
  const min = toNum(await lumiSetting('min_posts', 0));
  if (min < 1) return;
  const n = db.spots.filter(x => x.authorId === userId).length;
  if (n < min) return;
  const r = await lumi.call('POST', '/internal/roles/grant', { userId, reason: `ご当地めし帖で${n}件投稿` });
  if (r.ok) { db.granted[userId] = Date.now(); save(); }
}

/* ---------- 通知の送り先（Lumi連携 → 中継 → BOT直接 → Webhook の順） ---------- */
const anySink = () => lumi.enabled() || relayReady || botOk || hookOk;
// 地域ごとの通知先: Lumiへ route（地域キー）と thread（都道府県名）を添えて送り、宛先の決定はLumi側（ダッシュボードの設定）に任せる。
const REGION_KEYS = {
  hokkaido_tohoku: ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県'],
  kanto: ['茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県'],
  chubu: ['新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県'],
  kinki: ['三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県'],
  chugoku_shikoku: ['鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県'],
  kyushu_okinawa: ['福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県']
};
const routeFor = sp => ({ route: Object.keys(REGION_KEYS).find(k => REGION_KEYS[k].includes(sp.pref)) || '', thread: sp.pref });
let routeOffUntil = 0; // 古いLumiが route/thread を拒否した場合は、しばらく付けずに送る
async function sendEmbed(embed, routing) {
  try {
    if (lumi.enabled()) {
      const withRoute = routing && routing.route && Date.now() > routeOffUntil;
      let r = await lumi.call('POST', '/internal/meshi-notify', withRoute ? { embed, ...routing } : { embed });
      if (!r.ok && withRoute && r.status === 400) { routeOffUntil = Date.now() + 3600e3; r = await lumi.call('POST', '/internal/meshi-notify', { embed }); }
      if (r.ok) {
        if (r.data && r.data.sent === 0 && Date.now() - (sendEmbed.warnedAt || 0) > 3600e3) { sendEmbed.warnedAt = Date.now(); console.warn('Lumi通知: 送信先が0件でした（Lumiのダッシュボードで、通常の通知先か地域のチャンネルを選んでください）'); }
        return;
      }
      if (!(relayReady || botOk || hookOk)) { if (!r.blocked) console.warn('Lumi通知に失敗:', r.status, r.status === 403 ? '（Lumiのダッシュボードで通知をオンにし、チャンネルを選んでください）' : ''); return; }
    }
    if (relayReady) {
      // BOT側に渡すのは署名つきの埋め込みだけ。宛先チャンネルはBOT側で固定されているので、トークンもチャンネルIDも持たない
      const body = JSON.stringify({ embed });
      const ts = Date.now();
      const sig = crypto.createHmac('sha256', RELAY_SECRET).update(ts + '.' + body).digest('hex');
      const r = await fetch(RELAY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Timestamp': String(ts), 'X-Signature': sig }, body, signal: AbortSignal.timeout(8000) });
      if (!r.ok) console.warn('中継通知に失敗:', r.status);
      return;
    }
    if (!botOk && !hookOk) return;
    const url = botOk ? `${DISCORD_API}/channels/${NOTIFY_CHANNEL_ID}/messages` : WEBHOOK_URL;
    const headers = { 'Content-Type': 'application/json' };
    if (botOk) headers.Authorization = 'Bot ' + BOT_TOKEN;
    const payload = botOk ? { embeds: [embed], allowed_mentions: { parse: [] } } : { username: WEBHOOK_NAME, ...(/^https:\/\//.test(WEBHOOK_AVATAR) ? { avatar_url: WEBHOOK_AVATAR } : {}), embeds: [embed], allowed_mentions: { parse: [] } };
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
    if (!r.ok) console.warn('Discord通知に失敗:', r.status, botOk ? '（BOTにチャンネルの「メッセージを送信」「埋め込みリンク」権限があるか確認）' : '');
  } catch (e) { console.warn('Discord通知に失敗:', e.message); }
}
const avatarOk = u => /^https:\/\/cdn\.discordapp\.com\//.test(u || '');
async function notifyDiscord(spot) {
  if (!anySink()) return;
  const fields = [{ name: '場所', value: mdEsc(`${spot.pref} ${spot.city}`), inline: true }, { name: 'ジャンル', value: mdEsc(spot.genre), inline: true }];
  if (spot.price) fields.push({ name: '予算', value: mdEsc(spot.price), inline: true });
  const gmap = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(`${spot.name} ${spot.pref}${spot.city}`);
  fields.push({ name: 'Googleマップ', value: `[地図で開く](${gmap})` });
  const embed = {
    title: mdEsc(spot.name).slice(0, 250), url: `${PUBLIC_URL}/?s=${spot.id}`, color: 0x1c6b57,
    description: mdEsc(spot.comment).slice(0, 1000), fields,
    author: { name: `${mdEsc(spot.authorName).slice(0, 60)} さんの新しいおすすめ` }, timestamp: new Date(spot.createdAt).toISOString()
  };
  if (avatarOk(spot.authorAvatar)) embed.author.icon_url = spot.authorAvatar;
  if (spot.images && spot.images[0] && /^https:\/\//.test(PUBLIC_URL)) embed.image = { url: `${PUBLIC_URL}/img/${spot.images[0]}` };
  await sendEmbed(embed, routeFor(spot));
}
async function notifyReview(spot, review) {
  if (!anySink() || !toBool(await lumiSetting('notify_reviews', false))) return;
  const embed = {
    title: mdEsc(spot.name).slice(0, 250), url: `${PUBLIC_URL}/?s=${spot.id}`, color: 0xc8541f,
    description: ('★'.repeat(review.rating) + '☆'.repeat(5 - review.rating) + (review.text ? '\n' + mdEsc(review.text) : '')).slice(0, 1000),
    author: { name: `${mdEsc(review.name).slice(0, 60)} さんの口コミ` }, timestamp: new Date(review.createdAt).toISOString()
  };
  if (avatarOk(review.avatar)) embed.author.icon_url = review.avatar;
  await sendEmbed(embed);
}

/* ---------- API ---------- */
const PREFS = ["北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県","新潟県","富山県","石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県","三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県","鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県"];
const GENRES = ["ラーメン","寿司・海鮮","肉料理","定食・食堂","カレー","うどん・そば","郷土料理","カフェ・スイーツ","居酒屋","その他"];
const PRICES = ["", "〜1,000円","〜2,000円","〜3,000円","3,000円〜"];

let CITIES = {};
try { CITIES = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'cities.json'), 'utf8')); } catch (e) { console.warn('cities.json を読み込めませんでした（市区町村の検証を省略します）'); }

// Lumiの設定「メンバーに限定」がオンなら、書き込みのたびにLumiでメンバーか確認する（管理者は除く）
const lumiBlocks = async u => !u.admin && lumi.enabled() && toBool(await lumiSetting('members_only', false)) && (await lumiMember(u.id)) === false;
const need = async (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'ログインが必要です' });
  if (!req.user.member || await lumiBlocks(req.user)) return res.status(403).json({ error: 'このサーバーのメンバーのみ利用できます' });
  next();
};
const needJson = (req, res, next) => (req.is('application/json') ? next() : res.status(415).json({ error: 'JSONで送信してください' }));

const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const k = req.user.id + req.path; const now = Date.now();
    const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: '操作が多すぎます。少し待ってください' });
    arr.push(now); hits.set(k, arr); next();
  };
}
setInterval(() => hits.clear(), 3600e3).unref();

// 公開してよい設定（Googleマップのキーはリファラ制限をかけて公開する前提のもの）
app.get('/api/config', (req, res) => res.json({ googleMapsKey: GOOGLE_MAPS_KEY || null }));

app.get('/api/me', async (req, res) => {
  const u = req.user;
  const member = u ? u.member && !(await lumiBlocks(u)) : false;
  res.json({ loggedIn: !!u, user: u ? { id: u.id, name: u.name, avatar: u.avatar, member, admin: u.admin } : null, guildRestricted: !!GUILD_ID });
});

app.get('/api/spots', async (req, res) => {
  const uid = req.user && req.user.id;
  const myFavs = new Set((uid && db.favs[uid]) || []);
  const showRank = lumi.enabled() && toBool(await lumiSetting('show_rank', false));
  res.json(db.spots.map(s => {
    const v = db.votes[s.id] || [];
    const rv = db.reviews[s.id] || [];
    const avg = rv.length ? Math.round(rv.reduce((a, r) => a + r.rating, 0) / rv.length * 10) / 10 : 0;
    return { ...s, likes: v.length, liked: !!uid && v.includes(uid), fav: !!uid && myFavs.has(s.id), ratingAvg: avg, ratingCount: rv.length, ...(showRank ? { authorRank: rankOf(s.authorId) } : {}) };
  }));
});

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

app.post('/api/spots', needJson, need, limit(10, 3600e3), (req, res) => {
  const b = req.body || {};
  const spot = {
    id: crypto.randomBytes(8).toString('hex'),
    name: clean(b.name, 60), pref: clean(b.pref, 10), city: clean(b.city, 30),
    genre: clean(b.genre, 20), price: clean(b.price, 12),
    hours: String(b.hours ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, 400),
    phone: /^[0-9+\-()\s]{0,30}$/.test(String(b.phone ?? '').trim()) ? String(b.phone ?? '').trim() : '',
    comment: String(b.comment ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, 400),
    authorId: req.user.id, authorName: req.user.name, authorAvatar: req.user.avatar, createdAt: Date.now()
  };
  if (!spot.name || !spot.city || !spot.comment) return res.status(400).json({ error: '店名・市区町村・おすすめポイントは必須です' });
  if (!PREFS.includes(spot.pref)) return res.status(400).json({ error: '都道府県が不正です' });
  if (CITIES[spot.pref] && !CITIES[spot.pref].includes(spot.city)) return res.status(400).json({ error: '市区町村は一覧から選んでください（例：札幌市中央区）' });
  if (!GENRES.includes(spot.genre)) spot.genre = guessGenre({ name: spot.name, comment: spot.comment }) || 'その他';
  if (!PRICES.includes(spot.price)) spot.price = '';
  if (db.spots.length >= 20000) return res.status(507).json({ error: '保存上限に達しました' });
  const lat = Number(b.lat), lng = Number(b.lng);
  if (b.lat != null && b.lng != null && inJapan(lat, lng)) { spot.lat = +lat.toFixed(6); spot.lng = +lng.toFixed(6); spot.geo = 'user'; }
  spot.images = claimImages(b.images, req.user.id, req.user.admin, spot.id);
  db.spots.push(spot); save();
  notifyDiscord(spot).then(() => maybeGrant(req.user.id)).catch(() => {});
  res.status(201).json({ ...spot, likes: 0, liked: false });
  if (spot.lat == null) {
    locateSpot(spot).then(g => { if (g) { spot.lat = g.lat; spot.lng = g.lng; spot.geo = g.geo; spot.v = 2; save(); } });
  }
});

// Googleマップのリンク（短縮URL可）から、店名・位置・都道府県・市区町村を自動入力する
async function resolveGmapsUrl(input) {
  let url = String(input).trim();
  for (let i = 0; i < 5; i++) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    if (u.protocol !== 'https:' || !isAllowedHost(u.hostname)) return null;
    const parsed = parseGmapsUrl(url);
    if (parsed && (parsed.lat != null || parsed.address || (parsed.name && parsed.hint))) return { url, parsed };
    const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; gochi-meshi)', 'Accept-Language': 'ja' }, signal: AbortSignal.timeout(6000) }).catch(() => null);
    if (!r) return parsed ? { url, parsed } : null;
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url).toString(); continue; }
    return parsed ? { url, parsed } : null;
  }
  return null;
}
app.get('/api/place-info', need, limit(30, 600e3), async (req, res) => {
  const name = clean(req.query.name, 60), pref = clean(req.query.pref, 10), city = clean(req.query.city, 30);
  if (!name || !PREFS.includes(pref) || !city) return res.status(400).json({ error: '店名・都道府県・市区町村を入力してください' });
  const info = await placeInfo(name, pref, city);
  if (!info) return res.status(404).json({ error: '営業時間などの情報が見つかりませんでした。手入力してください。' });
  res.json(info);
});

app.get('/api/gmaps', need, limit(15, 600e3), async (req, res) => {
  const found = await resolveGmapsUrl(clean(req.query.url, 600));
  if (!found) return res.status(400).json({ error: 'Googleマップのリンクを読み取れませんでした。共有ボタンでコピーしたリンクを貼ってください。' });
  let { name, lat, lng, address, hint } = found.parsed;
  const out = { name, lat: null, lng: null, pref: '', city: '' };
  if (address) {
    // 住所の文字から都道府県・市区町村を決め、位置は住所→店名+地域→地域の順に探す
    const a = parseAddress(address, PREFS, CITIES);
    out.pref = a.pref; out.city = a.city;
    const g = a.pref && a.city ? await locateIn(a.pref, a.city, (() => { const v = addressVariants(address); return [...v.precise, name ? `${name} ${a.city}` : '', v.coarse].filter(Boolean); })()) : await geocode([address]);
    if (g) { out.lat = g.lat; out.lng = g.lng; out.approx = g.geo === 'city'; }
    if (!out.pref && out.lat == null) return res.status(404).json({ error: 'リンクから場所を特定できませんでした。' });
    return res.json(out);
  }
  if (lat == null && name && hint) {
    // 店IDのヒントの近く(±約8km)だけで店名を探す。見つからなければヒントの位置（目安）
    const d = 0.08;
    const r = await searchRaw({ q: name, viewbox: `${hint.lng - d},${hint.lat + d},${hint.lng + d},${hint.lat - d}`, bounded: '1' });
    if (r && inJapan(+r.lat, +r.lon)) { lat = +(+r.lat).toFixed(6); lng = +(+r.lon).toFixed(6); }
    else { lat = hint.lat; lng = hint.lng; out.approx = true; }
  }
  if (lat == null && name) { const g = await geocode([name]); if (g) { lat = g.lat; lng = g.lng; out.approx = true; } }
  if (lat == null) return res.status(404).json({ error: 'リンクから場所を特定できませんでした。' });
  out.lat = lat; out.lng = lng;
  const addr = await reverseGeocode(lat, lng);
  if (addr) {
    const pref = addr.province || addr.state || '';
    if (PREFS.includes(pref)) { out.pref = pref; out.city = pickCity(addr, CITIES[pref] || []); }
  }
  res.json(out);
});

app.get('/api/geocode', need, limit(20, 600e3), async (req, res) => {
  const q = clean(req.query.q, 100);
  if (!q) return res.status(400).json({ error: '検索ワードを入力してください' });
  const g = await geocode([q]);
  if (!g) return res.status(404).json({ error: '場所が見つかりませんでした' });
  res.json(g);
});

// 投稿の編集（投稿者か管理者）
app.patch('/api/spots/:id', needJson, need, limit(60, 3600e3), (req, res) => {
  const sp = db.spots.find(x => x.id === req.params.id);
  if (!sp) return res.status(404).json({ error: '見つかりません' });
  if (sp.authorId !== req.user.id && !req.user.admin) return res.status(403).json({ error: '編集できるのは投稿者か管理者のみです' });
  const b = req.body || {};
  const next = {
    name: clean(b.name, 60), pref: clean(b.pref, 10), city: clean(b.city, 30),
    genre: clean(b.genre, 20), price: clean(b.price, 12),
    hours: String(b.hours ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, 400),
    phone: /^[0-9+\-()\s]{0,30}$/.test(String(b.phone ?? '').trim()) ? String(b.phone ?? '').trim() : '',
    comment: String(b.comment ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, 400)
  };
  if (!next.name || !next.city || !next.comment) return res.status(400).json({ error: '店名・市区町村・おすすめポイントは必須です' });
  if (!PREFS.includes(next.pref)) return res.status(400).json({ error: '都道府県が不正です' });
  if (CITIES[next.pref] && !CITIES[next.pref].includes(next.city)) return res.status(400).json({ error: '市区町村は一覧から選んでください（例：札幌市中央区）' });
  if (!GENRES.includes(next.genre)) next.genre = guessGenre({ name: next.name, comment: next.comment }) || 'その他';
  if (!PRICES.includes(next.price)) next.price = '';
  const areaChanged = next.pref !== sp.pref || next.city !== sp.city, nameChanged = next.name !== sp.name;
  Object.assign(sp, next);
  if (Array.isArray(b.images)) {
    const prev = sp.images || [];
    sp.images = claimImages(b.images, req.user.id, req.user.admin, sp.id);
    releaseImages(prev.filter(x => !sp.images.includes(x)));
  }
  const lat = Number(b.lat), lng = Number(b.lng);
  let relocate = false;
  if (b.lat != null && b.lng != null && inJapan(lat, lng)) { sp.lat = +lat.toFixed(6); sp.lng = +lng.toFixed(6); sp.geo = 'user'; sp.v = 2; }
  else if (areaChanged || (nameChanged && sp.geo !== 'user')) relocate = true;
  save();
  res.json(sp);
  if (relocate) locateSpot(sp).then(g => { if (g) { sp.lat = g.lat; sp.lng = g.lng; sp.geo = g.geo; sp.v = 2; save(); } });
});

// 位置の修正（投稿者か管理者）
app.patch('/api/spots/:id/location', needJson, need, limit(60, 3600e3), (req, res) => {
  const sp = db.spots.find(x => x.id === req.params.id);
  if (!sp) return res.status(404).json({ error: '見つかりません' });
  if (sp.authorId !== req.user.id && !req.user.admin) return res.status(403).json({ error: '修正できるのは投稿者か管理者のみです' });
  const lat = Number(req.body && req.body.lat), lng = Number(req.body && req.body.lng);
  if (!inJapan(lat, lng)) return res.status(400).json({ error: '日本国内の位置を指定してください' });
  sp.lat = +lat.toFixed(6); sp.lng = +lng.toFixed(6); sp.geo = 'user'; sp.v = 2; save();
  res.json({ lat: sp.lat, lng: sp.lng, geo: sp.geo });
});

app.post('/api/spots/:id/like', needJson, need, limit(60, 600e3), (req, res) => {
  const id = req.params.id;
  if (!db.spots.some(s => s.id === id)) return res.status(404).json({ error: '見つかりません' });
  const v = db.votes[id] || (db.votes[id] = []);
  const i = v.indexOf(req.user.id);
  if (i >= 0) v.splice(i, 1); else v.push(req.user.id);
  save();
  res.json({ likes: v.length, liked: i < 0 });
});

app.delete('/api/spots/:id', need, (req, res) => {
  const i = db.spots.findIndex(s => s.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: '見つかりません' });
  if (db.spots[i].authorId !== req.user.id && !req.user.admin) return res.status(403).json({ error: '削除できるのは投稿者か管理者のみです' });
  releaseImages(db.spots[i].images);
  delete db.votes[req.params.id]; delete db.reviews[req.params.id];
  Object.keys(db.favs).forEach(u => { db.favs[u] = db.favs[u].filter(x => x !== req.params.id); if (!db.favs[u].length) delete db.favs[u]; });
  db.spots.splice(i, 1); save();
  res.json({ ok: true });
});

/* ---------- お気に入り（ログインしていれば誰でも。本人にだけ見える） ---------- */
const needLogin = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'ログインが必要です' }));
app.post('/api/spots/:id/fav', needJson, needLogin, limit(120, 600e3), (req, res) => {
  const id = req.params.id, uid = req.user.id;
  if (!db.spots.some(x => x.id === id)) return res.status(404).json({ error: '見つかりません' });
  const list = db.favs[uid] || (db.favs[uid] = []);
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
  else { if (list.length >= 500) return res.status(400).json({ error: 'お気に入りは500件までです' }); list.push(id); }
  if (!list.length) delete db.favs[uid];
  save();
  res.json({ fav: i < 0 });
});

/* ---------- 写真 ---------- */
// JPEGから位置情報などのメタデータ（EXIF/XMP: APP1、APP13、コメント）を取り除く。不正な構造ならnull
function stripJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const out = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) return null;
    let m = buf[i + 1];
    while (m === 0xff && i + 2 < buf.length) { i++; m = buf[i + 1]; }
    if (m === 0xda || m === 0xd9) { out.push(buf.subarray(i)); return Buffer.concat(out); }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { out.push(buf.subarray(i, i + 2)); i += 2; continue; }
    if (i + 3 >= buf.length) return null;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    if (!(m === 0xe1 || m === 0xed || m === 0xfe)) out.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}
const IMG_RE = /^[0-9a-f]{16}$/;
const imgPath = id => path.join(UPLOAD_DIR, id + '.jpg');
function releaseImages(ids) {
  (ids || []).forEach(id => { delete db.uploads[id]; fs.unlink(imgPath(id), () => {}); });
}
// 投稿に写真を紐づける。自分がアップロードした（管理者は他人のも可）、まだ他の投稿に使われていないものだけ
function claimImages(ids, uid, admin, spotId) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).filter(x => typeof x === 'string' && IMG_RE.test(x)))].slice(0, 3);
  const out = [];
  for (const id of list) {
    const u = db.uploads[id];
    if (u && (u.userId === uid || admin) && (!u.spotId || u.spotId === spotId)) { u.spotId = spotId; out.push(id); }
  }
  return out;
}
app.post('/api/uploads', need, limit(30, 3600e3), express.raw({ type: 'image/jpeg', limit: '2mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(415).json({ error: 'JPEG画像を送ってください' });
  const pending = Object.values(db.uploads).filter(u => u.userId === req.user.id && !u.spotId).length;
  if (pending >= 12) return res.status(429).json({ error: 'アップロード待ちの写真が多すぎます。投稿するか、しばらく待ってください' });
  const clean = stripJpeg(req.body);
  if (!clean) return res.status(400).json({ error: '画像を読み取れませんでした' });
  const id = crypto.randomBytes(8).toString('hex');
  fs.writeFile(imgPath(id), clean, err => {
    if (err) return res.status(500).json({ error: '保存できませんでした' });
    db.uploads[id] = { userId: req.user.id, createdAt: Date.now(), spotId: null }; save();
    res.status(201).json({ id });
  });
});
app.get('/img/:id', (req, res) => {
  if (!IMG_RE.test(req.params.id)) return res.status(404).end();
  res.sendFile(imgPath(req.params.id), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } }, err => { if (err && !res.headersSent) res.status(404).end(); });
});
// 投稿に紐づかないまま1時間たった写真は消す
setInterval(() => {
  const old = Object.entries(db.uploads).filter(([, u]) => !u.spotId && Date.now() - u.createdAt > 3600e3).map(([id]) => id);
  if (old.length) { releaseImages(old); save(); }
}, 600e3).unref();

/* ---------- 口コミ ---------- */
const pubReview = (r, uid) => ({ id: r.id, name: r.name, avatar: r.avatar, rating: r.rating, text: r.text, createdAt: r.createdAt, mine: !!uid && r.userId === uid });
app.get('/api/spots/:id/reviews', (req, res) => {
  if (!db.spots.some(x => x.id === req.params.id)) return res.status(404).json({ error: '見つかりません' });
  const uid = req.user && req.user.id;
  res.json((db.reviews[req.params.id] || []).slice().sort((a, b) => b.createdAt - a.createdAt).map(r => pubReview(r, uid)));
});
// 1人1店につき1件（再投稿で上書き）
app.post('/api/spots/:id/reviews', needJson, need, limit(20, 3600e3), (req, res) => {
  const id = req.params.id;
  if (!db.spots.some(x => x.id === id)) return res.status(404).json({ error: '見つかりません' });
  const rating = Math.round(Number(req.body && req.body.rating));
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: '星は1〜5で選んでください' });
  const text = String((req.body && req.body.text) ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, 300);
  const list = db.reviews[id] || (db.reviews[id] = []);
  const mine = list.find(r => r.userId === req.user.id);
  const base = { userId: req.user.id, name: req.user.name, avatar: req.user.avatar, rating, text, createdAt: Date.now() };
  if (mine) Object.assign(mine, base); else list.push({ id: crypto.randomBytes(6).toString('hex'), ...base });
  save();
  res.status(201).json({ ok: true });
  const spotOfReview = db.spots.find(x => x.id === id), rv = list.find(r => r.userId === req.user.id);
  if (spotOfReview && rv) notifyReview(spotOfReview, rv).catch(() => {});
});
app.delete('/api/spots/:id/reviews/:rid', need, (req, res) => {
  const list = db.reviews[req.params.id] || [];
  const i = list.findIndex(r => r.id === req.params.rid);
  if (i < 0) return res.status(404).json({ error: '見つかりません' });
  if (list[i].userId !== req.user.id && !req.user.admin) return res.status(403).json({ error: '削除できるのは投稿者か管理者のみです' });
  list.splice(i, 1); save();
  res.json({ ok: true });
});

/* ---------- Googleマイマップ用の書き出し（KML / CSV） ---------- */
function exportSpots(q) {
  return db.spots.filter(s => s.lat != null &&
    (!q.pref || s.pref === q.pref) && (!q.city || s.city === q.city || (q.city.endsWith('市') && s.city.startsWith(q.city))) && (!q.genre || s.genre === q.genre));
}
const xml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const ratingOf = id => { const rv = db.reviews[id] || []; return rv.length ? (rv.reduce((a, r) => a + r.rating, 0) / rv.length).toFixed(1) : ''; };
const gmapsLink = s => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(`${s.name} ${s.pref}${s.city}`);
app.get('/export.kml', (req, res) => {
  const rows = exportSpots(req.query), byGenre = {};
  rows.forEach(s => (byGenre[s.genre] = byGenre[s.genre] || []).push(s));
  const folders = Object.entries(byGenre).map(([g, list]) => `<Folder><name>${xml(g)}</name>` + list.map(s => {
    const r = ratingOf(s.id);
    const desc = `${s.pref} ${s.city}${s.price ? ' / ' + s.price : ''}${r ? ' / ★' + r : ''}\n${s.comment}\n${gmapsLink(s)}`;
    return `<Placemark><name>${xml(s.name)}</name><description>${xml(desc)}</description><Point><coordinates>${s.lng},${s.lat},0</coordinates></Point></Placemark>`;
  }).join('') + '</Folder>').join('');
  res.set({ 'Content-Type': 'application/vnd.google-earth.kml+xml; charset=utf-8', 'Content-Disposition': 'attachment; filename="gochi-meshi.kml"' });
  res.send(`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>ご当地めし帖</name>${folders}</Document></kml>`);
});
app.get('/export.csv', (req, res) => {
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const head = ['名前', '緯度', '経度', 'ジャンル', '都道府県', '市区町村', '予算', 'おすすめ', '評価', 'Googleマップ'];
  const lines = exportSpots(req.query).map(s => [s.name, s.lat, s.lng, s.genre, s.pref, s.city, s.price, s.comment, ratingOf(s.id), gmapsLink(s)].map(q).join(','));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="gochi-meshi.csv"' });
  res.send('\ufeff' + [head.map(q).join(','), ...lines].join('\r\n'));
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.use((req, res) => res.status(404).send('Not found'));

// 起動時に、位置が無い投稿と、旧方式で自動推定した投稿（範囲チェックなし）を順に補正する
(async () => {
  const todo = db.spots.filter(x => x.lat == null || (x.geo === 'auto' && x.v !== 2)).slice(0, 300);
  for (const sp of todo) { const g = await locateSpot(sp); if (g) { sp.lat = g.lat; sp.lng = g.lng; sp.geo = g.geo; sp.v = 2; save(); } }
})();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ご当地めし帖 起動: ポート ${PORT} / 公開URL ${PUBLIC_URL}`);
  console.log(`Discord リダイレクトURI: ${REDIRECT_URI}`);
  lumi.register();
  console.log('Lumi連携: ' + (lumi.enabled() ? '有効' : LUMI_URL ? '未登録（LUMI_CONNECT_TOKEN で初回登録）' : '無効'));
  console.log('Discord通知: ' + (relayReady ? '有効（BOT中継）' : botOk ? '有効（BOT経由）' : hookOk ? '有効（Webhook）' : '無効（DISCORD_CHANNEL_ID+DISCORD_BOT_TOKEN か DISCORD_WEBHOOK_URL を設定）'));
  if (!CLIENT_ID || !CLIENT_SECRET) console.warn('警告: DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET が未設定です（ログイン不可）');
});

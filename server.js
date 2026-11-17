'use strict';
const express = require('express');
const crypto = require('crypto');
const { parseGmapsUrl, parseAddress, pickCity, isAllowedHost } = require('./lib/gmaps');
const fs = require('fs');
const path = require('path');

/* ---------- 設定（環境変数） ---------- */
const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const GUILD_ID = process.env.DISCORD_GUILD_ID || '';          // 空なら Discord ログインできる人なら誰でも投稿可
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const SECURE = PUBLIC_URL.startsWith('https://');
const SESSION_DAYS = 14;

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- 保存（JSONファイル、原子的に書き込み） ---------- */
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { spots: [], votes: {} }; // votes: { spotId: [userId,...] }
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
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https://cdn.discordapp.com https://tile.openstreetmap.org data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
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
const spotQueries = s => [`${s.name} ${s.pref}${s.city}`, `${s.pref}${s.city}`];

/* ---------- API ---------- */
const PREFS = ["北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県","新潟県","富山県","石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県","三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県","鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県"];
const GENRES = ["ラーメン","寿司・海鮮","肉料理","定食・食堂","カレー","うどん・そば","郷土料理","カフェ・スイーツ","居酒屋","その他"];
const PRICES = ["", "〜1,000円","〜2,000円","〜3,000円","3,000円〜"];

let CITIES = {};
try { CITIES = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'cities.json'), 'utf8')); } catch (e) { console.warn('cities.json を読み込めませんでした（市区町村の検証を省略します）'); }

const need = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'ログインが必要です' });
  if (!req.user.member) return res.status(403).json({ error: 'このサーバーのメンバーのみ利用できます' });
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

app.get('/api/me', (req, res) => {
  const u = req.user;
  res.json({ loggedIn: !!u, user: u ? { id: u.id, name: u.name, avatar: u.avatar, member: u.member, admin: u.admin } : null, guildRestricted: !!GUILD_ID });
});

app.get('/api/spots', (req, res) => {
  const uid = req.user && req.user.id;
  res.json(db.spots.map(s => {
    const v = db.votes[s.id] || [];
    return { ...s, likes: v.length, liked: !!uid && v.includes(uid) };
  }));
});

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

app.post('/api/spots', needJson, need, limit(10, 3600e3), (req, res) => {
  const b = req.body || {};
  const spot = {
    id: crypto.randomBytes(8).toString('hex'),
    name: clean(b.name, 60), pref: clean(b.pref, 10), city: clean(b.city, 30),
    genre: clean(b.genre, 20), price: clean(b.price, 12),
    comment: String(b.comment ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, 400),
    authorId: req.user.id, authorName: req.user.name, authorAvatar: req.user.avatar, createdAt: Date.now()
  };
  if (!spot.name || !spot.city || !spot.comment) return res.status(400).json({ error: '店名・市区町村・おすすめポイントは必須です' });
  if (!PREFS.includes(spot.pref)) return res.status(400).json({ error: '都道府県が不正です' });
  if (CITIES[spot.pref] && !CITIES[spot.pref].includes(spot.city)) return res.status(400).json({ error: '市区町村は一覧から選んでください（例：札幌市中央区）' });
  if (!GENRES.includes(spot.genre)) spot.genre = 'その他';
  if (!PRICES.includes(spot.price)) spot.price = '';
  if (db.spots.length >= 20000) return res.status(507).json({ error: '保存上限に達しました' });
  const lat = Number(b.lat), lng = Number(b.lng);
  if (b.lat != null && b.lng != null && inJapan(lat, lng)) { spot.lat = +lat.toFixed(6); spot.lng = +lng.toFixed(6); spot.geo = 'user'; }
  db.spots.push(spot); save();
  res.status(201).json({ ...spot, likes: 0, liked: false });
  if (spot.lat == null) {
    geocode(spotQueries(spot)).then(g => { if (g) { spot.lat = g.lat; spot.lng = g.lng; spot.geo = 'auto'; save(); } });
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
    if (parsed && (parsed.lat != null || parsed.address)) return { url, parsed };
    const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; gochi-meshi)', 'Accept-Language': 'ja' }, signal: AbortSignal.timeout(6000) }).catch(() => null);
    if (!r) return parsed ? { url, parsed } : null;
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url).toString(); continue; }
    return parsed ? { url, parsed } : null;
  }
  return null;
}
app.get('/api/gmaps', need, limit(15, 600e3), async (req, res) => {
  const found = await resolveGmapsUrl(clean(req.query.url, 600));
  if (!found) return res.status(400).json({ error: 'Googleマップのリンクを読み取れませんでした。共有ボタンでコピーしたリンクを貼ってください。' });
  let { name, lat, lng, address } = found.parsed;
  const out = { name, lat: null, lng: null, pref: '', city: '' };
  if (address) {
    // 住所の文字から都道府県・市区町村を決め、位置は住所→店名+地域→地域の順に探す
    const a = parseAddress(address, PREFS, CITIES);
    out.pref = a.pref; out.city = a.city;
    const g = await geocode([address, name && a.pref ? `${name} ${a.pref}${a.city}` : '', a.pref ? `${a.pref}${a.city}` : ''].filter(Boolean));
    if (g) { out.lat = g.lat; out.lng = g.lng; }
    if (!out.pref && out.lat == null) return res.status(404).json({ error: 'リンクから場所を特定できませんでした。' });
    return res.json(out);
  }
  if (lat == null && name) { const g = await geocode([name]); if (g) { lat = g.lat; lng = g.lng; } }
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
  db.votes[db.spots[i].id] = undefined; delete db.votes[req.params.id];
  db.spots.splice(i, 1); save();
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.use((req, res) => res.status(404).send('Not found'));

// 起動時に、位置がまだ無い投稿を順に補完する
(async () => { for (const sp of db.spots.filter(x => x.lat == null).slice(0, 200)) { const g = await geocode(spotQueries(sp)); if (g) { sp.lat = g.lat; sp.lng = g.lng; sp.geo = 'auto'; save(); } } })();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ご当地めし帖 起動: ポート ${PORT} / 公開URL ${PUBLIC_URL}`);
  console.log(`Discord リダイレクトURI: ${REDIRECT_URI}`);
  if (!CLIENT_ID || !CLIENT_SECRET) console.warn('警告: DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET が未設定です（ログイン不可）');
});

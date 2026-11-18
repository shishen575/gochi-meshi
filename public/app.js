'use strict';
const REGIONS = {
  "北海道・東北":["北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県"],
  "関東":["茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県"],
  "中部":["新潟県","富山県","石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県"],
  "近畿":["三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県"],
  "中国・四国":["鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県"],
  "九州・沖縄":["福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県"]
};
const GENRES = ["ラーメン","寿司・海鮮","肉料理","定食・食堂","カレー","うどん・そば","郷土料理","カフェ・スイーツ","居酒屋","その他"];
const PRICES = ["〜1,000円","〜2,000円","〜3,000円","3,000円〜"];
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

const S = { region:"", pref:"", city:"", genre:"", q:"", sort:"likes", view:"list", locEdit:null, locPos:null, favOnly:false, gkey:null, gfail:false, open:new Set(), reviews:{}, cities:{}, spots:[], me:null, guildRestricted:false, loaded:false };
try { const f = JSON.parse(localStorage.getItem("gochi-filter")||"{}"); S.region=f.region||""; S.pref=f.pref||""; } catch(e){}
function saveFilter(){ try{ localStorage.setItem("gochi-filter", JSON.stringify({region:S.region,pref:S.pref})); }catch(e){} }

async function api(path, opts={}) {
  const r = await fetch(path, { credentials:"same-origin", headers:{"Content-Type":"application/json"}, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "エラーが発生しました");
  return data;
}
const canPost = () => !!(S.me && S.me.loggedIn && S.me.user && S.me.user.member);

// 政令指定都市（例：札幌市）を選んだら、配下の区（札幌市中央区…）もまとめて対象にする
const parentSet = () => S._parents || (S._parents = new Set(Object.values(S.cities).flat().filter(n => /市$/.test(n)).filter(n => Object.values(S.cities).some(l => l.some(w => w !== n && w.startsWith(n) && /区$/.test(w))))));
const isParentCity = name => parentSet().has(name);
// 市区町村の <option> を作る。政令指定都市は「札幌市」グループにまとめて一覧を短くする
function cityOptions(list, selected, label){
  const wardsOf = p => list.filter(n => n !== p && n.startsWith(p) && /区$/.test(n));
  const skip = new Set(); let html = "";
  list.forEach(n => {
    if (skip.has(n)) return;
    if (isParentCity(n)) {
      const ws = wardsOf(n); ws.forEach(w => skip.add(w));
      html += `<optgroup label="${esc(n)}"><option value="${esc(n)}" ${n===selected?"selected":""}>${esc(label?label(n,true):n+"（全区）")}</option>` +
        ws.map(w => `<option value="${esc(w)}" ${w===selected?"selected":""}>${esc(label?label(w):w)}</option>`).join("") + `</optgroup>`;
    } else html += `<option value="${esc(n)}" ${n===selected?"selected":""}>${esc(label?label(n):n)}</option>`;
  });
  return html;
}
const cityMatch = (spotCity, sel) => spotCity === sel || (isParentCity(sel) && spotCity.startsWith(sel));

function visibleSpots(ignoreCity){
  const q = S.q.trim().toLowerCase();
  const prefs = S.pref ? [S.pref] : S.region ? REGIONS[S.region] : null;
  return S.spots.filter(s =>
    (!prefs || prefs.includes(s.pref)) && (ignoreCity || !S.city || cityMatch(s.city, S.city)) &&
    (!S.genre || s.genre === S.genre) && (!S.favOnly || s.fav) &&
    (!q || (s.name+" "+s.comment+" "+s.city).toLowerCase().includes(q)));
}

function renderUser(){
  const el = $("userbar");
  if (!S.me) { el.innerHTML = ""; return; }
  if (!S.me.loggedIn) { el.innerHTML = `<a class="btn discord" href="/auth/login" style="text-decoration:none;display:inline-flex;align-items:center">Discordでログイン</a>`; return; }
  const u = S.me.user;
  el.innerHTML = `${u.avatar?`<img src="${esc(u.avatar)}" alt="">`:""}<span>${esc(u.name)}</span>
    ${u.member?`<button class="btn primary" id="openForm" type="button">飯を紹介する</button>`:""}
    <button class="btn small" id="logout" type="button">ログアウト</button>`;
}

function renderFilters(){
  $("regions").innerHTML = `<button class="chip" data-region="" aria-pressed="${!S.region && !S.pref}">全国<span class="n">${S.spots.length}</span></button>` + Object.keys(REGIONS).map(r => `<button class="chip" data-region="${esc(r)}" aria-pressed="${S.region===r}">${esc(r)}</button>`).join("");
  const list = S.region ? REGIONS[S.region] : Object.values(REGIONS).flat();
  $("prefHead").textContent = S.region ? `都道府県（${S.region}）` : "都道府県（全国）";
  const counts = {}; S.spots.forEach(s => counts[s.pref] = (counts[s.pref]||0)+1);
  $("prefs").innerHTML = list.map(p => `<button class="chip ${counts[p]?"has":""}" data-pref="${p}" aria-pressed="${S.pref===p}">${p}${counts[p]?`<span class="n">${counts[p]}</span>`:""}</button>`).join("");
  const posted = visibleSpots(true);
  const cnt = c => posted.filter(s => cityMatch(s.city, c)).length;
  const cities = S.pref && S.cities[S.pref] ? S.cities[S.pref]
    : [...new Set(posted.map(s => s.city).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"ja"));
  if (S.city && !cities.includes(S.city)) S.city = "";
  $("city").innerHTML = `<option value="">${S.pref ? `${S.pref}のすべての市区町村` : "すべての市区町村"}</option>` +
    cityOptions(cities, S.city, (c, all) => { const n = cnt(c); return (all ? c + "（全区）" : c) + (n ? `（${n}）` : ""); });
  const loggedIn = !!(S.me && S.me.loggedIn);
  $("favWrap").hidden = !loggedIn;
  if (!loggedIn) S.favOnly = false;
  $("favOnly").checked = S.favOnly;
  $("favCount").textContent = S.spots.filter(s => s.fav).length;
  $("genres").innerHTML = [""].concat(GENRES).map(g => `<button class="chip" data-genre="${esc(g)}" aria-pressed="${S.genre===g}">${g||"すべて"}</button>`).join("");
}

const stars = n => "★★★★★".slice(0, Math.round(n)) + "☆☆☆☆☆".slice(0, 5 - Math.round(n));
const gmapUrl = s => "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(`${s.name} ${s.pref}${s.city}`);
const routeUrl = s => "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(s.lat != null ? `${s.lat},${s.lng}` : `${s.name} ${s.pref}${s.city}`);
const fmtDate = t => new Date(t).toLocaleDateString("ja-JP");

function reviewPanel(s){
  const list = S.reviews[s.id];
  if (!list) return `<p class="msg">読み込み中…</p>`;
  const mine = list.find(r => r.mine);
  const admin = !!(S.me && S.me.user && S.me.user.admin);
  const items = list.length ? list.map(r => `<div class="rv"><div class="rv-h">${r.avatar?`<img src="${esc(r.avatar)}" alt="" width="20" height="20">`:""}<b>${esc(r.name)}</b>
      <span class="stars">${stars(r.rating)}</span><span class="place">${fmtDate(r.createdAt)}</span>
      ${(r.mine||admin)?`<button class="btn small" data-rvdel="${esc(s.id)}:${esc(r.id)}" type="button">削除</button>`:""}</div>
      ${r.text?`<p class="comment">${esc(r.text)}</p>`:""}</div>`).join("") : `<p class="msg">まだ口コミがありません。</p>`;
  const form = canPost() ? `<form class="rvform" data-spot="${esc(s.id)}">
      <div class="actions"><label class="msg" for="rt-${esc(s.id)}">${mine?"あなたの口コミを更新":"口コミを書く"}</label>
        <select class="input" id="rt-${esc(s.id)}" name="rating" style="width:auto">${[5,4,3,2,1].map(n=>`<option value="${n}" ${(mine?mine.rating:5)===n?"selected":""}>${"★".repeat(n)}${"☆".repeat(5-n)}</option>`).join("")}</select></div>
      <textarea class="input" name="text" maxlength="300" placeholder="食べたもの、よかった点など（任意・300字まで）" aria-label="口コミ本文">${mine?esc(mine.text):""}</textarea>
      <div class="actions"><button class="btn primary small" type="submit">${mine?"更新する":"投稿する"}</button><span class="msg"></span></div></form>`
    : `<p class="msg">${S.me && S.me.loggedIn ? "このサーバーのメンバーのみ口コミを書けます。" : "口コミを書くには、Discordでログインしてください。"}</p>`;
  return items + form;
}
async function loadReviews(id){
  try { S.reviews[id] = await api(`/api/spots/${id}/reviews`); } catch (e) { S.reviews[id] = []; }
  renderFeed();
}

// Googleマイマップ用の書き出しリンク（今の絞り込みを反映）
function renderExport(){
  const q = new URLSearchParams();
  if (S.pref) q.set("pref", S.pref);
  if (S.city) q.set("city", S.city);
  if (S.genre) q.set("genre", S.genre);
  const qs = q.toString() ? "?" + q : "";
  const n = visibleSpots().filter(s => s.lat != null).length;
  $("exportBody").innerHTML = `<p class="msg">今の絞り込み（位置のある${n}件）を、Googleマイマップに取り込める形式で書き出します。ジャンルごとにレイヤーが分かれます。</p>
    <div class="links"><a class="btn small primary" href="/export.kml${qs}">KMLをダウンロード（おすすめ）</a><a class="btn small" href="/export.csv${qs}">CSVをダウンロード</a></div>
    <ol class="msg"><li><a href="https://www.google.com/mymaps" target="_blank" rel="noopener noreferrer">Googleマイマップ</a>を開き、「新しい地図を作成」</li><li>「インポート」でダウンロードしたファイルを選ぶ</li><li>共有設定を「リンクを知っている全員」にすれば、みんなに見せられます</li></ol>`;
}

function renderFeed(){
  const rows = visibleSpots();
  rows.sort(S.sort === "new" ? (a,b)=>b.createdAt-a.createdAt : (a,b)=>b.likes-a.likes || b.createdAt-a.createdAt);
  $("title").textContent = S.favOnly ? "お気に入り" : [S.pref || S.region || "全国", S.city].filter(Boolean).join(" ") + "のおすすめ";
  $("count").textContent = S.loaded ? `${rows.length}件` : "";
  if (!rows.length) {
    $("feed").innerHTML = S.loaded ? `<div class="empty"><strong>${S.favOnly?"お気に入りはまだありません":"この条件の紹介はまだありません"}</strong>${S.favOnly?"カードの☆を押すと、ここにためておけます。":"あなたの地元のうまい店を、最初の一軒として紹介してみませんか。"}</div>` : "";
    return;
  }
  const uid = S.me && S.me.loggedIn ? S.me.user.id : null;
  const admin = !!(S.me && S.me.user && S.me.user.admin);
  $("feed").innerHTML = rows.map(s => {
    const map = gmapUrl(s), route = routeUrl(s), isOpen = S.open.has(s.id);
    return `<article class="card ${S.focus===s.id?"focus":""}" id="spot-${esc(s.id)}">
      <div class="card-top"><div><h3>${esc(s.name)}</h3><div class="place">${esc(s.pref)} ${esc(s.city)}</div></div>
        <span class="rowbtns"><button class="btn small favbtn" data-fav="${esc(s.id)}" aria-pressed="${!!s.fav}" ${S.me&&S.me.loggedIn?"":"disabled"} title="${S.me&&S.me.loggedIn?"お気に入り":"ログインするとお気に入りに入れられます"}" aria-label="お気に入り">${s.fav?"★":"☆"} <span class="fl">お気に入り</span></button>
        <button class="btn small like" data-like="${esc(s.id)}" aria-pressed="${s.liked}" ${canPost()?"":"disabled"} aria-label="いいね">♥ <span class="c">${s.likes}</span></button></span></div>
      <div class="tags"><span class="tag">${esc(s.genre)}</span>${s.price?`<span class="tag price">${esc(s.price)}</span>`:""}</div>
      <p class="comment">${esc(s.comment)}</p>
      ${s.hours||s.phone?`<details class="hours"><summary>営業時間・電話</summary>${s.hours?`<div class="hrs">${esc(s.hours)}</div>`:""}${s.phone?`<div class="hrs">☎ ${esc(s.phone)}</div>`:""}<div class="msg">変わることがあります。お出かけ前にGoogleマップで確認してください。</div></details>`:""}
      ${s.ratingCount?`<div class="rate" title="口コミ平均">${stars(s.ratingAvg)} <b>${s.ratingAvg.toFixed(1)}</b> <span class="place">（口コミ${s.ratingCount}件）</span></div>`:""}
      <div class="links"><a class="btn small" href="${map}" target="_blank" rel="noopener noreferrer">Googleマップで開く</a>
        <a class="btn small" href="${route}" target="_blank" rel="noopener noreferrer">ルート案内</a>
        ${(uid && s.authorId===uid)||admin?`<button class="btn small" data-loc="${esc(s.id)}" type="button">${S.locEdit===s.id?"位置の修正をやめる":"ピンの位置を直す"}</button>`:""}
        <button class="btn small" data-rv="${esc(s.id)}" aria-expanded="${isOpen}" type="button">口コミ${s.ratingCount?`（${s.ratingCount}）`:""}を${isOpen?"閉じる":"見る・書く"}</button></div>
      ${S.locEdit===s.id?`<div class="locedit"><p class="msg">地図をクリックして、店の場所にピンを動かしてください。</p><div id="loc-map" class="map mini"></div><div class="actions"><button class="btn primary small" data-locsave="${esc(s.id)}" type="button">この位置で保存</button><span class="msg" id="loc-msg"></span></div></div>`:""}
      ${isOpen?`<div class="reviews">${reviewPanel(s)}</div>`:""}
      <div class="card-foot"><span>紹介：${esc(s.authorName)}</span>
        <span class="acts">
        ${(uid && s.authorId===uid)||admin?`<button class="btn small" data-del="${esc(s.id)}" type="button">削除</button>`:""}</span></div>
    </article>`;
  }).join("");
  mountLocEditor();
}
let map = null, layer = null, lastKey = "";
const pinIcon = (cls) => L.divIcon({ className:"", html:`<div class="pin ${cls||""}"></div>`, iconSize:[26,26], iconAnchor:[13,32], popupAnchor:[0,-30] });
function baseMap(el, opts){
  const m = L.map(el, opts).setView([36.5,138.2], 5);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom:19, referrerPolicy:"origin", attribution:"© OpenStreetMap contributors" }).addTo(m);
  return m;
}
function popupHtml(s){
  return `<h3>${esc(s.name)}</h3><p class="pp">${esc(s.pref)} ${esc(s.city)} ・ ${esc(s.genre)}${s.price?" ・ "+esc(s.price):""}</p><p>${esc(s.comment.length>120?s.comment.slice(0,120)+"…":s.comment)}</p><p>${s.ratingCount?`<b>${stars(s.ratingAvg)} ${s.ratingAvg.toFixed(1)}</b>（${s.ratingCount}件） ・ `:""}♥ ${s.likes}</p>${s.geo==="city"?`<p class="pp">※位置は市区町村の中心（目安）です</p>`:""}<p><a href="${gmapUrl(s)}" target="_blank" rel="noopener noreferrer">Googleマップで開く</a> ・ <a href="${routeUrl(s)}" target="_blank" rel="noopener noreferrer">ルート案内</a></p>`;
}
function mapCount(rows, pts){
  const pending = rows.length - pts;
  $("count").textContent = S.loaded ? `${rows.length}件` + (pending ? `（位置取得中 ${pending}件）` : "") : "";
}

/* --- Googleマップ版（GOOGLE_MAPS_KEY 設定時）。投稿が増えると自動でピンが増える --- */
let gmap = null, gmarkers = [], ginfo = null, gReady = null;
function loadGoogle(key){
  if (gReady) return gReady;
  gReady = new Promise((resolve, reject) => {
    window.__gmReady = resolve;
    window.gm_authFailure = () => { S.gfail = true; gmap = null; $("map").innerHTML = ""; renderMap(); };
    const sc = document.createElement("script");
    sc.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=__gmReady&language=ja&region=JP`;
    sc.async = true; sc.onerror = () => reject(new Error("load"));
    document.head.appendChild(sc);
  });
  return gReady;
}
function renderGoogleMap(){
  if (!gmap) {
    gmap = new google.maps.Map($("map"), { center:{ lat:36.5, lng:138.2 }, zoom:5, mapTypeControl:false, streetViewControl:false, fullscreenControl:true });
    ginfo = new google.maps.InfoWindow();
  }
  gmarkers.forEach(m => m.setMap(null)); gmarkers = [];
  const rows = visibleSpots(), bounds = new google.maps.LatLngBounds(); let n = 0;
  rows.forEach(s => {
    if (s.lat == null) return;
    const m = new google.maps.Marker({ position:{ lat:s.lat, lng:s.lng }, map:gmap, title:s.name });
    m.addListener("click", () => { const d = document.createElement("div"); d.className = "gpop"; d.innerHTML = popupHtml(s); ginfo.setContent(d); ginfo.open({ map:gmap, anchor:m }); });
    gmarkers.push(m); bounds.extend(m.getPosition()); n++;
  });
  const key = gmarkers.map(m => m.getPosition().toUrlValue()).join("|");
  if (key !== lastKey) {
    lastKey = key;
    if (n) { gmap.fitBounds(bounds, 48); google.maps.event.addListenerOnce(gmap, "idle", () => { if (gmap.getZoom() > 15) gmap.setZoom(15); }); }
    else { gmap.setCenter({ lat:36.5, lng:138.2 }); gmap.setZoom(5); }
  }
  mapCount(rows, n);
}

function renderMap(){
  if (S.view !== "map") return;
  if (S.gkey && !S.gfail) {
    loadGoogle(S.gkey).then(() => { if (!S.gfail && S.view === "map") renderGoogleMap(); }).catch(() => { S.gfail = true; renderMap(); });
    return;
  }
  if (typeof L === "undefined") return;
  if (!map) { $("map").innerHTML = ""; map = baseMap("map"); layer = L.layerGroup().addTo(map); }
  map.invalidateSize();
  layer.clearLayers();
  const rows = visibleSpots(), pts = [];
  rows.forEach(s => {
    if (s.lat == null) return;
    L.marker([s.lat, s.lng], { icon: pinIcon() }).bindPopup(popupHtml(s), { maxWidth:260 }).addTo(layer);
    pts.push([s.lat, s.lng]);
  });
  const key = pts.map(p => p.join(",")).join("|");
  if (key !== lastKey) {
    lastKey = key;
    if (pts.length) map.fitBounds(pts, { padding:[40,40], maxZoom:14 });
    else map.setView([36.5,138.2], 5);
  }
  mapCount(rows, pts.length);
}
function applyView(){
  $("map").hidden = S.view !== "map"; $("feed").hidden = S.view === "map";
  document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === S.view)));
  renderMap();
}
let locMap = null, locPin = null;
function mountLocEditor(){
  if (locMap) { locMap.remove(); locMap = null; locPin = null; }
  if (!S.locEdit || !$("loc-map") || typeof L === "undefined") return;
  const sp = S.spots.find(x => x.id === S.locEdit); if (!sp) return;
  locMap = baseMap("loc-map");
  const has = sp.lat != null;
  if (has) { locPin = L.marker([sp.lat, sp.lng], { icon: pinIcon("sel") }).addTo(locMap); locMap.setView([sp.lat, sp.lng], 16); }
  S.locPos = has ? { lat:sp.lat, lng:sp.lng } : null;
  locMap.on("click", ev => {
    S.locPos = { lat:ev.latlng.lat, lng:ev.latlng.lng };
    if (locPin) locPin.setLatLng(ev.latlng); else locPin = L.marker(ev.latlng, { icon: pinIcon("sel") }).addTo(locMap);
  });
}
function render(){ renderUser(); renderFilters(); renderFeed(); renderMap(); renderExport(); }

function openForm(){
  const prefOpts = `<option value="">選んでください</option>` + Object.entries(REGIONS).map(([r,ps]) =>
    `<optgroup label="${esc(r)}">${ps.map(p=>`<option ${p===S.pref?"selected":""}>${p}</option>`).join("")}</optgroup>`).join("");
  $("formSlot").innerHTML = `<form class="form" id="form">
    <h2 style="font-size:18px">飯を紹介する</h2>
    <div class="field"><label for="f-gm">Googleマップのリンクから自動入力（任意）</label>
      <div class="actions"><input class="input" id="f-gm" type="url" inputmode="url" placeholder="https://maps.app.goo.gl/…" style="flex:1;min-width:220px"><button class="btn" id="f-gmgo" type="button">自動入力</button></div>
      <span class="msg" id="f-gmmsg">Googleマップアプリで店を開き、共有 → リンクをコピー、で貼れます。店名・場所・市区町村が入ります。</span></div>
    <div class="row">
      <div class="field"><label for="f-name">店名・料理名（必須）</label><input class="input" id="f-name" required maxlength="60"></div>
      <div class="field"><label for="f-genre">ジャンル</label><select class="input" id="f-genre">${GENRES.map(g=>`<option>${g}</option>`).join("")}</select></div>
    </div>
    <div class="row">
      <div class="field"><label for="f-pref">都道府県（必須）</label><select class="input" id="f-pref" required>${prefOpts}</select></div>
      <div class="field"><label for="f-city">市区町村（必須）</label><select class="input" id="f-city" required></select></div>
      <div class="field"><label for="f-price">予算</label><select class="input" id="f-price"><option value="">指定なし</option>${PRICES.map(p=>`<option>${p}</option>`).join("")}</select></div>
    </div>
    <div class="field"><label for="f-hours">営業時間・電話（任意）：変わることがあるので、お出かけ前にGoogleマップで確認してもらえます</label>
      <div class="actions"><button class="btn small" id="f-hoursgo" type="button">営業時間を自動入力</button><span class="msg" id="f-hmsg"></span></div>
      <textarea class="input" id="f-hours" maxlength="400" style="min-height:72px" placeholder="例：月〜金 11:00-21:00 / 土日 11:00-20:00 / 水曜定休"></textarea>
      <input class="input" id="f-phone" type="tel" maxlength="30" placeholder="電話番号（任意）" aria-label="電話番号"></div>
    <div class="field"><label>場所（任意）：地図をクリックしてピンを置けます。置かない場合は店名と地域から自動で探します。</label>
      <div class="actions"><button class="btn small" id="f-find" type="button">店名と地域から場所を検索</button><span class="msg" id="f-geomsg"></span></div>
      <div id="f-map" class="map mini"></div></div>
    <div class="field"><label for="f-comment">おすすめポイント（必須）</label><textarea class="input" id="f-comment" required maxlength="400" placeholder="何がうまいか、頼むべき一品、混み具合など"></textarea></div>
    <div class="actions"><button class="btn primary" type="submit">投稿する</button><button class="btn" id="cancel" type="button">やめる</button><span class="msg" id="fmsg"></span></div>
  </form>`;
  const fillCities = (keep) => { const p = $("f-pref").value, sel = $("f-city");
    sel.disabled = !p;
    sel.innerHTML = `<option value="">${p ? "市区町村を選んでください" : "先に都道府県を選んでください"}</option>` + cityOptions(S.cities[p] || [], keep || "", (c, all) => all ? c + "（全区）" : c); };
  $("f-pref").addEventListener("change", () => fillCities()); fillCities();
  let fmap = null, fpin = null, pos = null;
  const closeForm = () => { if (fmap) { fmap.remove(); fmap = null; } $("formSlot").innerHTML = ""; };
  const setPin = (lat, lng, zoom) => {
    pos = { lat, lng };
    if (fpin) fpin.setLatLng([lat, lng]); else fpin = L.marker([lat, lng], { icon: pinIcon("sel") }).addTo(fmap);
    if (zoom) fmap.setView([lat, lng], zoom);
  };
  if (typeof L !== "undefined") {
    fmap = baseMap("f-map");
    fmap.on("click", ev => setPin(ev.latlng.lat, ev.latlng.lng));
  } else $("f-map").hidden = true;
  $("f-find").onclick = async () => {
    const m = $("f-geomsg"); m.className = "msg";
    const area = ($("f-pref").value || "") + $("f-city").value.trim();
    if (!area) { m.className = "msg err"; m.textContent = "都道府県と市区町村を入力してください"; return; }
    m.textContent = "検索中…";
    try {
      let g;
      try { g = await api("/api/geocode?q=" + encodeURIComponent($("f-name").value.trim() + " " + area)); }
      catch (e) { g = await api("/api/geocode?q=" + encodeURIComponent(area)); }
      if (fmap) setPin(g.lat, g.lng, 16);
      m.textContent = "見つかりました。ずれていたら地図をクリックして直せます。";
    } catch (err) { m.className = "msg err"; m.textContent = err.message; }
  };
  $("f-gmgo").onclick = async () => {
    const m = $("f-gmmsg"), link = $("f-gm").value.trim();
    m.className = "msg";
    if (!link) { m.className = "msg err"; m.textContent = "リンクを貼ってください"; return; }
    $("f-gmgo").disabled = true; m.textContent = "読み取り中…";
    try {
      const g = await api("/api/gmaps?url=" + encodeURIComponent(link));
      if (g.name && !$("f-name").value.trim()) $("f-name").value = g.name;
      if (g.pref) { $("f-pref").value = g.pref; fillCities(); }
      if (g.city) $("f-city").value = g.city;
      if (g.lat != null) { if (fmap) setPin(g.lat, g.lng, 16); else pos = { lat: g.lat, lng: g.lng }; }
      m.textContent = g.city ? "入力しました。内容を確認して投稿してください。" : "場所は入力しました。市区町村は候補から選んでください。";
      if (g.approx) m.textContent += "（位置は市区町村の中心です。地図をクリックして店の場所に直せます）";
      if (!g.name) m.textContent += "（店名は手入力してください）";
      autoHours(true);
    } catch (err) { m.className = "msg err"; m.textContent = err.message; }
    $("f-gmgo").disabled = false;
  };
  const autoHours = async (quiet) => {
    const m = $("f-hmsg"), name = $("f-name").value.trim(), pref = $("f-pref").value, city = $("f-city").value;
    if (!name || !pref || !city) { if (!quiet) { m.className = "msg err"; m.textContent = "店名・都道府県・市区町村を先に入力してください"; } return; }
    m.className = "msg"; m.textContent = "探しています…"; $("f-hoursgo").disabled = true;
    try {
      const r = await api(`/api/place-info?name=${encodeURIComponent(name)}&pref=${encodeURIComponent(pref)}&city=${encodeURIComponent(city)}`);
      if (r.hours && !$("f-hours").value.trim()) $("f-hours").value = r.hours;
      if (r.phone && !$("f-phone").value.trim()) $("f-phone").value = r.phone;
      m.textContent = (r.source === "google" ? "Googleの情報を入れました。" : "OpenStreetMapの情報を入れました。") + "内容を確認してください。";
    } catch (err) { m.className = "msg"; m.textContent = quiet ? "" : err.message; }
    $("f-hoursgo").disabled = false;
  };
  $("f-hoursgo").onclick = () => autoHours(false);
  $("cancel").onclick = closeForm;
  $("form").addEventListener("submit", async e => {
    e.preventDefault();
    const btn = e.submitter; if (btn) btn.disabled = true;
    const pc = $("f-pref").value, cc = $("f-city").value.trim();
    if (S.cities[pc] && !S.cities[pc].includes(cc)) { if (btn) btn.disabled = false; const m=$("fmsg"); m.className="msg err"; m.textContent="市区町村は候補から選んでください（例：札幌市中央区）"; return; }
    const data = { name:$("f-name").value, genre:$("f-genre").value, pref:$("f-pref").value, city:$("f-city").value, price:$("f-price").value, comment:$("f-comment").value, hours:$("f-hours").value, phone:$("f-phone").value };
    if (pos) { data.lat = pos.lat; data.lng = pos.lng; }
    try {
      const spot = await api("/api/spots", { method:"POST", body:JSON.stringify(data) });
      S.spots.push(spot); S.pref = spot.pref;
      S.region = Object.keys(REGIONS).find(r => REGIONS[r].includes(spot.pref)); S.city=""; S.genre=""; S.q=""; $("q").value="";
      saveFilter(); closeForm(); render(); $("status").textContent = "投稿しました。ありがとうございます。";
      if (spot.lat == null) [5000, 12000].forEach(ms => setTimeout(refreshSpots, ms));
    } catch (err) { if (btn) btn.disabled = false; const m=$("fmsg"); m.className="msg err"; m.textContent=err.message; }
  });
  $("f-name").focus();
}

document.addEventListener("click", async e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.loc) { S.locEdit = S.locEdit === t.dataset.loc ? null : t.dataset.loc; return renderFeed(); }
  if (t.dataset.locsave) {
    const m = $("loc-msg"); if (!S.locPos) { m.className = "msg err"; m.textContent = "地図をクリックして位置を決めてください"; return; }
    t.disabled = true;
    try {
      const r = await api(`/api/spots/${t.dataset.locsave}/location`, { method:"PATCH", body:JSON.stringify(S.locPos) });
      const sp = S.spots.find(x => x.id === t.dataset.locsave); if (sp) Object.assign(sp, r);
      S.locEdit = null; S._spotsKey = JSON.stringify(S.spots); render(); $("status").textContent = "ピンの位置を直しました。";
    } catch (err) { t.disabled = false; m.className = "msg err"; m.textContent = err.message; }
    return;
  }
  if (t.dataset.fav) {
    const sp = S.spots.find(x => x.id === t.dataset.fav); if (!sp) return;
    t.disabled = true;
    try { const r = await api(`/api/spots/${sp.id}/fav`, { method:"POST", body:"{}" }); sp.fav = r.fav; S._spotsKey = JSON.stringify(S.spots); render(); }
    catch (err) { $("status").textContent = err.message; t.disabled = false; }
    return;
  }
  if (t.dataset.rv) {
    const id = t.dataset.rv;
    if (S.open.has(id)) { S.open.delete(id); return renderFeed(); }
    S.open.add(id); renderFeed(); return loadReviews(id);
  }
  if (t.dataset.rvdel) {
    const [sid, rid] = t.dataset.rvdel.split(":");
    try { await api(`/api/spots/${sid}/reviews/${rid}`, { method:"DELETE" }); await Promise.all([loadReviews(sid), refreshSpots()]); } catch (err) { $("status").textContent = err.message; }
    return;
  }
  if (t.dataset.view) { S.view = t.dataset.view; return applyView(); }
  if (t.id === "openForm") return openForm();
  if (t.id === "logout") { await api("/auth/logout", { method:"POST", body:"{}" }); S.me = { loggedIn:false }; return render(); }
  if (t.dataset.region !== undefined) { S.region = S.region === t.dataset.region ? "" : t.dataset.region; S.pref=""; S.city=""; saveFilter(); return render(); }
  if (t.dataset.pref !== undefined) {
    S.pref = S.pref === t.dataset.pref ? "" : t.dataset.pref;
    if (S.pref) S.region = Object.keys(REGIONS).find(r => REGIONS[r].includes(S.pref));
    S.city=""; saveFilter(); return render();
  }
  if (t.dataset.genre !== undefined) { S.genre = t.dataset.genre; return render(); }
  if (t.dataset.like) {
    t.disabled = true;
    try { const r = await api(`/api/spots/${t.dataset.like}/like`, { method:"POST", body:"{}" });
      const s = S.spots.find(x => x.id === t.dataset.like); if (s) { s.likes = r.likes; s.liked = r.liked; } renderFeed();
    } catch (err) { $("status").textContent = err.message; t.disabled = false; }
    return;
  }
  if (t.dataset.del) {
    if (t.dataset.armed !== "1") { t.dataset.armed="1"; t.textContent="本当に削除"; setTimeout(()=>{ t.dataset.armed=""; t.textContent="削除"; }, 3000); return; }
    try { await api(`/api/spots/${t.dataset.del}`, { method:"DELETE" }); S.spots = S.spots.filter(s => s.id !== t.dataset.del); render(); }
    catch (err) { $("status").textContent = err.message; }
  }
});
document.addEventListener("submit", async e => {
  const f = e.target.closest(".rvform"); if (!f) return;
  e.preventDefault();
  const id = f.dataset.spot, msg = f.querySelector(".msg:last-child"), btn = f.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    await api(`/api/spots/${id}/reviews`, { method:"POST", body:JSON.stringify({ rating:Number(f.rating.value), text:f.text.value }) });
    await Promise.all([loadReviews(id), refreshSpots()]);
  } catch (err) { btn.disabled = false; msg.className = "msg err"; msg.textContent = err.message; }
});
$("favOnly").addEventListener("change", e => { S.favOnly = e.target.checked; render(); });
$("q").addEventListener("input", e => { S.q = e.target.value; render(); });
$("city").addEventListener("change", e => { S.city = e.target.value; renderFeed(); });
$("sort").addEventListener("change", e => { S.sort = e.target.value; renderFeed(); });

async function refreshSpots(force){
  try {
    const next = await api("/api/spots"), key = JSON.stringify(next);
    if (!force && key === S._spotsKey) return;
    S._spotsKey = key;
    // 口コミやフォームを入力中は、作業を壊さないよう描画を見送る
    const ae = document.activeElement;
    if (!force && ((ae && ae.closest && ae.closest(".reviews, .form")) || S.locEdit)) { S.spots = next; return; }
    S.spots = next; render();
  } catch (e) {}
}
// 他の人の投稿も、開いたままで自動的にピンとして増える
setInterval(() => { if (!document.hidden && S.loaded) refreshSpots(); }, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.loaded) refreshSpots(); });

(async () => {
  render();
  $("status").textContent = "読み込み中…";
  try {
    const [me, spots, cities, cfg] = await Promise.all([api("/api/me"), api("/api/spots"), fetch("/cities.json").then(r => r.json()).catch(() => ({})), api("/api/config").catch(() => ({}))]);
    S.cities = cities; S.gkey = cfg.googleMapsKey || null; S._spotsKey = JSON.stringify(spots);
    S.me = me; S.spots = spots; S.guildRestricted = me.guildRestricted;
    $("status").textContent = "";
    if (me.loggedIn && !me.user.member) $("status").textContent = "このサーバーのメンバーではないため、閲覧のみ可能です。";
  } catch (err) { $("status").textContent = "データを読み込めませんでした。"; }
  S.loaded = true;
  // 通知のリンク（/?s=店ID）から来たら、その店に移動して目立たせる
  const sid = new URLSearchParams(location.search).get("s"), target = sid && S.spots.find(x => x.id === sid);
  if (target) { S.pref = target.pref; S.region = Object.keys(REGIONS).find(r => REGIONS[r].includes(target.pref)) || ""; S.focus = target.id; }
  render();
  if (target) { const el = $("spot-" + target.id); if (el) el.scrollIntoView({ block:"center" }); }
})();

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

const S = { region:"", pref:"", city:"", genre:"", q:"", sort:"likes", view:"list", cities:{}, spots:[], me:null, guildRestricted:false, loaded:false };
try { const f = JSON.parse(localStorage.getItem("gochi-filter")||"{}"); S.region=f.region||""; S.pref=f.pref||""; } catch(e){}
function saveFilter(){ try{ localStorage.setItem("gochi-filter", JSON.stringify({region:S.region,pref:S.pref})); }catch(e){} }

async function api(path, opts={}) {
  const r = await fetch(path, { credentials:"same-origin", headers:{"Content-Type":"application/json"}, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "エラーが発生しました");
  return data;
}
const canPost = () => S.me && S.me.member;

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
    (!S.genre || s.genre === S.genre) &&
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
  $("regions").innerHTML = Object.keys(REGIONS).map(r => `<button class="chip" data-region="${esc(r)}" aria-pressed="${S.region===r}">${esc(r)}</button>`).join("");
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
  $("genres").innerHTML = [""].concat(GENRES).map(g => `<button class="chip" data-genre="${esc(g)}" aria-pressed="${S.genre===g}">${g||"すべて"}</button>`).join("");
}

function renderFeed(){
  const rows = visibleSpots();
  rows.sort(S.sort === "new" ? (a,b)=>b.createdAt-a.createdAt : (a,b)=>b.likes-a.likes || b.createdAt-a.createdAt);
  $("title").textContent = [S.pref || S.region || "全国", S.city].filter(Boolean).join(" ") + "のおすすめ";
  $("count").textContent = S.loaded ? `${rows.length}件` : "";
  if (!rows.length) {
    $("feed").innerHTML = S.loaded ? `<div class="empty"><strong>この条件の紹介はまだありません</strong>あなたの地元のうまい店を、最初の一軒として紹介してみませんか。</div>` : "";
    return;
  }
  const uid = S.me && S.me.loggedIn ? S.me.user.id : null;
  const admin = !!(S.me && S.me.user && S.me.user.admin);
  $("feed").innerHTML = rows.map(s => {
    const map = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(`${s.name} ${s.pref}${s.city}`);
    return `<article class="card">
      <div class="card-top"><div><h3>${esc(s.name)}</h3><div class="place">${esc(s.pref)} ${esc(s.city)}</div></div>
        <button class="btn small like" data-like="${esc(s.id)}" aria-pressed="${s.liked}" ${canPost()?"":"disabled"} aria-label="いいね">♥ <span class="c">${s.likes}</span></button></div>
      <div class="tags"><span class="tag">${esc(s.genre)}</span>${s.price?`<span class="tag price">${esc(s.price)}</span>`:""}</div>
      <p class="comment">${esc(s.comment)}</p>
      <div class="card-foot"><span>紹介：${esc(s.authorName)}</span>
        <span class="acts"><a href="${map}" target="_blank" rel="noopener noreferrer">地図で見る</a>
        ${(uid && s.authorId===uid)||admin?`<button class="btn small" data-del="${esc(s.id)}" type="button">削除</button>`:""}</span></div>
    </article>`;
  }).join("");
}
let map = null, layer = null, lastKey = "";
const pinIcon = (cls) => L.divIcon({ className:"", html:`<div class="pin ${cls||""}"></div>`, iconSize:[26,26], iconAnchor:[13,32], popupAnchor:[0,-30] });
function baseMap(el, opts){
  const m = L.map(el, opts).setView([36.5,138.2], 5);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom:19, attribution:"© OpenStreetMap contributors" }).addTo(m);
  return m;
}
function renderMap(){
  if (S.view !== "map" || typeof L === "undefined") return;
  if (!map) { map = baseMap("map"); layer = L.layerGroup().addTo(map); }
  map.invalidateSize();
  layer.clearLayers();
  const rows = visibleSpots(), pts = [];
  rows.forEach(s => {
    if (s.lat == null) return;
    const g = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(`${s.name} ${s.pref}${s.city}`);
    const html = `<h3>${esc(s.name)}</h3><p class="pp">${esc(s.pref)} ${esc(s.city)} ・ ${esc(s.genre)}${s.price?" ・ "+esc(s.price):""}</p><p>${esc(s.comment.length>120?s.comment.slice(0,120)+"…":s.comment)}</p><p>♥ ${s.likes} ・ <a href="${g}" target="_blank" rel="noopener noreferrer">Googleマップで開く</a></p>`;
    L.marker([s.lat, s.lng], { icon: pinIcon() }).bindPopup(html, { maxWidth:260 }).addTo(layer);
    pts.push([s.lat, s.lng]);
  });
  const key = pts.map(p => p.join(",")).join("|");
  if (key !== lastKey) {
    lastKey = key;
    if (pts.length) map.fitBounds(pts, { padding:[40,40], maxZoom:14 });
    else map.setView([36.5,138.2], 5);
  }
  const pending = rows.length - pts.length;
  $("count").textContent = S.loaded ? `${rows.length}件` + (pending ? `（位置取得中 ${pending}件）` : "") : "";
}
function applyView(){
  $("map").hidden = S.view !== "map"; $("feed").hidden = S.view === "map";
  document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === S.view)));
  renderMap();
}
function render(){ renderUser(); renderFilters(); renderFeed(); renderMap(); }

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
      if (fmap) setPin(g.lat, g.lng, 16);
      else pos = { lat: g.lat, lng: g.lng };
      m.textContent = g.city ? "入力しました。内容を確認して投稿してください。" : "場所は入力しました。市区町村は候補から選んでください。";
      if (!g.name) m.textContent += "（店名は手入力してください）";
    } catch (err) { m.className = "msg err"; m.textContent = err.message; }
    $("f-gmgo").disabled = false;
  };
  $("cancel").onclick = closeForm;
  $("form").addEventListener("submit", async e => {
    e.preventDefault();
    const btn = e.submitter; if (btn) btn.disabled = true;
    const pc = $("f-pref").value, cc = $("f-city").value.trim();
    if (S.cities[pc] && !S.cities[pc].includes(cc)) { if (btn) btn.disabled = false; const m=$("fmsg"); m.className="msg err"; m.textContent="市区町村は候補から選んでください（例：札幌市中央区）"; return; }
    const data = { name:$("f-name").value, genre:$("f-genre").value, pref:$("f-pref").value, city:$("f-city").value, price:$("f-price").value, comment:$("f-comment").value };
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
$("q").addEventListener("input", e => { S.q = e.target.value; render(); });
$("city").addEventListener("change", e => { S.city = e.target.value; renderFeed(); });
$("sort").addEventListener("change", e => { S.sort = e.target.value; renderFeed(); });

async function refreshSpots(){ try { S.spots = await api("/api/spots"); render(); } catch (e) {} }

(async () => {
  render();
  $("status").textContent = "読み込み中…";
  try {
    const [me, spots, cities] = await Promise.all([api("/api/me"), api("/api/spots"), fetch("/cities.json").then(r => r.json()).catch(() => ({}))]);
    S.cities = cities;
    S.me = me; S.spots = spots; S.guildRestricted = me.guildRestricted;
    $("status").textContent = "";
    if (me.loggedIn && !me.user.member) $("status").textContent = "このサーバーのメンバーではないため、閲覧のみ可能です。";
  } catch (err) { $("status").textContent = "データを読み込めませんでした。"; }
  S.loaded = true; render();
})();

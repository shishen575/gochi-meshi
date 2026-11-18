'use strict';
// Lumi（Discord BOT）との連携クライアント。トークンを持たず、署名つきの内部APIだけを呼ぶ。
// 流れ: ①管理者が /integration create で接続用トークンを発行 → ②初回起動時に /internal/register で登録し、
//       返ってきた integrationId と secret を data/lumi.json に保存 → ③以降は署名つきで呼び出す。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function createLumi({ baseUrl, dataDir, connectToken, manifest, log = console }) {
  const file = path.join(dataDir, 'lumi.json');
  let cred = null;
  try { cred = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  // LUMI_URL に /internal/register まで貼られても動くよう、アドレス（https://ホスト名）だけを使う
  let base = String(baseUrl || '').trim();
  try { base = new URL(base).origin; } catch (e) { base = base.replace(/\/+$/, ''); }
  const baseOk = /^https:\/\//.test(base) || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(base);
  const enabled = () => baseOk && !!(cred && cred.integrationId && cred.secret);

  // 同じトークンで失敗したら、再起動のたびに再送しない（トークンは1回しか使えないため、ログも紛らわしくなる）
  const failFile = path.join(dataDir, 'lumi-failed.txt');
  const tokenHash = connectToken ? crypto.createHash('sha256').update(connectToken).digest('hex') : '';
  async function register() {
    if (enabled() || !baseOk || !connectToken) return enabled();
    try { if (fs.readFileSync(failFile, 'utf8').trim() === tokenHash) { log.warn('Lumi連携: このトークンは登録に失敗済みです（再送しません）。Lumiで /integration create を実行し、新しいトークンを LUMI_CONNECT_TOKEN に入れて再起動してください'); return false; } } catch (e) {}
    try {
      const r = await fetch(base + '/internal/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: connectToken, manifest }), signal: AbortSignal.timeout(10000)
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.integrationId || !j.secret) {
        const reasons = {
          invalid_token: 'トークンが見つかりません（貼り間違い・欠け・別の連携のトークン）。/integration create で新しく発行してください',
          token_used: 'このトークンは使用済みです。/integration create で新しく発行してください',
          token_expired: 'このトークンは期限切れ（15分）です。/integration create で新しく発行し、すぐ貼って再起動してください',
          bad_manifest: 'Lumiが manifest を受け付けませんでした（サイト側の不具合の可能性）',
          unauthorized: 'Lumiが古い版か、登録の入口に届いていません（リダイレクトでPOSTがGETになった等）。LUMI_URL が https か確認してください'
        };
        const why = reasons[j.error]
          || (r.status === 429 ? '短時間に登録しすぎです。1分ほど待ってください'
            : r.status === 401 || r.status === 403 ? 'トークンが無効・期限切れ・使用済みです。/integration create で新しく発行し、15分以内に貼って1回だけ再起動してください'
            : r.status === 404 ? 'LUMI_URL のアドレスが違うか、Lumi側に /internal/register がありません' : '');
        log.warn('Lumi連携の登録に失敗:', r.status, j.error || '', why);
        // 診断用: トークンが途中で欠けたり、余計な文字が付いていないかを確認できる（中身は出さない）
        log.warn(`Lumi連携の診断: 送信先=${base}/internal/register / トークン長=${connectToken.length} / 先頭=${connectToken.slice(0, 5)} / 末尾=${connectToken.slice(-2)} / 引用符や空白=${/["'\s]/.test(connectToken) ? 'あり' : 'なし'} / 応答=${JSON.stringify(j).slice(0, 200)}`);
        if (r.status === 401 || r.status === 403) { try { fs.writeFileSync(failFile, tokenHash, { mode: 0o600 }); } catch (e) {} }
        return false;
      }
      cred = { integrationId: j.integrationId, secret: j.secret, registeredAt: Date.now() };
      fs.writeFileSync(file, JSON.stringify(cred), { mode: 0o600 });
      log.log('Lumi連携: 登録しました（' + j.integrationId + '）。Lumiのダッシュボードで機能をオンにし、チャンネル・ロールを選んでください');
      if (Array.isArray(j.settings)) log.log('Lumi連携: 受け付けた設定 ' + j.settings.length + '件 (' + j.settings.join(', ') + ')');
      if (j.ignored && (Array.isArray(j.ignored) ? j.ignored.length : Object.keys(j.ignored).length)) log.warn('Lumi連携: Lumiが捨てた項目があります:', JSON.stringify(j.ignored).slice(0, 400));
      return true;
    } catch (e) { log.warn('Lumi連携の登録に失敗:', e.message); return false; }
  }

  // 管理者が機能をオンにするまで 403 が返る。そのあいだ 5分は同じ種類の呼び出しを控える
  const blocked = new Map();
  async function call(method, p, bodyObj) {
    if (!enabled()) return { ok: false, status: 0 };
    const key = p.split('/').slice(0, 3).join('/');
    if ((blocked.get(key) || 0) > Date.now()) return { ok: false, status: 403, blocked: true };
    const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const ts = String(Date.now());
    const sig = crypto.createHmac('sha256', cred.secret).update(ts + '.' + body).digest('hex');
    try {
      const r = await fetch(base + p, {
        method, signal: AbortSignal.timeout(8000), body: body || undefined,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-Integration-Id': cred.integrationId, 'X-Timestamp': ts, 'X-Signature': sig }
      });
      let data = null; try { data = await r.json(); } catch (e) {}
      if (r.status === 403) blocked.set(key, Date.now() + 300000);
      return { ok: r.ok, status: r.status, data };
    } catch (e) { return { ok: false, status: 0, error: e.message }; }
  }
  return { register, call, enabled };
}
module.exports = { createLumi };

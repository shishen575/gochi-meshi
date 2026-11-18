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
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const baseOk = /^https:\/\//.test(base) || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(base);
  const enabled = () => baseOk && !!(cred && cred.integrationId && cred.secret);

  async function register() {
    if (enabled() || !baseOk || !connectToken) return enabled();
    try {
      const r = await fetch(base + '/internal/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: connectToken, manifest }), signal: AbortSignal.timeout(10000)
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.integrationId || !j.secret) { log.warn('Lumi連携の登録に失敗:', r.status, j.error || '（接続用トークンは15分で失効します。/integration create で再発行してください）'); return false; }
      cred = { integrationId: j.integrationId, secret: j.secret, registeredAt: Date.now() };
      fs.writeFileSync(file, JSON.stringify(cred), { mode: 0o600 });
      log.log('Lumi連携: 登録しました（' + j.integrationId + '）。Lumiのダッシュボードで機能をオンにし、チャンネル・ロールを選んでください');
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

// ご当地めし帖 → Lumi 経由の通知を受け取る口（Lumi側のコードに貼り付ける）
// Lumi の BOT トークンはご当地めし帖に渡さず、Lumi が自分で指定チャンネルへ投稿する。
//
// 前提: Lumi が Node.js (Express + discord.js) で動いていて、`app`（Express）と `client`（discord.js の Client）がある。
// Lumi の環境変数に追加:
//   MESHI_RELAY_SECRET  = 長いランダム文字列（ご当地めし帖の LUMI_RELAY_SECRET と同じ値）
//   MESHI_CHANNEL_ID    = 通知先チャンネルのID（宛先はここで固定。リクエストでは指定させない）
const crypto = require('crypto');
const seen = new Map(); // 同じ署名の再送（リプレイ）を弾く

app.post('/internal/meshi-notify', express.raw({ type: 'application/json', limit: '32kb' }), async (req, res) => {
  const secret = process.env.MESHI_RELAY_SECRET, channelId = process.env.MESHI_CHANNEL_ID;
  if (!secret || !channelId) return res.status(503).end();

  const ts = Number(req.get('X-Timestamp')), sig = String(req.get('X-Signature') || '');
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 60_000) return res.status(401).end();
  const expect = crypto.createHmac('sha256', secret).update(ts + '.').update(req.body).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).end();

  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 120_000) seen.delete(k);
  if (seen.has(sig)) return res.status(409).end();
  seen.set(sig, now);

  let body;
  try { body = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).end(); }
  if (!body || typeof body.embed !== 'object') return res.status(400).end();

  try {
    const ch = await client.channels.fetch(channelId);
    await ch.send({ embeds: [body.embed], allowedMentions: { parse: [] } });
    res.json({ ok: true });
  } catch (e) {
    console.error('meshi relay failed', e.message);
    res.status(502).end();
  }
});

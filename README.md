# ご当地めし帖

都道府県・市区町村ごとのおすすめ飯を Discord サーバーのみんなで共有するサイト。
Discord OAuth2 ログイン、Node.js (Express)、JSON 保存、Cloudflare Tunnel 内蔵。

## Pterodactyl での公開手順
1. Cloudflare Zero Trust > Networks > Tunnels でトンネルを作成し、トークンを控える。
   Public Hostname に公開ドメイン（例 meshi.example.com）を追加し、
   Service を `http://localhost:<サーバーのポート>` にする（ポートはパネルのAllocation）。
2. Discord Developer Portal でアプリを作成し、OAuth2 > Redirects に
   `https://<公開ドメイン>/auth/callback` を追加。Client ID / Secret を控える。
3. パネル管理 > Nests でEggをインポート: `pterodactyl/egg-gochi-meshi.json`
4. このEggでサーバーを作成し、Startup の変数（公開URL、トンネルトークン、Discord Client ID/Secret、
   任意でサーバーID・管理者ID）を入力して起動。

## 更新
`python3 tools/build_egg.py` でEggを再生成。既存サーバーはファイルマネージャーで
`server.js` と `public/` を差し替えて再起動（`data/` は保持されます）。

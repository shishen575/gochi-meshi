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
`python3 tools/build_egg.py` でEggを再生成（インストール時にGitHubから取得するため、コード変更だけならEgg再生成は不要）。既存サーバーはファイルマネージャーで
`server.js` と `public/` を差し替えて再起動（`data/` は保持されます）。

## 地図をGoogleマップにする（任意）
Google Cloud で「Maps JavaScript API」を有効にし、APIキーを作成（HTTPリファラ制限に公開URLを登録）。
パネルの変数 `GOOGLE_MAPS_KEY` に入れて再起動すると、地図がGoogleマップになります。
投稿のたびにピンが自動で増え、開いたままの画面も30秒ごとに更新されます。未設定ならOpenStreetMapです。

## Discord通知・メンバー確認など（Lumi連携）
パネルの変数 `LUMI_URL` と `LUMI_CONNECT_TOKEN`（Lumiの `/integration create` で発行）を入れて起動すると、Lumiに登録されます。
通知・メンバー限定・活動ランク表示・投稿数でのロール付与は、Lumiのダッシュボードで設定します。

Eggの画面に出る変数は8個だけです。Google APIキーと自動更新の設定は「詳細設定」として隠してあります
（パネル管理画面のサーバーの Startup で表示・変更できます）。
Lumiを使わない場合の通知用に、サーバーは環境変数 `DISCORD_WEBHOOK_URL`（Webhook）、`DISCORD_BOT_TOKEN` + `DISCORD_CHANNEL_ID`、
`LUMI_RELAY_URL` + `LUMI_RELAY_SECRET` にも対応しています（Eggには出していません）。

# Lumi 側のお願い：地域ごとの通知先とスレッド（`notify` の拡張）

ご当地めし帖から、お店の通知を地域ごとのチャンネルやスレッドに分けて投稿したいです。
チャンネルのIDはサイトに渡らない（`GET /internal/settings` は ID を返さない）ので、宛先の決定は Lumi 側でお願いします。

## 1. `POST /internal/meshi-notify` のリクエスト（追加された項目）
```json
{
  "embed": { "title": "店名", "image": { "url": "https://…/img/…" }, "…": "…" },
  "route": "kanto",
  "thread": "東京都"
}
```
- `route`（任意）… 地域キー。次の6つのどれか: `hokkaido_tohoku` / `kanto` / `chubu` / `kinki` / `chugoku_shikoku` / `kyushu_okinawa`
- `thread`（任意）… 都道府県名（例: 東京都）
- `embed.image.url`（任意）… お店の写真。そのまま埋め込みに載せてください

## 2. 宛先の決め方
1. `route` があり、manifest の設定 `channel_<route>`（type: `channel`）に管理者がチャンネルを選んでいれば、そのチャンネルに送る
2. 選ばれていなければ、これまでの通常の通知先に送る
3. 設定 `thread_by_pref`（type: `toggle`）がオンで、`thread` があれば、選ばれたチャンネルの中で、`thread` と同じ名前のスレッドを探して投稿する。なければ公開スレッドを作る（フォーラムチャンネルなら、その名前の投稿を作る）
4. スレッドが作れない・見つからないときは、スレッドなしでチャンネルに送る（通知を落とさない）

## 3. 互換性
- `route` と `thread` に対応していない古い Lumi が `400` を返した場合、ご当地めし帖は1時間のあいだ、これらを付けずに送り直します。通知は失われません。
- manifest の `settings` に追加した項目（登録時に送ります）:
  `thread_by_pref`（toggle）、`channel_hokkaido_tohoku`、`channel_kanto`、`channel_chubu`、`channel_kinki`、`channel_chugoku_shikoku`、`channel_kyushu_okinawa`（いずれも channel）
- すでに登録済みの連携は、manifest を更新できないので、新しい設定を使うには、連携を削除して作り直してください。

## 4. セキュリティ
- 宛先は、必ず管理者が選んだチャンネルの中だけにしてください（リクエストの文字列からチャンネルIDを作らない）
- `thread` は、スレッド名として使う前に、長さ（100文字以内）と、改行・メンションを取り除いてください
- メンションは飛ばさない（`allowedMentions: { parse: [] }`）

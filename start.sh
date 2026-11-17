#!/bin/bash
# Pterodactyl 用の起動スクリプト
#  - Cloudflare Tunnel とアプリを同時に起動
#  - AUTO_UPDATE=1 のとき、GitHub の最新コードを起動時と一定間隔で取り込み、変更があればアプリを再起動
# 注意: 更新でこのファイル自体が置き換わるため、全体を関数にして最終行で一括実行する

main() {
  cd /home/container || exit 1

  local REPO="${GIT_REPO:-https://github.com/shishen575/gochi-meshi.git}"
  local BRANCH="${GIT_BRANCH:-main}"
  local INTERVAL=$(( ${UPDATE_INTERVAL:-5} * 60 ))
  [ "$INTERVAL" -lt 60 ] && INTERVAL=60

  # 最新コードを取り込む。変更があれば 0、無ければ 1、失敗なら 2 を返す
  update_code() {
    [ "${AUTO_UPDATE:-1}" = "1" ] || return 1
    if [ ! -d .git ]; then git init -q && git remote add origin "$REPO" 2>/dev/null; fi
    git remote set-url origin "$REPO" 2>/dev/null
    git fetch -q --depth 1 origin "$BRANCH" 2>/dev/null || { echo "[update] 取得に失敗しました（次回に再試行）"; return 2; }
    local LOCAL REMOTE OLDPKG
    LOCAL=$(git rev-parse -q --verify HEAD 2>/dev/null)
    REMOTE=$(git rev-parse FETCH_HEAD)
    [ "$LOCAL" = "$REMOTE" ] && return 1
    OLDPKG=$(md5sum package.json 2>/dev/null)
    git reset -q --hard FETCH_HEAD || return 2
    git checkout -q -B "$BRANCH" 2>/dev/null
    chmod +x start.sh 2>/dev/null
    [ "$OLDPKG" != "$(md5sum package.json 2>/dev/null)" ] && rm -rf node_modules
    echo "[update] ${REMOTE:0:7} に更新しました"
    return 0
  }

  install_deps() {
    if [ ! -d node_modules ]; then
      echo "[setup] 依存パッケージをインストールします..."
      npm install --omit=dev --no-audit --no-fund || { echo "npm install に失敗しました"; return 1; }
    fi
  }

  update_code; install_deps || exit 1

  local CF="" NODE=""
  if [ -n "$CF_TUNNEL_TOKEN" ] && [ -x ./cloudflared ]; then
    echo "[tunnel] Cloudflare Tunnel を起動します"
    ./cloudflared tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN" &
    CF=$!
  else
    echo "[tunnel] CF_TUNNEL_TOKEN が未設定のためトンネルは起動しません"
  fi

  local STOP=0
  trap 'STOP=1; kill $NODE $CF 2>/dev/null' TERM INT

  while [ "$STOP" = "0" ]; do
    node server.js &
    NODE=$!
    local WAITED=0 RESTART=0
    while [ "$STOP" = "0" ] && kill -0 "$NODE" 2>/dev/null; do
      sleep 5; WAITED=$((WAITED + 5))
      if [ "$WAITED" -ge "$INTERVAL" ]; then
        WAITED=0
        if update_code; then
          install_deps && RESTART=1
          [ "$RESTART" = "1" ] && { echo "[update] アプリを再起動します"; kill "$NODE" 2>/dev/null; wait "$NODE" 2>/dev/null; break; }
        fi
      fi
    done
    if [ "$RESTART" = "0" ]; then
      wait "$NODE" 2>/dev/null; local CODE=$?
      [ -n "$CF" ] && kill "$CF" 2>/dev/null
      return $CODE
    fi
  done
  [ -n "$CF" ] && kill "$CF" 2>/dev/null
  return 0
}

main "$@"; exit $?

# orangebot

合議制のポータルと Discord ボット。

メンバーの追加、除名、パスワードの再発行といった重要な操作を、**全体の過半数の承認**がないと
実行できないようにしている。最初はメンバーが 1 人しかいないので、その 1 人が単独で決められる。
人が増えると必要な票数も自動的に増える。

| 有権者 | 1   | 2   | 3   | 4   | 5   | 6   | 7   | 10  |
| ------ | --- | --- | --- | --- | --- | --- | --- | --- |
| 必要数 | 1   | 2   | 2   | 3   | 3   | 4   | 4   | 6   |

必要数は `floor(有権者数 / 2) + 1`。母数は投票した人ではなく有権者全員なので、棄権は事実上の反対として働く。

---

## 必要なもの

| もの             | 版        | 備考                              |
| ---------------- | --------- | --------------------------------- |
| Node.js          | 22.9 以上 | `--env-file-if-exists` を使うため |
| TLS 証明書       | 必須      | certbot で取る。本番は https のみ |
| oag-node         | 任意      | ウォレット機能を使う場合のみ      |

ネイティブモジュール（better-sqlite3、argon2）はビルド済みバイナリが配られるので、
コンパイラの用意は要らない。

---

## セットアップ

```bash
git clone <このリポジトリ>
cd orangebot
npm install
cp .env.example .env
```

### 秘密情報を作る

`.env` の `SESSION_SECRET` と `APP_ENCRYPTION_KEY` は本番では必須。未設定のまま
`NODE_ENV=production` で起動すると停止する。

```bash
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('APP_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
```

`APP_ENCRYPTION_KEY` は TOTP の秘密鍵を暗号化している。**これを失うと全員の二要素認証が読めなくなる。**
バックアップは DB とは別の場所に置く。

### 環境変数

| 変数                          | 必須     | 説明                                                        |
| ----------------------------- | -------- | ----------------------------------------------------------- |
| `WEB_ORIGIN`                  | 本番のみ | 公開 URL。本番では https 必須                               |
| `PORT`                        |          | 待ち受けポート。証明書があれば既定 443、無ければ 3000        |
| `TLS_CERT_PATH`               | 本番のみ | 証明書の鎖。Let's Encrypt なら `fullchain.pem`               |
| `TLS_KEY_PATH`                | 本番のみ | 秘密鍵。Let's Encrypt なら `privkey.pem`                     |
| `SESSION_SECRET`              | 本番のみ | セッション用                                                |
| `APP_ENCRYPTION_KEY`          | 本番のみ | base64 で 32 バイト                                         |
| `DATABASE_PATH`               |          | 既定 `data/orangebot.db`                                    |
| `RP_ID`                       |          | パスキーの Relying Party ID。既定は `WEB_ORIGIN` のホスト名 |
| `RP_NAME`                     |          | 認証器に表示される名前                                      |
| `DISCORD_TOKEN`               |          | 未設定なら bot を起動せず Web だけで動く                    |
| `DISCORD_CLIENT_ID`           |          | `DISCORD_TOKEN` と対で設定する                              |
| `DISCORD_GUILD_ID`            |          | 所属サーバーの ID                                           |
| `DISCORD_PROPOSAL_CHANNEL_ID` |          | 提案の通知先チャンネル                                      |
| `OAG_COOKIE_PATH`             |          | 指定したときだけ OAG ノードに繋ぐ                           |
| `OAG_NETWORK`                 |          | `mainnet` / `testnet` / `regtest`。既定 `mainnet`           |
| `OAG_RPC_URL`                 |          | 既定はネットワークごとのループバック                        |
| `LOG_LEVEL`                   |          | `debug` / `info` / `warn` / `error`。既定 `info`            |

---

## 最初のログイン

初回だけ CLI で最初の 1 人を作る。作られるのは**登録待ちの器と登録リンクだけ**で、
パスワードも二要素認証も本人がブラウザで設定する。初回専用の抜け道を作らないためにこうしている。

```bash
npm run bootstrap -- \
  --discord-id=1529717434259345489 \
  --username=kazuhiro-tokumoto \
  --display-name="徳本 和寛"
```

登録リンクが一度だけ表示される。ブラウザで開いて、次の順に設定する。

1. パスワード（12 文字以上）
2. TOTP を認証アプリに登録し、符号を 1 回入力して確認
3. リカバリコードを 10 個受け取る。**必ず印刷するか別の場所に控える**
4. 必要ならパスキーを登録する

ここまで済んで初めて有効なメンバーになり、提案と投票ができる。

リンクを渡しそこねた場合はもう一度 `npm run bootstrap` を実行する。ただしメンバーが既にいると
断られるので、その場合は DB を消してやり直すことになる。

### メンバー ID は Discord のユーザー ID

メンバー ID には Discord のユーザー ID をそのまま使う。取得するには Discord の設定で
開発者モードを有効にし、ユーザーを右クリックして「ユーザー ID をコピー」を選ぶ。

### 二要素認証は必須

パスワードだけではログインできない。組み合わせは 2 通り。

- パスワード + TOTP
- パスキー単独（生体認証や PIN を伴うものは、それ自体が所持と知識の 2 要素を満たす）

### パスキー

設定画面から、いま使っている端末を登録する。登録には `residentKey` と `userVerification` を
どちらも required で要求するので、鍵は端末の中に住み、使うたびに生体認証か PIN を求められる。
これで所持と本人確認の 2 要素が 1 回の操作で揃うため、ログイン画面の「パスキーでログイン」からは
利用者名もパスワードも聞かずに入れる。

鍵は RP ID、つまりドメインに結び付く。**ドメインを変えると登録済みのパスキーは全て使えなくなる**ので、
その場合は各自で登録し直す。端末を失くしたときは、他の手段でログインして設定画面から消す。

### パスワードを忘れたとき

本人以外の有権者による過半数の承認が要る。申請するとその場で引換券が渡され、
承認が集まった時点で新しいパスワードを設定できるようになる。

メンバーが本人 1 人しかいない場合は承認できる人がいないので、**リカバリコードが唯一の復旧手段**になる。

---

## 動かす

### 開発

```bash
npm run dev          # http://localhost:3000
```

パスキーは https か localhost でしか動かない。開発では localhost が例外的に許される。

### 本番

```bash
npm run check        # 型チェック + Lint + テスト
npm run build        # dist/ に JavaScript を出力
npm start
```

`npm start` は `TLS_CERT_PATH` と `TLS_KEY_PATH` を読んで、node 自身が https を終端する。
証明書の指定が無いまま `NODE_ENV=production` で起動しようとすると、その場で止まる。
平文の口は開かないので、リバースプロキシは要らない。

---

## TLS 証明書の置き場所

node が直接 https を話す。証明書の場所を `.env` に書くだけでよい。

```dotenv
WEB_ORIGIN=https://mail.shudo-physics.com
PORT=443
TLS_CERT_PATH=/etc/letsencrypt/live/mail.shudo-physics.com/fullchain.pem
TLS_KEY_PATH=/etc/letsencrypt/live/mail.shudo-physics.com/privkey.pem
```

`WEB_ORIGIN` は実際の URL とぴったり合わせる。**ここがずれるとパスキーが動かない。**
RP ID はドメインに固定されるので、あとからドメインを変えると登録済みのパスキーは全部使えなくなる。

### 証明書を取る

`mail.shudo-physics.com` の証明書は既に certbot で取ってある。取り直す場合は次の通り。

```bash
sudo certbot certonly --standalone -d mail.shudo-physics.com
```

ポータルは 80 番を使わないので、`certbot renew` は standalone のまま通る。
その代わり `http://` では何も応答しない。人に渡す URL には必ず `https://` を付ける。

### 更新への追随

certbot が置き換えた証明書は、1 時間ごとの見張りが中身の変化に気付いて読み直す。
待ち受けは切らないので、そのとき開いている接続も落ちない。**再起動も deploy-hook も要らない。**

### 権限

443 番に繋ぐのと `/etc/letsencrypt` を読むのに、それぞれ許しが要る。root で走らせずに済ませる。

```bash
# 秘密鍵を読めるようにする
sudo groupadd -f ssl-cert
sudo chgrp -R ssl-cert /etc/letsencrypt/live /etc/letsencrypt/archive
sudo chmod -R g+rX /etc/letsencrypt/live /etc/letsencrypt/archive
sudo usermod -aG ssl-cert tokumoto
```

443 番への待ち受けは、下の systemd の `AmbientCapabilities` で許す。

### systemd

```ini
[Unit]
Description=orangebot
After=network.target

[Service]
Type=simple
User=tokumoto
# 秘密鍵を読むために要る
SupplementaryGroups=ssl-cert
WorkingDirectory=/home/tokumoto/orangebot
ExecStart=/usr/bin/node --env-file-if-exists=.env dist/index.js
# root にならずに 443 番で待ち受けるため
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

---

## Discord

bot は**送るだけ**で、受け取らない。interaction も message も購読していないので、
Discord に何を書いても議事は動かない。投票も設定もポータルでしか行えない。

| 送り先       | 流れるもの                                             |
| ------------ | ------------------------------------------------------ |
| チャンネル   | 提案の開始と決着（可決・否決・期限切れ）               |
| DM           | 登録リンク、パスワード再発行の引換リンク               |

審議中の提案には投票の場所（`WEB_ORIGIN/proposals`）を必ず添える。1 票ごとには流さず、
提案が立ったときと決着したときだけ流す。

### アカウントの紐付け

メンバー ID は Discord のユーザー ID そのものなので、紐付けの手続きは要らない。
DM はその ID に直接送る。相手が DM を閉じている場合や、bot と同じサーバーにいない場合は送れない。

送れなかったときは、登録リンクは発行した画面にそのまま表示される。手で渡せばよい。
パスワード再発行の引換リンクは、DM で送れた場合は画面に出さない。
この画面は誰でも開けるので、申し込んだ人が本人とは限らないため。

### 要る権限

bot をサーバーに入れ、通知先のチャンネルで「メッセージを送信」を許す。
`DISCORD_PROPOSAL_CHANNEL_ID` を設定しなければチャンネルへの通知は止まり、DM だけが残る。
`DISCORD_TOKEN` ごと設定しなければ bot は起動せず、リンクは画面に出るだけになる。

---

## OAG ノードとの関係

ウォレット機能は同じ機械で動く oag-node に JSON-RPC で繋ぐ。

```
RPC      127.0.0.1:9445   （mainnet。testnet は 19445、regtest は 29445）
認証     HTTP Basic。合言葉は起動のたびに作り直され oag-data/.cookie に入る
```

**RPC 側には TLS も証明書も無い。** 守りは「ループバックにしか開かない」ことに置かれている
（[SPEC §15.1](https://github.com/Kazuhiro-Tokumoto/Orange/blob/main/docs/SPEC.md)）。
ポータルとノードを同居させればこの前提を崩さずに済む。別の機械に置く場合は、
RPC を公開するのではなく SSH トンネルか WireGuard で繋ぐ。

金額は 16 桁小数の u128 で、10 進文字列としてやり取りされる。JavaScript の数値では壊れるので
BigInt で扱う。最小単位のまま持ち回り、画面に出すときだけ 16 桁の小数に直す。

### 設定

`OAG_COOKIE_PATH` を指定したときだけノードに繋ぐ。指定が無ければウォレットの画面は出るが残高は出ない。
ノードが落ちていてもポータルは動き続ける。

```dotenv
OAG_COOKIE_PATH=/home/tokumoto/orange/oag-data/.cookie
OAG_NETWORK=mainnet
# 既定はネットワークごとのループバック。ふつう指定しない。
OAG_RPC_URL=
```

合言葉はノードが起動するたびに書き直されるので、呼び出しのたびに読み直す。
ノードを再起動してもポータルの再起動は要らない。

### いま出来ること

| こと                 | 状態                                                     |
| -------------------- | -------------------------------------------------------- |
| 残高を見る           | できる。`scanutxos` で受取とお釣りの住所をまとめて数える |
| 受取住所を配る       | できる。配るたびに番号が進み、住所は使い回さない         |
| 送る                 | **まだできない。** 取引の組み立てと署名がこれから        |

`scanutxos` は索引を使わない総なめなので、ノード側で打ち切られることがある。
そのとき応答に `truncated: true` が付く。**打ち切られた合計は残高として出さない。**
実際より少ない数を残高として見せる方が、出せないと言うより危ないため。

### 鍵の導出

BIP39 の 12 語から BIP32 で BIP44 の経路をたどる。実装は [src/wallet/](src/wallet/)。

```
m / 44' / <coin_type>' / <account>' / <change> / <index>

mainnet  coin_type = 1033
testnet  coin_type = 1
regtest  coin_type = 1
```

アドレスは bech32m で、payload は BIP340 の x-only 公開鍵 32 バイトそのもの。ハッシュは挟まない。
仕様 §6.5 の検証済みベクタ 3 組すべてと一致することをテストで確かめている。

> **mainnet の 1033 はまだ確定していない。**
> SLIP-0044 への申請（`satoshilabs/slips` のプルリクエスト #2061）が審査待ちで、別の番号で受理されると
> 同じ控えから導かれる mainnet の鍵はすべて変わる。利用者から見れば資金が消えたのと区別がつかない。
> **番号が確定するまで mainnet のアドレスへ資金を入れてはならない。**
> 確定したら `src/wallet/seed.ts` の `MAINNET_COIN_TYPE_PENDING` を `false` にする。

### 控えの保管

控えはパスフレーズで包んでから保存する。Argon2id で鍵を伸ばし、ChaCha20-Poly1305 で包む。

| 項目             | 値                            |
| ---------------- | ----------------------------- |
| KDF              | Argon2id m=128 MiB, t=12, p=1 |
| 所要時間         | 約 1 秒                       |
| 暗号             | ChaCha20-Poly1305             |
| 最短パスフレーズ | 8 文字                        |

パラメータは暗号文のヘッダに入り、そのまま認証付きデータになる。書き換えれば復号が通らない。
機械が変わったら `calibrate()` で測り直せる。パスフレーズ違いと改竄は区別せずに断る。区別できると、
書き換えたものを投げ込んで反応を見る手掛かりになるため。

---

## スクリプト

| コマンド                          | 内容                                |
| --------------------------------- | ----------------------------------- |
| `npm run dev`                     | 変更を監視しながら起動              |
| `npm run build`                   | `dist/` に出力                      |
| `npm start`                       | ビルド済みを実行                    |
| `npm run check`                   | 型チェック + Lint + テスト          |
| `npm test`                        | テストのみ                          |
| `npm run test:coverage`           | カバレッジ付き                      |
| `npm run lint` / `npm run format` | ESLint / Prettier                   |
| `npm run bootstrap`               | 最初の 1 人を作る                   |
| `npm run audit:verify`            | 監査ログの改竄検査                  |
| `npm run commands:deploy`         | スラッシュコマンドを Discord に登録 |

---

## 監査ログ

すべての操作が追記専用の監査ログに残る。各行が直前の行のハッシュを取り込んでいるので、
過去の行を書き換えると以降の連鎖が壊れて検出できる。

```bash
npm run audit:verify
```

---

## 構成

```
src/
  index.ts                エントリポイント
  env.ts                  環境変数の検証
  logger.ts
  db/
    migrations.ts         スキーマ。user_version で段数を管理
    schema.ts             Drizzle のテーブル定義
    client.ts             接続とマイグレーション
    members.ts  audit.ts
  domain/
    governance.ts         ★ 過半数判定。DB に依存しない純粋関数
    proposals.ts          提案の作成・投票・実行
    members.ts  tickets.ts  audit.ts
  auth/
    password.ts           argon2id
    credentials.ts        パスワードの設定と照合
    session.ts            AAL 付きセッション
    totp.ts               二要素認証
    passkey.ts            WebAuthn の登録と照合
    recovery.ts           リカバリコード
    crypto.ts             保存時の AES-256-GCM
  web/
    app.tsx               Hono の組み立てと状態画面
    context.ts            セッションの読み出しと入場制限
    routes/               enroll / login / proposals / settings
    views/                画面の部品と埋め込む script
  wallet/
    seed.ts  address.ts    鍵の導出と bech32m の住所
    vault.ts              控えをパスフレーズで封じる
    rpc.ts                oag-node への JSON-RPC
    store.ts              組織のウォレット 1 つぶん
    balance.ts  amount.ts 残高と金額の表し方
  bot/
    notify.ts             提案の通知とリンクの DM
  scripts/
    bootstrap.ts          最初の 1 人
    verify-audit.ts       監査ログの検査
```

`data/` の DB ファイルと `.env` は Git に入らない。

---

## バックアップ

以下を失うと復旧できない。

| もの                 | 失うと                                     |
| -------------------- | ------------------------------------------ |
| `data/orangebot.db`  | メンバー、提案、監査ログのすべて           |
| `APP_ENCRYPTION_KEY` | 全員の TOTP が読めなくなる                 |
| リカバリコード       | 1 人しかいない状態で締め出されると復旧不能 |

SQLite は WAL で動いているので、コピーするときは `.backup` を使う。

```bash
sqlite3 data/orangebot.db ".backup 'backup/orangebot-$(date +%F).db'"
```

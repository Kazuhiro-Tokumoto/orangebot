# orangebot pt 交換 API

orangebot の BOAG と、外部の bot の pt を交換するための API の仕様です。
orangebot 側の実装はこのリポジトリにあります。外部の bot 側で実装していただくのは、
**受け口 1 つ**と、**orangebot の API を呼ぶ処理**の 2 つです。

- orangebot 側の実装: `src/web/routes/exchange-api.ts`、`src/domain/exchange.ts`、
  `src/exchange/signature.ts`、`src/exchange/partner.ts`
- 仕様の版: `OBX1`

### URL の一覧

どちらの側も、既存の API と被らないよう `/api/orangebot-boag-pt-exchange/v1/` の下に置きます。

| 側 | URL | 呼ぶ人 |
| --- | --- | --- |
| orangebot | `https://mail.shudo-physics.com/api/orangebot-boag-pt-exchange/v1/health` | 外部の bot（署名不要） |
| orangebot | `https://mail.shudo-physics.com/api/orangebot-boag-pt-exchange/v1/deposits` | 外部の bot |
| orangebot | `https://mail.shudo-physics.com/api/orangebot-boag-pt-exchange/v1/deposits/{id}` | 外部の bot |
| orangebot | `https://mail.shudo-physics.com/api/orangebot-boag-pt-exchange/v1/members/{discordId}` | 外部の bot |
| orangebot | `https://mail.shudo-physics.com/api/orangebot-boag-pt-exchange/v1/rate` | 外部の bot |
| 外部の bot (大喜利 bot) | `https://oogiri-bot-cfy1.onrender.com/api/orangebot-boag-pt-exchange/v1/pt-deposits` | orangebot |

大喜利 bot の受け口は、上の URL で作ってください。別のパスにする場合は orangebot の管理者に伝えてください。

---

## 1. 換算

```
10,000,000 pt = 1 BOAG
1 pt          = 0.000000001 BOAG = 1,000,000,000 SOAG
```

- pt は **1 以上の整数**で扱います。1 pt 未満のやり取りはありません。
- BOAG は小数 16 桁で、最小単位を SOAG と呼びます (1 BOAG = 10^16 SOAG)。
- JSON の数値は 2^53 を超えると丸まるので、**pt と金額は必ず 10 進の文字列**で送ってください。

---

## 2. 取引の流れ

### pt から BOAG へ (入金)

利用者が外部の bot で操作します。

1. 外部の bot が、利用者の pt を自分の側で引く
2. 外部の bot が orangebot の `POST /api/orangebot-boag-pt-exchange/v1/deposits` を呼ぶ
3. orangebot が利用者に BOAG を付ける
4. orangebot が 4xx で断ったら、外部の bot は引いた pt を戻す

応答が返ってこなかった場合は、**同じ `id` と同じ内容で送り直してください**。
orangebot は `id` で重複を見分けるので、何度送っても BOAG は 1 回しか付きません。

### BOAG から pt へ (出金)

利用者が orangebot の画面で操作します。

1. orangebot が利用者の BOAG を先に引く
2. orangebot が外部の bot の受け口を呼ぶ
3. 外部の bot が利用者に pt を付ける
4. 外部の bot がはっきり断ったときだけ、orangebot は BOAG を戻す

受け口が応答しなかった場合、orangebot は**同じ `id` と同じ内容で送り直し続けます**。
受け口は `id` で重複を見分け、pt を 1 回だけ付けてください。

### 利用者の対応付け

利用者は **Discord のユーザー ID** で対応付けます。orangebot のメンバー ID は Discord のユーザー ID
そのものです。`discordId` は 17 から 20 桁の数字の**文字列**です。

---

## 3. 認証

両方向とも、同じ共有の秘密 (32 文字以上) を使う HMAC-SHA256 の署名で守ります。
秘密は orangebot の管理者から安全な経路で受け取ってください。

### 見出し

| 見出し | 値 |
| --- | --- |
| `X-Exchange-Timestamp` | Unix 秒の 10 進。例 `1789999999`。**ミリ秒ではありません** (13 桁は断ります) |
| `X-Exchange-Signature` | `v1=` に続けて、小文字 16 進の HMAC-SHA256 |
| `Content-Type` | `application/json` |

orangebot の応答には、成功でも失敗でも `X-Exchange-Server-Time` (こちらの時計、Unix 秒) が付きます。
401 が返るときは、まずこれと自分の時計を比べてください。

### 署名する文字列

次の 6 行を改行 (`\n`、LF のみ) で繋ぎます。末尾に改行は付けません。

```
OBX1
<向き>
<HTTP メソッド (大文字)>
<パス (クエリがあれば ? 以降も含む)>
<X-Exchange-Timestamp の値>
<本文の SHA-256 (小文字 16 進)>
```

- **向き**は、外部の bot から orangebot への要求なら `to-orangebot`、orangebot から外部の bot への要求なら
  `from-orangebot` です。向きを入れているのは、片方向の要求を反対の口へ投げ返す攻撃を防ぐためです。
- 本文が無い GET では、空文字列の SHA-256
  (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`) を使います。
- 本文は**送ったバイト列そのもの**をハッシュします。JSON を組み直すと空白や並びが変わって合わなくなります。

```
X-Exchange-Signature = "v1=" + hex(HMAC-SHA256(秘密, 署名する文字列))
```

### 検証するときに守ること

- タイムスタンプが自分の時計から **300 秒**以上ずれていたら断る
- 署名は**かかる時間が中身に依らない比較** (`crypto.timingSafeEqual` など) で比べる
- 向きが自分宛てのものか確かめる (受け口では `from-orangebot`)
- 署名が通らなかった理由は応答に書かない

### 例

秘密を `orangebot-example-secret-0123456789abcdef` とします。

**外部の bot から orangebot への入金**

```
POST /api/orangebot-boag-pt-exchange/v1/deposits
X-Exchange-Timestamp: 1789999999

{"id":"oogiri-20260917-0001","discordId":"1529717434259345489","pt":"10000000"}
```

```
本文の SHA-256 = 359ea0e091ab809cc240e8829a0ccc65bb0e8b519c317337b39c8f7dc1886b7b
X-Exchange-Signature: v1=08d2d28d8d2225a32da40dbefa27b19a2d4f18ad38d6dfd6eaf75959ede3dc70
```

**orangebot から外部の bot への出金** (受け口のパスが `/api/orangebot-boag-pt-exchange/v1/pt-deposits` の場合)

```
POST /api/orangebot-boag-pt-exchange/v1/pt-deposits
X-Exchange-Timestamp: 1789999999

{"id":"0b6c9f3e-2d7a-4c1e-9a55-7f0d2b8e4c11","discordId":"1529717434259345489","pt":"25000000","requestedAt":1789999990000}
```

```
本文の SHA-256 = 7628ac20d212ed083c6c7bdb22b3162d93d9ef8d4354b0ec74c88933c682cc25
X-Exchange-Signature: v1=cdf3c8484205568766376d9109c3ccf5617573ac39e5771b77114816be87e26a
```

実装したら、まずこの 2 つの値が出ることを確かめてください。

---

## 4. orangebot の API (外部の bot が呼ぶ)

基点は orangebot の公開 URL です (例 `https://mail.shudo-physics.com`)。
すべて前節の署名が要ります。向きは `to-orangebot` です。

### 誤りの形

```json
{ "error": { "code": "member_not_found", "message": "人が読むための説明" } }
```

`code` で分岐し、`message` は記録や表示だけに使ってください。

| HTTP | code | 意味 | 外部の bot がすること |
| --- | --- | --- | --- |
| 400 | `invalid_request` | 本文の形が違う | 直して送る。pt は戻す |
| 401 | `unauthorized` | 署名かタイムスタンプが違う | 秘密と時計を確かめる。pt は戻す |
| 404 | `member_not_found` | その Discord ID の有効なメンバーがいない | pt を戻す |
| 404 | `not_found` | その入金や API は無い | - |
| 409 | `idempotency_conflict` | 同じ `id` が別の内容で使われている | `id` の振り方を直す。pt は戻す |
| 413 | `payload_too_large` | 本文が 16 KiB を超えた | pt を戻す |
| 422 | `limit_exceeded` | 1 回または 24 時間の上限を超えた | pt を戻す |
| 503 | `disabled` | orangebot 側で交換を止めている | 後で送り直すか pt を戻す |
| 5xx その他、応答なし | - | 付いたか分からない | **同じ `id` で送り直す** |

### POST /api/orangebot-boag-pt-exchange/v1/deposits

利用者に BOAG を付けます。**pt を自分の側で引いてから**呼んでください。

要求

```json
{
  "id": "oogiri-20260917-0001",
  "discordId": "1529717434259345489",
  "pt": "10000000"
}
```

| 項目 | 型 | 決まり |
| --- | --- | --- |
| `id` | 文字列 | 外部の bot の取引番号。英数字と `-` `_` で 1 から 64 文字。取引ごとに一意 |
| `discordId` | 文字列 | 17 から 20 桁の数字 |
| `pt` | 文字列 | 1 以上の整数。先頭に 0 を付けない |

応答 (初めて付けたとき 201、同じ `id` と内容の二度目以降は 200)

```json
{
  "status": "credited",
  "replayed": false,
  "deposit": {
    "id": "oogiri-20260917-0001",
    "discordId": "1529717434259345489",
    "pt": "10000000",
    "boag": "1",
    "soag": "10000000000000000",
    "creditedAt": 1789999999123
  }
}
```

### GET /api/orangebot-boag-pt-exchange/v1/deposits/{id}

入金を `id` で引きます。付いていれば 200 と上と同じ `deposit`、無ければ 404 `not_found` です。
応答を受け取り損ねたときの照合に使えますが、単に同じ内容で POST を送り直しても同じ結果になります。

### GET /api/orangebot-boag-pt-exchange/v1/members/{discordId}

入金の前に、宛先が orangebot の有効なメンバーか確かめられます。
有効なら 200 `{"discordId":"...","active":true}`、そうでなければ 404 `member_not_found` です。
確かめた後に停止されることもあるので、POST の 404 にも必ず備えてください。

### GET /api/orangebot-boag-pt-exchange/v1/rate

```json
{
  "ptPerBoag": "10000000",
  "soagPerPt": "1000000000",
  "decimals": 16,
  "limits": { "maxPtPerRequest": "100000000000", "maxPtPerDay": "1000000000000" }
}
```

`limits` はいま効いている**入金**の上限 (7 節) です。orangebot の管理者が変えると値も変わるので、
起動時や 1 日 1 回取り直して、送る前に自分の側で弾けるようにしてください。
上限は pt の 10 進文字列です。

### GET /api/orangebot-boag-pt-exchange/v1/health

**この口だけ署名が要りません。**繋がるかどうかを、秘密を使わずに確かめるためのものです。

```json
{ "ok": true, "version": "OBX1", "exchange": "enabled", "serverTime": 1789999999 }
```

| 項目 | 意味 |
| --- | --- |
| `version` | 署名の仕様の版。合わなければ署名の作り方が変わっています |
| `exchange` | `enabled` なら交換を受け付けます。`disabled` なら止めてあります (他の口は 503) |
| `serverTime` | orangebot の時計 (Unix 秒)。自分の時計と 300 秒以上ずれていたら直してください |

残高も取引も、メンバーの一覧も出しません。

---

## 5. 外部の bot に実装していただく受け口

orangebot から出金を受け取る口です。**https が必須**です。

```
POST https://oogiri-bot-cfy1.onrender.com/api/orangebot-boag-pt-exchange/v1/pt-deposits
```

orangebot はこの URL を `EXCHANGE_PARTNER_URL` に設定して呼びます。
大喜利 bot の既存の API と被らないよう、長いパスにしてあります。

### 要求

```
POST <受け口の URL>
Content-Type: application/json
X-Exchange-Timestamp: 1789999999
X-Exchange-Signature: v1=...          (向きは from-orangebot)
Idempotency-Key: 0b6c9f3e-2d7a-4c1e-9a55-7f0d2b8e4c11

{"id":"0b6c9f3e-2d7a-4c1e-9a55-7f0d2b8e4c11","discordId":"1529717434259345489","pt":"25000000","requestedAt":1789999990000}
```

| 項目 | 型 | 決まり |
| --- | --- | --- |
| `id` | 文字列 | orangebot の出金番号 (UUID)。`Idempotency-Key` と同じ |
| `discordId` | 文字列 | 17 から 20 桁の数字 |
| `pt` | 文字列 | 付けてほしい pt。1 以上の整数 |
| `requestedAt` | 数値 | 利用者が操作した時刻 (Unix ミリ秒)。送り直しでも変わらない |

署名の検証に使うパスは、受け口の URL のパス (クエリがあれば含む) です。

### 受け口が守ること

1. **署名とタイムスタンプを検証し、通らなければ 401 を返す**。pt は付けない
2. **`id` を記録し、同じ `id` の二度目以降は pt を付けずに、初回と同じ 2xx を返す**。
   orangebot は届いたか分からないとき、同じ `id` で何度も送り直します
3. 同じ `id` で `discordId` か `pt` が違う要求が来たら **409** を返す
4. pt を付けたこと (と `id` の記録) は、**2xx を返す前に確定させる**。
   付けてから記録するまでの間に落ちると、送り直しで二重に付きます。
   同じトランザクションで行うか、`id` に一意制約を付けて先に記録してください
5. 利用者がいない、受け取れない状態なら **404 か 422** を返す

### 応答を orangebot がどう扱うか

| 受け口の応答 | orangebot がすること |
| --- | --- |
| 2xx | 届いたとみなして終わる。本文は読まない |
| 409 | 止めて、人が確かめるのを待つ。返金しない |
| 408, 425, 429, 5xx | 後で同じ内容を送り直す |
| 上記以外の 4xx (400, 401, 403, 404, 422 など) | 断られたとみなして、利用者に BOAG を戻す |
| 繋がらない、15 秒で応答が無い、リダイレクト | 後で同じ内容を送り直す |

**2xx を返したら、必ず pt が付いている状態にしてください。**
一時的に付けられないときは 503 を返してください。4xx を返すと orangebot は返金するので、
その後に pt を付けると二重になります。

誤りの本文は任意ですが、4 節と同じ `{"error":{"code","message"}}` の形なら、
`message` を利用者の画面に出します。

### 送り直しの間隔

失敗するたびに 10 秒、20 秒、40 秒と倍にし、1 時間で頭打ちにします。
7 日経っても届かなければ止めて、人が確かめるのを待ちます。

---

## 6. 実装の例 (Node.js)

依存の無い、そのまま動く最小の例です。フレームワークに合わせて組み込んでください。

### 署名

```js
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const MAX_SKEW_SECONDS = 300;

function stringToSign({ direction, method, path, timestamp, body }) {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  return ['OBX1', direction, method.toUpperCase(), path, timestamp, bodyHash].join('\n');
}

export function sign(secret, input) {
  return 'v1=' + createHmac('sha256', secret).update(stringToSign(input), 'utf8').digest('hex');
}

export function verify(secret, { direction, method, path, body, timestamp, signature }) {
  if (!/^\d{1,12}$/.test(timestamp ?? '')) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  if (!/^v1=[0-9a-f]{64}$/.test(signature ?? '')) return false;
  const expected = Buffer.from(sign(secret, { direction, method, path, timestamp, body }));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
```

### orangebot へ入金する

```js
const ORANGEBOT = 'https://mail.shudo-physics.com';

export async function depositToOrangebot(secret, { id, discordId, pt }) {
  const path = '/api/orangebot-boag-pt-exchange/v1/deposits';
  const body = JSON.stringify({ id, discordId, pt: String(pt) });
  const timestamp = String(Math.floor(Date.now() / 1000));

  const response = await fetch(ORANGEBOT + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-exchange-timestamp': timestamp,
      'x-exchange-signature': sign(secret, { direction: 'to-orangebot', method: 'POST', path, timestamp, body }),
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 200 || response.status === 201) return { ok: true };
  if (response.status >= 500) return { ok: false, retry: true };
  const error = (await response.json().catch(() => ({}))).error ?? {};
  // 4xx はすべて「付かなかった」。引いた pt を戻す。
  return { ok: false, retry: false, code: error.code, message: error.message };
}
```

呼ぶ前に取引番号 `id` を決めて自分の DB に保存し、pt を引いてください。
`retry: true` か例外 (時間切れなど) のときは、同じ `id` と同じ内容で後から送り直します。

### 受け口

```js
import http from 'node:http';

const SECRET = process.env.ORANGEBOT_EXCHANGE_SECRET;
const PATH = '/api/orangebot-boag-pt-exchange/v1/pt-deposits';

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');

  const reply = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  if (req.method !== 'POST' || req.url !== PATH) return reply(404, { error: { code: 'not_found' } });

  const ok = verify(SECRET, {
    direction: 'from-orangebot',
    method: req.method,
    path: req.url,
    body,
    timestamp: req.headers['x-exchange-timestamp'],
    signature: req.headers['x-exchange-signature'],
  });
  if (!ok) return reply(401, { error: { code: 'unauthorized', message: '署名が違います' } });

  const { id, discordId, pt } = JSON.parse(body);

  // ここから下は、自分の DB の 1 つのトランザクションで行うこと。
  //   1. id で既存の記録を引く
  //      - あって discordId と pt が同じ → 何もせず 200
  //      - あって中身が違う             → 409
  //   2. 利用者を discordId で引く。いなければ 404
  //   3. pt を付け、id と discordId と pt を記録する (id に一意制約)
  //   4. コミットしてから 200
  const result = await creditPtOnce({ id, discordId, pt: BigInt(pt) });

  if (result === 'credited' || result === 'duplicate') return reply(200, { status: 'credited' });
  if (result === 'conflict') return reply(409, { error: { code: 'idempotency_conflict', message: 'id が別の内容で使われています' } });
  if (result === 'user_not_found') return reply(404, { error: { code: 'user_not_found', message: 'その利用者はいません' } });
  return reply(503, { error: { code: 'unavailable', message: '一時的に受け付けられません' } });
}).listen(8080);
```

`creditPtOnce` は外部の bot の DB に合わせて実装してください。

---

## 7. 上限

秘密が漏れた場合の被害を抑えるため、orangebot は入金に上限を設けています。
既定値は次のとおりで、orangebot の管理者が変えられます。

| 上限 | 既定値 | BOAG に換算 |
| --- | ---: | ---: |
| 1 回の入金または出金 | 100,000,000,000 pt | 10,000 BOAG |
| 24 時間の入金の合計 | 1,000,000,000,000 pt | 100,000 BOAG |

超えた入金は 422 `limit_exceeded` で断ります。

---

## 8. 繋がらないときの切り分け

「orangebot に繋がらない」と見えるもののうち、本当に届いていないのは一部です。
**401 は届いています。**署名かタイムスタンプの問題なので、不通として扱わず、分けて記録してください。

順に 1 つずつ確かめます。

```bash
# 1. 口が開いているか (署名不要)
curl -i https://mail.shudo-physics.com/api/orangebot-boag-pt-exchange/v1/health

# 2. 署名が通るか (自分の実装で署名を作って投げる)
curl -i https://mail.shudo-physics.com/api/orangebot-boag-pt-exchange/v1/rate \
  -H "x-exchange-timestamp: $TS" -H "x-exchange-signature: $SIG"
```

| 見えるもの | 意味 | すること |
| --- | --- | --- |
| 1 が繋がらない (ECONNREFUSED、タイムアウト) | 経路かサーバーが落ちている | orangebot の管理者に伝える。出金は `pending` のまま送り直す |
| 1 が TLS の誤り (`unable to verify the first certificate` など) | 証明書の鎖が足りない | orangebot 側で `fullchain.pem` を使う。**回避のため検証を切らないこと** |
| 1 が 200 で `"exchange":"disabled"` | 秘密が未設定で止まっている | orangebot の管理者に伝える (`partner_disabled`) |
| 1 が 200、2 が 401 | 届いてはいるが署名が合わない | 下の「401 のとき」へ |
| 2 が 404 `not_found` | パスが違う | 冒頭の「URL の一覧」と突き合わせる。末尾に `/` を付けない |
| 2 が 200 | API は使えている | 入金の本文の形 (4 節) を見直す |

### 401 のとき

よくある順に並べています。

1. **タイムスタンプがミリ秒**。`Date.now()` をそのまま入れると 13 桁になり、断られます。
   `Math.floor(Date.now() / 1000)` の 10 桁です
2. **時計がずれている**。応答の `X-Exchange-Server-Time` と比べて 300 秒以内に収めてください
3. **本文を組み直している**。署名するのは**実際に送るバイト列そのもの**です。
   `JSON.stringify` した文字列を変数に入れ、署名にも本文にも同じものを渡してください
4. **GET の本文**。本文が無いときは空文字列 (`''`) をハッシュします。`undefined` や `{}` ではありません
5. **パスの書き方**。署名に入れるのは `https://...` を含まないパスだけです。
   クエリがあれば `?` 以降も含め、送る URL と 1 文字も違わないようにします
6. **向き**。orangebot を呼ぶときは `to-orangebot` です。`from-orangebot` は受け口用で、通りません
7. **秘密が違う**。前後の空白や改行が混ざっていないか確かめてください

3 節の例の 2 つの署名が自分の実装で再現できるなら、1 から 6 のどれかです。

---

## 9. 確かめること

- [ ] `GET /health` が 200 で `"exchange":"enabled"` を返す
- [ ] 3 節の例の 2 つの署名が、自分の実装でも同じ値になる
- [ ] 401 を「不通」と別に記録している (届いているので、送り直しでは直りません)
- [ ] 受け口が、署名の違う要求に 401 を返す
- [ ] 受け口が、同じ `id` を 2 回受けても pt を 1 回しか付けない
- [ ] 受け口が、同じ `id` で `pt` が違う要求に 409 を返す
- [ ] 受け口が、一時的な失敗に 4xx ではなく 503 を返す
- [ ] 入金を送る前に取引番号を保存し、応答が無ければ同じ番号で送り直す
- [ ] orangebot が 4xx を返した入金は、引いた pt を戻す
- [ ] 秘密をソースコードやログに残していない

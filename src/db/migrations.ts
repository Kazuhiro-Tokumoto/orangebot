/**
 * スキーマのマイグレーション。
 *
 * SQL を TS に埋め込んでいるのは、ビルド後の dist に .sql を配る手間を無くすため。
 * 適用済みの段数は SQLite の user_version に持たせる。配列の末尾に足すだけで 1 段増える。
 * 一度リリースした段は編集しない。
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE members (
    -- Discord のユーザー ID をそのまま主キーにする。
    -- snowflake は 64 ビット整数で JavaScript の数値では表しきれないため文字列で持つ。
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    -- pending: 招待は通ったがまだ本人の登録が済んでいない。有権者には数えない。
    status        TEXT NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'removed')),
    created_at    INTEGER NOT NULL,
    activated_at  INTEGER
  );

  CREATE TABLE password_credentials (
    member_id   TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
    hash        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE totp_credentials (
    member_id      TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
    secret_cipher  BLOB NOT NULL,
    confirmed_at   INTEGER,
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE passkeys (
    id            TEXT PRIMARY KEY,
    member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    public_key    BLOB NOT NULL,
    counter       INTEGER NOT NULL DEFAULT 0,
    transports    TEXT NOT NULL DEFAULT '[]',
    device_type   TEXT NOT NULL DEFAULT 'singleDevice',
    backed_up     INTEGER NOT NULL DEFAULT 0,
    nickname      TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER
  );
  CREATE INDEX passkeys_member_idx ON passkeys (member_id);

  CREATE TABLE recovery_codes (
    id          TEXT PRIMARY KEY,
    member_id   TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    code_hash   TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    used_at     INTEGER
  );
  CREATE INDEX recovery_codes_member_idx ON recovery_codes (member_id);

  CREATE TABLE proposals (
    id                 TEXT PRIMARY KEY,
    type               TEXT NOT NULL,
    summary            TEXT NOT NULL DEFAULT '',
    payload            TEXT NOT NULL DEFAULT '{}',
    proposed_by        TEXT REFERENCES members(id),
    subject_member_id  TEXT REFERENCES members(id),
    status             TEXT NOT NULL CHECK (
      status IN ('open', 'approved', 'rejected', 'executed', 'expired', 'cancelled')
    ),
    created_at         INTEGER NOT NULL,
    expires_at         INTEGER NOT NULL,
    decided_at         INTEGER,
    executed_at        INTEGER
  );
  CREATE INDEX proposals_status_idx ON proposals (status);

  -- 提案が立った瞬間の有権者を固定する。投票中に加入した人はここに現れない。
  CREATE TABLE proposal_voters (
    proposal_id  TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    PRIMARY KEY (proposal_id, member_id)
  );

  CREATE TABLE votes (
    proposal_id  TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    choice       TEXT NOT NULL CHECK (choice IN ('approve', 'reject')),
    voted_at     INTEGER NOT NULL,
    voided_at    INTEGER,
    PRIMARY KEY (proposal_id, member_id)
  );

  -- 加入リンクとパスワード再発行の引換券。token そのものではなく sha256 を保存する。
  CREATE TABLE tickets (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('enroll', 'password_reset')),
    member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    proposal_id  TEXT REFERENCES proposals(id) ON DELETE SET NULL,
    status       TEXT NOT NULL CHECK (status IN ('pending', 'active', 'used', 'revoked')),
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    used_at      INTEGER
  );
  CREATE INDEX tickets_member_idx ON tickets (member_id);
  CREATE INDEX tickets_proposal_idx ON tickets (proposal_id);

  CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,
    member_id       TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    -- 1 = パスワードのみ、2 = 二要素完了。投票と設定変更は 2 を要求する。
    aal             INTEGER NOT NULL CHECK (aal IN (1, 2)),
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    last_seen_at    INTEGER NOT NULL,
    ip              TEXT,
    user_agent      TEXT
  );
  CREATE INDEX sessions_member_idx ON sessions (member_id);

  CREATE TABLE webauthn_challenges (
    id          TEXT PRIMARY KEY,
    member_id   TEXT REFERENCES members(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
    challenge   TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE login_attempts (
    key           TEXT PRIMARY KEY,
    count         INTEGER NOT NULL,
    window_start  INTEGER NOT NULL,
    locked_until  INTEGER
  );

  -- 追記専用。hash = sha256(prev_hash + 正規化 JSON) で連鎖させ、改竄を検出できるようにする。
  CREATE TABLE audit_log (
    seq              INTEGER PRIMARY KEY AUTOINCREMENT,
    at               INTEGER NOT NULL,
    actor_member_id  TEXT,
    action           TEXT NOT NULL,
    detail           TEXT NOT NULL DEFAULT '{}',
    prev_hash        TEXT NOT NULL,
    hash             TEXT NOT NULL
  );
  `,

  // --- 2: BOAG の内部台帳 ---
  `
  -- 複式。ひとつの動きは tx_id でまとめられた複数行からなり、その合計は必ず 0 になる。
  -- 発行は特別口座 '@supply' から出て誰かに入る形で表す。
  -- こうしておくと「全行の合計が 0 か」を見るだけで、無から増えていないことを確かめられる。
  CREATE TABLE ledger_entries (
    id          TEXT PRIMARY KEY,
    tx_id       TEXT NOT NULL,
    account_id  TEXT NOT NULL,
    -- 符号付きの整数を 10 進文字列で持つ。JavaScript の数値では桁が足りないため。
    amount      TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('mint', 'transfer', 'burn', 'exchange')),
    -- 由来。発行なら提案 ID、交換なら外部サービスの取引 ID。
    ref         TEXT,
    memo        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX ledger_account_idx ON ledger_entries (account_id);
  CREATE INDEX ledger_tx_idx ON ledger_entries (tx_id);
  `,

  // --- 3: OAG のウォレット ---
  `
  -- 組織にひとつのウォレット。控えはパスフレーズで封じた塊のまま置く。
  -- 口座の拡張公開鍵だけは平文で持つ。住所を作るのに秘密は要らないので、
  -- 残高を見るだけならパスフレーズを誰にも聞かずに済む。
  CREATE TABLE wallets (
    id            TEXT PRIMARY KEY,
    network       TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet', 'regtest')),
    account       INTEGER NOT NULL DEFAULT 0,
    xpub          TEXT NOT NULL,
    vault         BLOB NOT NULL,
    -- 次に配る受取住所の番号。配った分を覚えておかないと同じ住所を配ってしまう。
    next_receive  INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    created_by    TEXT REFERENCES members(id) ON DELETE SET NULL
  );
  `,

  // --- 4: メンバーどうしの投稿 ---
  `
  -- 返信は parent_id で親を指し、root_id でスレッドの先頭を指す。
  -- 先頭を直接持っておくと、スレッドひとつぶんを 1 回の問い合わせで引ける。
  -- 消すときは行を残して本文だけ空にする。返信の繋がりと投げ銭の記録を壊さないため。
  CREATE TABLE posts (
    id          TEXT PRIMARY KEY,
    author_id   TEXT NOT NULL REFERENCES members(id),
    parent_id   TEXT REFERENCES posts(id),
    root_id     TEXT REFERENCES posts(id),
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    deleted_at  INTEGER
  );
  CREATE INDEX posts_timeline_idx ON posts (parent_id, created_at);
  CREATE INDEX posts_root_idx ON posts (root_id, created_at);
  -- 投げ銭は台帳の ref に 'post:<id>' を入れて辿る。
  CREATE INDEX ledger_ref_idx ON ledger_entries (ref);
  `,

  // --- 5: OAG の送金 ---
  `
  -- お釣りの住所も使い回さない。配った番号を覚えておく。
  ALTER TABLE wallets ADD COLUMN next_change INTEGER NOT NULL DEFAULT 0;

  -- 承認された送金の提案 1 件につき、署名した取引は 1 つだけ。
  -- 送る前に署名済みの取引をここへ書く。送った直後に落ちても、何を送ったかが残る。
  -- 送り直すときは同じバイト列を投げる。作り直すと別の取引が生まれ、二重に払いうるため。
  CREATE TABLE oag_sends (
    id            TEXT PRIMARY KEY,
    proposal_id   TEXT NOT NULL UNIQUE REFERENCES proposals(id),
    status        TEXT NOT NULL CHECK (status IN ('signed', 'broadcast', 'unknown', 'failed')),
    txid          TEXT NOT NULL,
    raw_hex       TEXT NOT NULL,
    -- 使った出力 'txid:index' の JSON 配列。承認待ちの間は次の送金で使わない。
    inputs        TEXT NOT NULL,
    to_address    TEXT NOT NULL,
    amount        TEXT NOT NULL,
    fee           TEXT NOT NULL,
    change        TEXT NOT NULL,
    created_by    TEXT REFERENCES members(id) ON DELETE SET NULL,
    created_at    INTEGER NOT NULL,
    broadcast_at  INTEGER,
    error         TEXT
  );
  `,

  // --- 6: 5 分ごとの値動きの予想 ---
  `
  -- 回はシンボルと開始時刻で決まる。開始時刻は 5 分の倍数で、取引所の 5 分足と揃える。
  -- 賭けが 1 つも無い回は行を作らない。
  CREATE TABLE prediction_rounds (
    id            TEXT PRIMARY KEY,
    symbol        TEXT NOT NULL,
    starts_at     INTEGER NOT NULL,
    ends_at       INTEGER NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('open', 'settled', 'refunded')),
    open_price    TEXT,
    close_price   TEXT,
    outcome       TEXT CHECK (outcome IN ('up', 'down', 'flat')),
    settled_at    INTEGER,
    UNIQUE (symbol, starts_at)
  );
  CREATE INDEX prediction_rounds_status_idx ON prediction_rounds (status, ends_at);

  -- 賭け金は台帳の特別口座 '@prediction' に預ける。決着したらそこから払い戻す。
  -- 金額は SOAG の 10 進文字列。
  CREATE TABLE prediction_bets (
    id          TEXT PRIMARY KEY,
    round_id    TEXT NOT NULL REFERENCES prediction_rounds(id),
    member_id   TEXT NOT NULL REFERENCES members(id),
    side        TEXT NOT NULL CHECK (side IN ('up', 'down')),
    stake       TEXT NOT NULL,
    payout      TEXT,
    placed_at   INTEGER NOT NULL
  );
  CREATE INDEX prediction_bets_round_idx ON prediction_bets (round_id);
  CREATE INDEX prediction_bets_member_idx ON prediction_bets (member_id, placed_at);
  `,

  // --- 7: 外部の bot との pt の交換 ---
  `
  -- 相手から届いた入金。id は相手が決めた取引の番号で、同じ番号の二度目は同じ結果を返す。
  -- body_hash で中身を覚えておき、同じ番号で中身が違えば断る。
  CREATE TABLE exchange_deposits (
    id          TEXT PRIMARY KEY,
    member_id   TEXT NOT NULL REFERENCES members(id),
    pt          TEXT NOT NULL,
    soag        TEXT NOT NULL,
    body_hash   TEXT NOT NULL,
    ledger_tx   TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX exchange_deposits_created_idx ON exchange_deposits (created_at);

  -- 相手へ送る出金。台帳から先に引いてから、届くまで何度でも送る (outbox)。
  -- 相手がはっきり断ったときだけ返金する。届いたか分からないうちは返金しない。
  CREATE TABLE exchange_withdrawals (
    id               TEXT PRIMARY KEY,
    member_id        TEXT NOT NULL REFERENCES members(id),
    pt               TEXT NOT NULL,
    soag             TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'refunded', 'stuck')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  INTEGER NOT NULL,
    last_error       TEXT,
    last_status      INTEGER,
    created_at       INTEGER NOT NULL,
    settled_at       INTEGER
  );
  CREATE INDEX exchange_withdrawals_due_idx ON exchange_withdrawals (status, next_attempt_at);
  CREATE INDEX exchange_withdrawals_member_idx ON exchange_withdrawals (member_id, created_at);
  `,

  // --- 8: 終値予想、順位予想、値幅予想、みんなで予想 ---
  `
  -- 1 時間足 1 本に対応する回。closest と volatility は subject が銘柄、ranking は比べる銘柄をカンマで並べたもの。
  -- 銘柄の組を回に書いておくので、途中で設定を変えても進行中の回は変わらない。
  CREATE TABLE game_rounds (
    id          TEXT PRIMARY KEY,
    game        TEXT NOT NULL CHECK (game IN ('closest', 'ranking', 'volatility')),
    subject     TEXT NOT NULL,
    starts_at   INTEGER NOT NULL,
    ends_at     INTEGER NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('open', 'settled', 'refunded')),
    -- 決着の中身の JSON。値段と勝ち。
    result      TEXT,
    settled_at  INTEGER,
    UNIQUE (game, subject, starts_at)
  );
  CREATE INDEX game_rounds_status_idx ON game_rounds (status, ends_at);

  -- 1 回に 1 人 1 つ。pick は closest なら予想した値段、ranking なら銘柄、volatility なら値幅の帯。
  -- 賭け金は特別口座 '@games' に預ける。金額は SOAG の 10 進文字列。
  CREATE TABLE game_entries (
    id          TEXT PRIMARY KEY,
    round_id    TEXT NOT NULL REFERENCES game_rounds(id),
    member_id   TEXT NOT NULL REFERENCES members(id),
    pick        TEXT NOT NULL,
    stake       TEXT NOT NULL,
    payout      TEXT,
    placed_at   INTEGER NOT NULL,
    UNIQUE (round_id, member_id)
  );
  CREATE INDEX game_entries_member_idx ON game_entries (member_id, placed_at);

  -- メンバーが出した問い。開くのも判定するのも過半数の提案を通す。
  CREATE TABLE markets (
    id                   TEXT PRIMARY KEY,
    proposal_id          TEXT NOT NULL UNIQUE REFERENCES proposals(id),
    question             TEXT NOT NULL,
    criteria             TEXT NOT NULL,
    closes_at            INTEGER NOT NULL,
    status               TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'refunded')),
    outcome              TEXT CHECK (outcome IN ('yes', 'no')),
    created_by           TEXT REFERENCES members(id),
    created_at           INTEGER NOT NULL,
    resolved_at          INTEGER,
    resolved_by_proposal TEXT
  );
  CREATE INDEX markets_status_idx ON markets (status, closes_at);

  -- 賭け金は特別口座 '@markets' に預ける。
  CREATE TABLE market_bets (
    id          TEXT PRIMARY KEY,
    market_id   TEXT NOT NULL REFERENCES markets(id),
    member_id   TEXT NOT NULL REFERENCES members(id),
    side        TEXT NOT NULL CHECK (side IN ('yes', 'no')),
    stake       TEXT NOT NULL,
    payout      TEXT,
    placed_at   INTEGER NOT NULL
  );
  CREATE INDEX market_bets_market_idx ON market_bets (market_id);
  CREATE INDEX market_bets_member_idx ON market_bets (member_id, placed_at);
  `,
];

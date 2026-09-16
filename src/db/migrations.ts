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
];

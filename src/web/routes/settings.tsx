import { Hono, type Context } from 'hono';
import { checkPassword, setPassword } from '../../auth/credentials.js';
import { countUnused, replaceCodes } from '../../auth/recovery.js';
import {
  finishRegistration,
  listPasskeys,
  removePasskey,
  startRegistration,
} from '../../auth/passkey.js';
import { destroyAllSessions, listSessions } from '../../auth/session.js';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import type { LedgerRow, MemberRow, PasskeyRow, SessionRow } from '../../db/schema.js';
import { balanceOf, formatAmount, historyOf } from '../../domain/ledger.js';
import {
  field,
  jsonObject,
  jsonString,
  requireFullSession,
  type AppBindings,
  type RouteDeps,
} from '../context.js';
import { Field, Notice, SecretBox, Submit } from '../views/forms.js';
import { Layout } from '../views/layout.js';
import { PASSKEY_SCRIPT } from '../views/passkey-script.js';

function when(ms: number): string {
  return new Date(ms).toLocaleString('ja-JP', { hour12: false });
}

/** 口座から見た符号付きの動き。自分の行だけ渡ってくる。 */
const KIND_LABELS: Record<LedgerRow['kind'], string> = {
  mint: '発行',
  transfer: '送金',
  burn: '焼却',
  exchange: '交換',
};

function SettingsPage(props: {
  readonly member: MemberRow;
  readonly sessions: readonly SessionRow[];
  readonly currentSessionId: string;
  readonly recoveryRemaining: number;
  readonly passkeys: readonly PasskeyRow[];
  readonly balance: bigint;
  readonly history: readonly LedgerRow[];
  readonly error?: string | undefined;
  readonly notice?: string | undefined;
}) {
  return (
    <Layout title="設定" viewer={props.member.displayName} script={PASSKEY_SCRIPT}>
      <h1>設定</h1>
      <p class="lede">あなた自身のアカウントに関わる操作だけを置いてあります。</p>

      {props.error === undefined ? null : <Notice tone="bad">{props.error}</Notice>}
      {props.notice === undefined ? null : <Notice tone="ok">{props.notice}</Notice>}

      <h2>アカウント</h2>
      <section class="panel">
        <table>
          <tr>
            <th>表示名</th>
            <td>{props.member.displayName}</td>
          </tr>
          <tr>
            <th>ユーザー名</th>
            <td class="mono">{props.member.username}</td>
          </tr>
          <tr>
            <th>Discord ID</th>
            <td class="mono">{props.member.id}</td>
          </tr>
          <tr>
            <th>登録</th>
            <td>{props.member.activatedAt === null ? '未完了' : when(props.member.activatedAt)}</td>
          </tr>
          <tr>
            <th>残高</th>
            <td>
              <span class="big">{formatAmount(props.balance)}</span> BOAG
            </td>
          </tr>
        </table>
      </section>

      <h2>パスワードの変更</h2>
      <section class="panel">
        <p class="field-hint" style="margin:0 0 14px">
          自分で変える分には承認は要りません。承認が要るのは、忘れて再発行するときです。
          変更すると、この端末以外はすべてログアウトされます。
        </p>
        <form class="stack" method="post" action="/settings/password">
          <Field
            label="いまのパスワード"
            name="current"
            type="password"
            required
            autocomplete="current-password"
          />
          <Field
            label="新しいパスワード"
            name="password"
            type="password"
            required
            autocomplete="new-password"
            hint="12 文字以上。ユーザー名や表示名を含めないでください。"
          />
          <Field
            label="もう一度"
            name="confirm"
            type="password"
            required
            autocomplete="new-password"
          />
          <Submit>変更する</Submit>
        </form>
      </section>

      <h2>リカバリコード</h2>
      <section class="panel">
        <p class="field-hint" style="margin:0 0 14px">
          残り {String(props.recoveryRemaining)} 枚。
          発行し直すと、いま手元にある組はすべて使えなくなります。
        </p>
        <form class="stack" method="post" action="/settings/recovery">
          <Field
            label="いまのパスワード"
            name="current"
            type="password"
            required
            autocomplete="current-password"
          />
          <Submit tone="danger">新しく 10 枚発行する</Submit>
        </form>
      </section>

      <h2>ログイン中の端末</h2>
      <section class="panel">
        <div class="scroll">
          <table>
            <tr>
              <th>最後の操作</th>
              <th>接続元</th>
              <th>端末</th>
              <th />
            </tr>
            {props.sessions.map((s) => (
              <tr>
                <td>{when(s.lastSeenAt)}</td>
                <td class="mono">{s.ip ?? '不明'}</td>
                <td class="muted">{s.userAgent ?? '不明'}</td>
                <td>
                  {s.id === props.currentSessionId ? <span class="tag accent">この端末</span> : null}
                </td>
              </tr>
            ))}
          </table>
        </div>
        <form method="post" action="/settings/sessions" style="margin-top:14px">
          <button class="btn quiet" type="submit">
            この端末以外をログアウトする
          </button>
        </form>
      </section>

      <h2>BOAG の履歴</h2>
      <section class="panel">
        {props.history.length === 0 ? (
          <span class="muted">まだ動きがありません。</span>
        ) : (
          <div class="scroll">
            <table>
              <tr>
                <th>日時</th>
                <th>種類</th>
                <th>増減</th>
                <th>摘要</th>
              </tr>
              {props.history.map((row) => (
                <tr>
                  <td>{when(row.createdAt)}</td>
                  <td>{KIND_LABELS[row.kind]}</td>
                  <td class="mono">
                    {BigInt(row.amount) > 0n ? '+' : ''}
                    {formatAmount(BigInt(row.amount))}
                  </td>
                  <td class="muted">{row.memo}</td>
                </tr>
              ))}
            </table>
          </div>
        )}
      </section>

      <h2>パスキー</h2>
      <section class="panel">
        <p class="field-hint" style="margin:0 0 14px">
          端末の生体認証や PIN でログインできます。鍵は端末から出ず、使うたびに本人確認が入るので、
          パスキー 1 つでパスワードと認証アプリの両方の代わりになります。
        </p>

        {props.passkeys.length === 0 ? (
          <span class="muted">まだ登録がありません。</span>
        ) : (
          <div class="scroll">
            <table>
              <tr>
                <th>名前</th>
                <th>登録</th>
                <th>最後に使った日</th>
                <th />
              </tr>
              {props.passkeys.map((key) => (
                <tr>
                  <td>{key.nickname}</td>
                  <td>{when(key.createdAt)}</td>
                  <td class="muted">{key.lastUsedAt === null ? 'まだ' : when(key.lastUsedAt)}</td>
                  <td>
                    <form method="post" action="/settings/passkeys/delete">
                      <input type="hidden" name="passkeyId" value={key.id} />
                      <button class="btn quiet" type="submit">
                        削除
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </table>
          </div>
        )}

        <div class="field" style="margin-top:16px;max-width:460px">
          <label class="field-label" for="passkey-nickname">
            名前
          </label>
          <input
            class="input"
            id="passkey-nickname"
            type="text"
            placeholder="仕事用のノート PC"
            autocomplete="off"
          />
          <span class="field-hint">後から見分けるための覚え書きです。</span>
        </div>
        <p class="row" style="margin-top:14px">
          <button class="btn" id="passkey-register" type="button">
            この端末にパスキーを登録する
          </button>
        </p>
        <p id="passkey-status" class="field-hint" />
      </section>

      <form method="post" action="/logout" style="margin-top:36px">
        <button class="btn quiet" type="submit">
          ログアウト
        </button>
      </form>
    </Layout>
  );
}

/** 一度だけ見せるリカバリコードの画面。 */
function CodesPage({ codes }: { codes: readonly string[] }) {
  return (
    <Layout title="リカバリコード">
      <h1>新しいリカバリコード</h1>
      <Notice tone="bad">
        この画面を離れると二度と表示されません。古いコードはもう使えません。
      </Notice>
      <SecretBox label="リカバリコード" values={codes} />
      <p class="lede">
        <a class="plain" href="/settings">
          設定に戻る
        </a>
      </p>
    </Layout>
  );
}

export function settingsRoutes(deps: RouteDeps) {
  const app = new Hono<AppBindings>();
  app.use('/settings', requireFullSession());
  app.use('/settings/*', requireFullSession());

  function render(c: Context<AppBindings>, error?: string, notice?: string) {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    return c.html(
      <SettingsPage
        member={viewer.member}
        sessions={listSessions(deps.db, viewer.member.id)}
        currentSessionId={viewer.session.id}
        recoveryRemaining={countUnused(deps.db, viewer.member.id)}
        passkeys={listPasskeys(deps.db, viewer.member.id)}
        balance={balanceOf(deps.db, viewer.member.id)}
        history={historyOf(deps.db, viewer.member.id, 20)}
        error={error}
        notice={notice}
      />,
      error === undefined ? 200 : 400,
    );
  }

  app.get('/settings', (c) => render(c));

  app.post('/settings/password', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const current = await checkPassword(deps.db, viewer.member.id, field(form, 'current'));
    if (!current.matched) return render(c, 'いまのパスワードが違います');

    const password = field(form, 'password');
    if (password !== field(form, 'confirm')) return render(c, '2 つの入力が一致しません');

    const result = await setPassword(deps.db, {
      memberId: viewer.member.id,
      password,
      action: 'password.changed',
    });
    if (!result.ok) return render(c, result.reason);

    // この端末は残す。自分で変えた以上、いま操作している画面まで切る理由がない。
    const removed = destroyAllSessions(deps.db, viewer.member.id, viewer.session.id);
    return render(
      c,
      undefined,
      removed === 0
        ? 'パスワードを変更しました。'
        : `パスワードを変更し、他の ${String(removed)} 端末をログアウトしました。`,
    );
  });

  /**
   * リカバリコードの再発行。
   * 二要素を通ったセッションでも、ここだけはパスワードをもう一度確かめる。
   * 開いたままの画面を他人に触られたときに、復旧手段ごと持って行かれないようにするため。
   */
  app.post('/settings/recovery', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const current = await checkPassword(deps.db, viewer.member.id, field(form, 'current'));
    if (!current.matched) return render(c, 'いまのパスワードが違います');

    const codes = replaceCodes(deps.db, { memberId: viewer.member.id });
    return c.html(<CodesPage codes={codes} />);
  });

  // --- パスキー -------------------------------------------------------------
  //
  // ここだけは JSON で遣り取りする。認証器との受け渡しに二進の値が要るためで、
  // 素の HTML フォームでは表せない。クッキーは同一生成元にしか付かないので、
  // 他所の頁から呼び出すことはできない。

  app.post('/settings/passkeys/options', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.json({ ok: false, reason: 'ログインし直してください' }, 401);

    const start = await startRegistration(deps.db, {
      member: viewer.member,
      rpId: deps.env.rpId,
      rpName: deps.env.rpName,
    });
    return c.json({ ok: true, challengeId: start.challengeId, options: start.options });
  });

  app.post('/settings/passkeys', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.json({ ok: false, reason: 'ログインし直してください' }, 401);

    const body: unknown = await c.req.json().catch(() => undefined);
    const response = jsonObject<RegistrationResponseJSON>(body, 'response');
    if (response === undefined) return c.json({ ok: false, reason: '応答の形が違います' }, 400);

    const result = await finishRegistration(deps.db, {
      memberId: viewer.member.id,
      challengeId: jsonString(body, 'challengeId'),
      response,
      nickname: jsonString(body, 'nickname'),
      origin: deps.env.webOrigin,
      rpId: deps.env.rpId,
    });

    if (!result.ok) return c.json({ ok: false, reason: result.reason }, 400);
    return c.json({ ok: true });
  });

  app.post('/settings/passkeys/delete', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const result = removePasskey(deps.db, {
      memberId: viewer.member.id,
      passkeyId: field(form, 'passkeyId'),
    });

    if (!result.ok) return render(c, result.reason);
    return render(c, undefined, 'パスキーを削除しました。');
  });

  app.post('/settings/sessions', (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    // いま使っているセッションだけ残す。
    const removed = destroyAllSessions(deps.db, viewer.member.id, viewer.session.id);
    return render(
      c,
      undefined,
      removed === 0
        ? 'この端末以外にログイン中の端末はありませんでした。'
        : `${String(removed)} 件のセッションを切りました。`,
    );
  });

  return app;
}

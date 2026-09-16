import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { checkPassword, setPassword } from '../../auth/credentials.js';
import { finishAuthentication, startAuthentication } from '../../auth/passkey.js';
import { consumeCode, countUnused } from '../../auth/recovery.js';
import {
  createSession,
  destroyAllSessions,
  destroySession,
  upgradeSession,
} from '../../auth/session.js';
import { hasConfirmedTotp, loadSecret, verifyCode } from '../../auth/totp.js';
import { getMemberByUsername } from '../../db/members.js';
import { createProposal } from '../../domain/proposals.js';
import {
  DEFAULT_TICKET_TTL_MS,
  consumeTicket,
  findUsableTicket,
} from '../../domain/tickets.js';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  clientIp,
  jsonObject,
  jsonString,
  setSessionCookie,
  userAgent,
  field,
  type AppBindings,
  type RouteDeps,
} from '../context.js';
import { Field, Notice, Submit } from '../views/forms.js';
import { Layout } from '../views/layout.js';
import { PASSKEY_SCRIPT } from '../views/passkey-script.js';

function LoginPage({ error }: { error?: string }) {
  return (
    <Layout title="ログイン" script={PASSKEY_SCRIPT}>
      <h1>ログイン</h1>
      {error === undefined ? null : <Notice tone="bad">{error}</Notice>}
      <form class="stack" method="post" action="/login">
        <Field label="ユーザー名" name="username" required autocomplete="username" />
        <Field label="パスワード" name="password" type="password" required autocomplete="current-password" />
        <Submit>次へ</Submit>
      </form>
      <p class="lede" style="margin-top:22px">
        <a class="plain" href="/forgot">
          パスワードを忘れた
        </a>
      </p>

      <h2>パスキーを使う</h2>
      <p class="lede">
        この端末にパスキーを登録してあれば、指紋や PIN だけで入れます。
        鍵は端末から出ず、使うたびに本人確認が入るので、これ 1 つで二要素を満たします。
      </p>
      <p class="row">
        <button class="btn quiet" id="passkey-login" type="button">
          パスキーでログイン
        </button>
      </p>
      <p id="passkey-status" class="field-hint" />
    </Layout>
  );
}

function TotpPage({ error, remaining }: { error?: string | undefined; remaining: number }) {
  return (
    <Layout title="二要素認証">
      <h1>二要素認証</h1>
      {error === undefined ? null : <Notice tone="bad">{error}</Notice>}
      <p class="lede">認証アプリに表示されている 6 桁を入れてください。</p>
      <form class="stack" method="post" action="/login/totp">
        <Field
          label="認証アプリの 6 桁"
          name="code"
          required
          inputmode="numeric"
          autocomplete="one-time-code"
          placeholder="123456"
        />
        <Submit>ログイン</Submit>
      </form>

      <h2>認証アプリが使えないとき</h2>
      <p class="lede">
        登録時に控えたリカバリコードを 1 枚使えます。残り {String(remaining)} 枚。
      </p>
      <form class="stack" method="post" action="/login/recovery">
        <Field label="リカバリコード" name="code" required placeholder="ABCDEF-GHIJKL-..." />
        <Submit>コードを使う</Submit>
      </form>
    </Layout>
  );
}

export function loginRoutes(deps: RouteDeps) {
  const app = new Hono<AppBindings>();

  app.get('/login', (c) => {
    const viewer = c.get('viewer');
    if (viewer !== undefined && viewer.aal === 2) return c.redirect('/proposals');
    if (viewer !== undefined) return c.redirect('/login/totp');
    return c.html(<LoginPage />);
  });

  /**
   * 手順 1。パスワードを確かめて、二要素待ちのセッションを作る。
   *
   * 利用者名が存在するかどうかを、返す文言でも応答の速さでも漏らさない。
   * checkPassword は行が無い場合も 1 回ハッシュを計算してから false を返す。
   */
  app.post('/login', async (c) => {
    const form = await c.req.formData();
    const username = field(form, 'username').trim();
    const password = field(form, 'password');

    const member = getMemberByUsername(deps.db, username);
    const result = await checkPassword(deps.db, member?.id ?? '', password);

    const denied = <LoginPage error="ユーザー名かパスワードが違います" />;
    if (!result.matched || member === undefined) return c.html(denied, 401);
    if (member.status !== 'active') {
      if (member.status === 'pending') {
        return c.html(
          <LoginPage error="登録がまだ終わっていません。登録リンクから設定を済ませてください" />,
          401,
        );
      }
      return c.html(<LoginPage error="このアカウントは利用できません" />, 403);
    }
    if (!hasConfirmedTotp(deps.db, member.id)) {
      return c.html(<LoginPage error="二要素認証が登録されていません。再登録が必要です" />, 403);
    }

    const session = createSession(deps.db, {
      memberId: member.id,
      aal: 1,
      ip: clientIp(c),
      userAgent: userAgent(c),
    });
    setSessionCookie(c, deps.env, session.token, session.expiresAt);
    return c.redirect('/login/totp');
  });

  app.get('/login/totp', (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');
    if (viewer.aal === 2) return c.redirect('/proposals');
    return c.html(<TotpPage remaining={countUnused(deps.db, viewer.member.id)} />);
  });

  /** 手順 2。符号が合えばセッションを引き上げ、token も作り直す。 */
  app.post('/login/totp', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const stored = loadSecret(deps.db, viewer.member.id, deps.env.encryptionKey);
    const remaining = countUnused(deps.db, viewer.member.id);

    if (stored === undefined || !stored.confirmed) {
      return c.html(<TotpPage remaining={remaining} error="二要素認証が登録されていません" />, 403);
    }
    if (!verifyCode({ secret: stored.secret, code: field(form, 'code') })) {
      return c.html(<TotpPage remaining={remaining} error="符号が合いません" />, 401);
    }

    const token = getCookie(c, SESSION_COOKIE);
    if (token === undefined) return c.redirect('/login');

    const upgraded = upgradeSession(deps.db, { currentToken: token, factor: 'totp' });
    if (upgraded === undefined) return c.redirect('/login');

    setSessionCookie(c, deps.env, upgraded.token, upgraded.expiresAt);
    return c.redirect('/proposals');
  });

  /** リカバリコードでの通過。使い切りで、監査ログに残る。 */
  app.post('/login/recovery', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const used = consumeCode(deps.db, {
      code: field(form, 'code'),
      memberId: viewer.member.id,
    });

    if (!used.ok) {
      return c.html(
        <TotpPage remaining={countUnused(deps.db, viewer.member.id)} error={used.reason} />,
        401,
      );
    }

    const token = getCookie(c, SESSION_COOKIE);
    if (token === undefined) return c.redirect('/login');

    const upgraded = upgradeSession(deps.db, { currentToken: token, factor: 'recovery_code' });
    if (upgraded === undefined) return c.redirect('/login');

    setSessionCookie(c, deps.env, upgraded.token, upgraded.expiresAt);
    return c.redirect('/settings');
  });

  // --- パスキー -------------------------------------------------------------
  //
  // 利用者名を先に聞かない。端末の中にある鍵から browser が選ぶので、
  // 存在する利用者名を総当たりで探る余地が残らない。
  // userVerification は required なので、通った時点で二要素を満たしている。

  app.post('/login/passkey/options', async (c) => {
    const start = await startAuthentication(deps.db, { rpId: deps.env.rpId });
    return c.json({ ok: true, challengeId: start.challengeId, options: start.options });
  });

  app.post('/login/passkey', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const response = jsonObject<AuthenticationResponseJSON>(body, 'response');
    if (response === undefined) return c.json({ ok: false, reason: '応答の形が違います' }, 400);

    const result = await finishAuthentication(deps.db, {
      challengeId: jsonString(body, 'challengeId'),
      response,
      origin: deps.env.webOrigin,
      rpId: deps.env.rpId,
    });
    if (!result.ok) return c.json({ ok: false, reason: result.reason }, 401);

    const session = createSession(deps.db, {
      memberId: result.member.id,
      aal: 2,
      ip: clientIp(c),
      userAgent: userAgent(c),
    });
    setSessionCookie(c, deps.env, session.token, session.expiresAt);
    return c.json({ ok: true, redirect: '/proposals' });
  });

  app.post('/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token !== undefined) destroySession(deps.db, token);
    clearSessionCookie(c, deps.env);
    return c.redirect('/status');
  });

  // --- パスワードを忘れたとき ---------------------------------------------

  app.get('/forgot', (c) =>
    c.html(
      <Layout title="パスワードの再発行">
        <h1>パスワードの再発行</h1>
        <p class="lede">
          再発行には他のメンバーの過半数の承認が要ります。申し込むと引換のリンクがその場で出るので、
          承認が集まってからそのリンクで新しいパスワードを決めます。
        </p>
        <form class="stack" method="post" action="/forgot">
          <Field label="ユーザー名" name="username" required autocomplete="username" />
          <Submit>再発行を申し込む</Submit>
        </form>
      </Layout>,
    ),
  );

  app.post('/forgot', async (c) => {
    const form = await c.req.formData();
    const username = field(form, 'username').trim();
    const member = getMemberByUsername(deps.db, username);

    // 利用者名の有無を漏らさないため、見つからない場合も同じ画面を返す。
    if (member === undefined || member.status !== 'active') {
      return c.html(
        <Layout title="申し込みを受け付けました">
          <h1>申し込みを受け付けました</h1>
          <p class="lede">
            該当するアカウントがあれば、他のメンバーに承認の依頼が回ります。
            引換のリンクは申し込んだ本人にだけ表示されます。
          </p>
        </Layout>,
      );
    }

    const created = createProposal(deps.db, {
      type: 'credential.password_reset',
      proposedBy: null,
      subjectMemberId: member.id,
    });

    if (!created.ok) {
      return c.html(
        <Layout title="申し込めません">
          <h1>申し込めません</h1>
          <Notice tone="bad">{created.reason}</Notice>
        </Layout>,
        400,
      );
    }

    deps.notify.announce(created.view);

    const link = `${deps.env.webOrigin}/reset?token=${created.resetToken ?? ''}`;
    const ticketExpiry = Date.now() + DEFAULT_TICKET_TTL_MS;
    const sent = await deps.notify.deliverLink({
      discordId: member.id,
      kind: 'password_reset',
      url: link,
      expiresAt: ticketExpiry,
      displayName: member.displayName,
    });

    // DM で届いたなら画面には出さない。この頁は誰でも開けるので、
    // 申し込んだ人が本人とは限らないため。
    // Discord を繋いでいない場合だけ画面に出す。そのときは、
    // 利用者名が実在することもこの頁から分かってしまう。
    return c.html(
      <Layout title="申し込みを受け付けました">
        <h1>申し込みを受け付けました</h1>
        {created.view.deadlocked ? (
          <Notice tone="bad">
            いま承認できるメンバーが他にいません。リカバリコードで復旧してください。
          </Notice>
        ) : (
          <Notice tone="ok">
            他のメンバー {String(created.view.tally.required)} 人の承認で有効になります。
          </Notice>
        )}
        {sent.ok ? (
          <p class="lede">
            引換のリンクは Discord の DM に送りました。承認が集まってからそのリンクを開くと、
            新しいパスワードを決められます。
          </p>
        ) : (
          <>
            <p class="lede">
              下のリンクを控えてください。ここでしか表示されません。承認が集まってから開くと、
              新しいパスワードを決められます。
            </p>
            <section class="panel secret">
              <code>{link}</code>
            </section>
          </>
        )}
      </Layout>,
    );
  });

  app.get('/reset', (c) => {
    const token = c.req.query('token') ?? '';
    const lookup = findUsableTicket(deps.db, 'password_reset', token, Date.now());
    if (!lookup.ok) {
      return c.html(
        <Layout title="パスワードの再設定">
          <h1>まだ使えません</h1>
          <Notice tone="bad">{lookup.reason}</Notice>
        </Layout>,
        400,
      );
    }
    return c.html(<ResetPage token={token} />);
  });

  app.post('/reset', async (c) => {
    const form = await c.req.formData();
    const token = field(form, 'token');
    const lookup = findUsableTicket(deps.db, 'password_reset', token, Date.now());
    if (!lookup.ok) {
      return c.html(
        <Layout title="パスワードの再設定">
          <h1>まだ使えません</h1>
          <Notice tone="bad">{lookup.reason}</Notice>
        </Layout>,
        400,
      );
    }

    const password = field(form, 'password');
    if (password !== field(form, 'confirm')) {
      return c.html(<ResetPage token={token} error="2 つの入力が一致しません" />, 400);
    }

    const result = await setPassword(deps.db, {
      memberId: lookup.ticket.memberId,
      password,
      action: 'password.reset',
    });
    if (!result.ok) return c.html(<ResetPage token={token} error={result.reason} />, 400);

    consumeTicket(deps.db, lookup.ticket.id, Date.now());
    // 古い端末を締め出す。乗っ取られていた場合にそのまま居座られないようにするため。
    destroyAllSessions(deps.db, lookup.ticket.memberId);

    return c.html(
      <Layout title="パスワードを変更しました">
        <h1>パスワードを変更しました</h1>
        <Notice tone="ok">ログインしていた端末はすべて切断されました。</Notice>
        <p class="lede">
          <a class="plain" href="/login">
            ログインする
          </a>
        </p>
      </Layout>,
    );
  });

  return app;
}

function ResetPage({ token, error }: { token: string; error?: string }) {
  return (
    <Layout title="パスワードの再設定">
      <h1>新しいパスワードを決める</h1>
      {error === undefined ? null : <Notice tone="bad">{error}</Notice>}
      <form class="stack" method="post" action="/reset">
        <input type="hidden" name="token" value={token} />
        <Field
          label="新しいパスワード"
          name="password"
          type="password"
          required
          autocomplete="new-password"
          hint="12 文字以上。"
        />
        <Field label="もう一度" name="confirm" type="password" required autocomplete="new-password" />
        <Submit>変更する</Submit>
      </form>
    </Layout>
  );
}

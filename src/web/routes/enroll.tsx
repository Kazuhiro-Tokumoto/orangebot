import { Hono } from 'hono';
import QRCode from 'qrcode';
import { hasPassword, setPassword } from '../../auth/credentials.js';
import { replaceCodes } from '../../auth/recovery.js';
import {
  buildUri,
  confirmSecret,
  generateSecret,
  hasConfirmedTotp,
  loadSecret,
  storeSecret,
} from '../../auth/totp.js';
import { getMember } from '../../db/members.js';
import type { MemberRow } from '../../db/schema.js';
import { activateMember } from '../../domain/members.js';
import { consumeTicket, findUsableTicket } from '../../domain/tickets.js';
import { field, type AppBindings, type RouteDeps } from '../context.js';
import { Field, Notice, SecretBox, Submit } from '../views/forms.js';
import { Layout } from '../views/layout.js';

type Step = 'password' | 'totp' | 'codes';

const STEPS: readonly (readonly [Step, string])[] = [
  ['password', 'パスワードを決める'],
  ['totp', '二要素認証を登録する'],
  ['codes', 'リカバリコードを控える'],
];

function Steps({ current }: { current: Step }) {
  return (
    <ol class="steps">
      {STEPS.map(([key, label]) => (
        <li class={key === current ? 'now' : ''}>{label}</li>
      ))}
    </ol>
  );
}

function InvalidPage({ message }: { message: string }) {
  return (
    <Layout title="登録">
      <h1>登録できません</h1>
      <Notice tone="bad">{message}</Notice>
      <p class="lede">
        リンクの有効期限は 7 日です。切れている場合はメンバーの誰かに発行し直してもらってください。
      </p>
    </Layout>
  );
}

function PasswordPage(props: { token: string; member: MemberRow; error?: string | undefined }) {
  return (
    <Layout title="登録">
      <h1>ようこそ、{props.member.displayName} さん</h1>
      <Steps current="password" />
      {props.error === undefined ? null : <Notice tone="bad">{props.error}</Notice>}
      <form class="stack" method="post" action="/enroll/password">
        <input type="hidden" name="token" value={props.token} />
        <Field label="ユーザー名" name="username" value={props.member.username} />
        <Field
          label="パスワード"
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
        <Submit>次へ</Submit>
      </form>
    </Layout>
  );
}

function TotpPage(props: { token: string; secret: string; qr: string; error?: string | undefined }) {
  return (
    <Layout title="登録">
      <h1>二要素認証を登録する</h1>
      <Steps current="totp" />
      {props.error === undefined ? null : <Notice tone="bad">{props.error}</Notice>}
      <p class="lede">
        認証アプリでこの QR を読み取り、表示された 6 桁を入れてください。
        パスワードだけではログインできない決まりです。
      </p>
      <div class="qr">
        <img src={props.qr} alt="二要素認証の QR コード" />
      </div>
      <p class="field-hint" style="margin:12px 0 22px">
        QR が読めない場合はこの文字列を手で入れてください
        <br />
        <code>{props.secret}</code>
      </p>
      <form class="stack" method="post" action="/enroll/totp">
        <input type="hidden" name="token" value={props.token} />
        <Field
          label="認証アプリの 6 桁"
          name="code"
          required
          inputmode="numeric"
          autocomplete="one-time-code"
          placeholder="123456"
        />
        <Submit>確認する</Submit>
      </form>
    </Layout>
  );
}

function CodesPage(props: { token: string; member: MemberRow; codes: readonly string[] }) {
  return (
    <Layout title="登録">
      <h1>リカバリコード</h1>
      <Steps current="codes" />
      <Notice tone="bad">
        この画面を離れると二度と表示されません。印刷するか、別の場所に書き写してください。
      </Notice>
      <p class="lede">
        メンバーがあなた 1 人しかいない間は、パスワードを忘れても承認してくれる相手がいません。
        そのときはこのコードだけが復旧の手段になります。1 枚につき 1 回使えます。
        この画面を読み込み直すと新しい組に置き換わり、上に出ているものが無効になります。
      </p>
      <SecretBox label={`${props.member.displayName} さんのリカバリコード`} values={props.codes} />
      <form class="stack" method="post" action="/enroll/finish">
        <input type="hidden" name="token" value={props.token} />
        <Submit>控えました。登録を終える</Submit>
      </form>
    </Layout>
  );
}

/**
 * 登録。
 *
 * 進み具合は DB の状態から決める。パスワードが無ければ手順 1、
 * 二要素が未確認なら手順 2、どちらも済んでいれば手順 3。
 * 途中で閉じても同じリンクから続きに戻れる。
 */
export function enrollRoutes(deps: RouteDeps) {
  const app = new Hono<AppBindings>();

  type Resolved =
    | { readonly ok: true; readonly member: MemberRow; readonly ticketId: string }
    | { readonly ok: false; readonly reason: string };

  function resolve(token: string): Resolved {
    if (token === '') return { ok: false, reason: 'リンクが正しくありません' };

    const lookup = findUsableTicket(deps.db, 'enroll', token, Date.now());
    if (!lookup.ok) return { ok: false, reason: lookup.reason };

    const member = getMember(deps.db, lookup.ticket.memberId);
    if (member === undefined) return { ok: false, reason: 'メンバーが見つかりません' };
    return { ok: true, member, ticketId: lookup.ticket.id };
  }

  function stepOf(memberId: string): Step {
    if (!hasPassword(deps.db, memberId)) return 'password';
    if (!hasConfirmedTotp(deps.db, memberId)) return 'totp';
    return 'codes';
  }

  /**
   * 未確認の秘密鍵があれば使い回す。画面を開き直すたびに作り直すと、
   * 認証アプリ側に使えない項目が積み上がってしまう。
   */
  async function totpView(token: string, member: MemberRow, error?: string) {
    let stored = loadSecret(deps.db, member.id, deps.env.encryptionKey);
    if (stored === undefined || stored.confirmed) {
      const secret = generateSecret();
      storeSecret(deps.db, {
        memberId: member.id,
        secret,
        key: deps.env.encryptionKey,
        confirmed: false,
      });
      stored = { secret, confirmed: false };
    }

    const uri = buildUri({
      secret: stored.secret,
      username: member.username,
      issuer: deps.env.rpName,
    });
    const qr = await QRCode.toDataURL(uri, { margin: 0, width: 380 });
    return <TotpPage token={token} secret={stored.secret} qr={qr} error={error} />;
  }

  app.get('/enroll', async (c) => {
    const token = c.req.query('token') ?? '';
    const found = resolve(token);
    if (!found.ok) return c.html(<InvalidPage message={found.reason} />, 400);

    const step = stepOf(found.member.id);
    if (step === 'password') return c.html(<PasswordPage token={token} member={found.member} />);
    if (step === 'totp') return c.html(await totpView(token, found.member));

    const codes = replaceCodes(deps.db, { memberId: found.member.id });
    return c.html(<CodesPage token={token} member={found.member} codes={codes} />);
  });

  app.post('/enroll/password', async (c) => {
    const form = await c.req.formData();
    const token = field(form, 'token');
    const found = resolve(token);
    if (!found.ok) return c.html(<InvalidPage message={found.reason} />, 400);

    const password = field(form, 'password');
    if (password !== field(form, 'confirm')) {
      return c.html(
        <PasswordPage token={token} member={found.member} error="2 つの入力が一致しません" />,
        400,
      );
    }

    const result = await setPassword(deps.db, {
      memberId: found.member.id,
      password,
      action: 'password.enrolled',
    });
    if (!result.ok) {
      return c.html(
        <PasswordPage token={token} member={found.member} error={result.reason} />,
        400,
      );
    }

    return c.redirect(`/enroll?token=${encodeURIComponent(token)}`);
  });

  app.post('/enroll/totp', async (c) => {
    const form = await c.req.formData();
    const token = field(form, 'token');
    const found = resolve(token);
    if (!found.ok) return c.html(<InvalidPage message={found.reason} />, 400);

    const confirmed = confirmSecret(deps.db, {
      memberId: found.member.id,
      code: field(form, 'code'),
      key: deps.env.encryptionKey,
    });
    if (!confirmed) {
      const view = await totpView(
        token,
        found.member,
        '符号が合いません。表示されている 6 桁をもう一度入れてください',
      );
      return c.html(view, 400);
    }

    return c.redirect(`/enroll?token=${encodeURIComponent(token)}`);
  });

  /** リカバリコードを見たことを確かめてから、初めて有効なメンバーにする。 */
  app.post('/enroll/finish', async (c) => {
    const form = await c.req.formData();
    const token = field(form, 'token');
    const found = resolve(token);
    if (!found.ok) return c.html(<InvalidPage message={found.reason} />, 400);

    if (stepOf(found.member.id) !== 'codes') {
      return c.redirect(`/enroll?token=${encodeURIComponent(token)}`);
    }

    activateMember(deps.db, found.member.id);
    consumeTicket(deps.db, found.ticketId, Date.now());

    return c.html(
      <Layout title="登録が完了しました">
        <h1>登録が完了しました</h1>
        <Notice tone="ok">
          {found.member.displayName} さんは有効なメンバーになりました。提案と投票ができます。
        </Notice>
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

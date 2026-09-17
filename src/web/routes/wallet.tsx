import { Hono, type Context } from 'hono';
import type { OagSendRow, WalletRow } from '../../db/schema.js';
import { createProposal, listProposals, type ProposalView } from '../../domain/proposals.js';
import { formatUnits } from '../../domain/units.js';
import { formatOag } from '../../wallet/amount.js';
import { readWalletStatus, type WalletStatus } from '../../wallet/balance.js';
import { CHANGE_RECEIVE, GAP_LIMIT, MAINNET_COIN_TYPE_PENDING } from '../../wallet/seed.js';
import { executeSend, getSendForProposal, listSends } from '../../wallet/send.js';
import { addressesOf, createWallet, getWallet, issueReceiveAddress } from '../../wallet/store.js';
import { field, requireFullSession, type AppBindings, type RouteDeps } from '../context.js';
import { Field, Notice, SecretBox, Submit } from '../views/forms.js';
import { Layout } from '../views/layout.js';

function when(ms: number): string {
  return new Date(ms).toLocaleString('ja-JP', { hour12: false });
}

/**
 * mainnet の coin_type 1033 はまだ SLIP-0044 に受理されていない。
 * 別の番号で通ると、同じ控えから導かれる鍵がすべて変わる。
 * 利用者から見れば資金が消えたのと区別が付かないので、画面でも言っておく。
 */
function CoinTypeWarning({ network }: { network: string }) {
  if (network !== 'mainnet' || !MAINNET_COIN_TYPE_PENDING) return null;
  return (
    <Notice tone="bad">
      mainnet の coin_type（1033）はまだ確定していません。別の番号で受理されると、
      同じ控えから導かれる住所がすべて変わります。確定するまで、ここの住所に資金を入れないでください。
    </Notice>
  );
}

/** まだウォレットが無いときの画面。 */
function SetupPage(props: {
  readonly viewer: string;
  readonly network: string;
  readonly nodeConfigured: boolean;
  readonly error?: string | undefined;
}) {
  return (
    <Layout title="ウォレット" viewer={props.viewer}>
      <h1>ウォレットを作る</h1>
      <p class="lede">
        組織の OAG ウォレットはひとつだけです。作ると 12 語の控えが一度だけ表示されます。
      </p>

      <CoinTypeWarning network={props.network} />
      {props.error === undefined ? null : <Notice tone="bad">{props.error}</Notice>}
      {props.nodeConfigured ? null : (
        <Notice tone="warn">
          OAG ノードの設定がありません。ウォレットは作れますが、残高は出ません。
        </Notice>
      )}

      <section class="panel">
        <p class="field-hint" style="margin:0 0 14px">
          パスフレーズは控えを封じる鍵です。送金のときだけ必要になり、残高を見るだけなら要りません。
          忘れると控えを取り出せなくなり、紙に控えた 12 語だけが頼りになります。
        </p>
        <p class="field-hint" style="margin:0 0 14px">
          ネットワークは <code>{props.network}</code> です。`.env` の <code>OAG_NETWORK</code> で決まります。
        </p>
        <form class="stack" method="post" action="/wallet/create">
          <Field
            label="パスフレーズ"
            name="passphrase"
            type="password"
            required
            autocomplete="new-password"
            hint="8 文字以上。ログインのパスワードとは別のものにしてください。"
          />
          <Field
            label="もう一度"
            name="confirm"
            type="password"
            required
            autocomplete="new-password"
          />
          <Submit>作る</Submit>
        </form>
      </section>
    </Layout>
  );
}

/** 控えを一度だけ見せる画面。 */
function MnemonicPage({ viewer, mnemonic }: { viewer: string; mnemonic: string }) {
  const words = mnemonic.split(' ').map((word, index) => `${String(index + 1)}. ${word}`);

  return (
    <Layout title="ウォレットの控え" viewer={viewer}>
      <h1>12 語の控え</h1>
      <Notice tone="bad">
        この画面を離れると二度と表示されません。紙に書き写して、金庫のような場所に置いてください。
      </Notice>
      <p class="lede">
        この 12 語があれば、ポータルが壊れてもどこからでも資金を取り戻せます。
        逆に、これを見た人は誰でも資金を動かせます。写真に撮って端末に残さないでください。
      </p>
      <SecretBox label="控え" values={words} />
      <p class="lede">
        <a class="plain" href="/wallet">
          控えました。ウォレットへ
        </a>
      </p>
    </Layout>
  );
}

function StatusBanner({ status }: { status: WalletStatus }) {
  if (status.connected && !status.truncated) {
    return (
      <Notice tone="ok">
        ノードに繋がっています。高さ {String(status.height ?? 0)}。
      </Notice>
    );
  }
  if (status.truncated) {
    return (
      <Notice tone="bad">
        ノードが数え切れず、応答が途中で打ち切られました。残高は出せません。
      </Notice>
    );
  }
  return <Notice tone="warn">ノードに繋がりません。{status.error ?? ''}</Notice>;
}

interface ApprovedSend {
  readonly proposal: ProposalView;
  readonly send: OagSendRow | undefined;
}

const SEND_LABEL: Readonly<Record<OagSendRow['status'], string>> = {
  signed: '署名済み',
  broadcast: '送信済み',
  unknown: '届いたか不明',
  failed: 'ノードが拒否',
};

const SEND_TONE: Readonly<Record<OagSendRow['status'], string>> = {
  signed: 'warn',
  broadcast: 'ok',
  unknown: 'warn',
  failed: 'bad',
};

/** 可決した送金 1 件。まだ送り終えていなければパスフレーズの欄を出す。 */
function ApprovedSendCard({ item }: { item: ApprovedSend }) {
  const payload = item.proposal.payload;
  const to = typeof payload['to'] === 'string' ? payload['to'] : '';
  const amount = typeof payload['amount'] === 'string' ? BigInt(payload['amount']) : 0n;
  const memo = typeof payload['memo'] === 'string' ? payload['memo'] : '';
  const rebuild = item.send === undefined || item.send.status === 'failed';

  return (
    <section class="panel">
      <div class="row" style="justify-content:space-between">
        <strong>{formatUnits(amount)} OAG</strong>
        {item.send === undefined ? (
          <span class="tag accent">未送信</span>
        ) : (
          <span class={`tag ${SEND_TONE[item.send.status]}`}>{SEND_LABEL[item.send.status]}</span>
        )}
      </div>
      <p class="field-hint" style="margin:6px 0 12px">
        宛先 <span class="mono">{to}</span>
        {memo === '' ? null : ` ・ ${memo}`}
      </p>

      {item.send === undefined ? null : (
        <p class="field-hint mono" style="margin:0 0 12px">
          txid {item.send.txid} ・ 手数料 {formatUnits(BigInt(item.send.fee))} OAG
          {item.send.error === null ? null : (
            <>
              <br />
              <span class="bad-text">{item.send.error}</span>
            </>
          )}
        </p>
      )}

      <form class="row" method="post" action={`/wallet/send/${item.proposal.id}`}>
        <input
          class="input"
          name="passphrase"
          type="password"
          required
          autocomplete="off"
          placeholder="ウォレットのパスフレーズ"
          style="max-width:18em"
        />
        <button class="btn" type="submit">
          {rebuild ? '署名して送る' : '同じ取引を送り直す'}
        </button>
      </form>
    </section>
  );
}

function WalletPage(props: {
  readonly viewer: string;
  readonly wallet: WalletRow;
  readonly status: WalletStatus;
  readonly addresses: readonly { readonly index: number; readonly address: string }[];
  readonly approved: readonly ApprovedSend[];
  readonly history: readonly OagSendRow[];
  readonly notice?: string | undefined;
  readonly error?: string | undefined;
}) {
  const prefix =
    props.wallet.network === 'mainnet' ? 'oag' : props.wallet.network === 'testnet' ? 'toag' : 'roag';

  return (
    <Layout title="ウォレット" viewer={props.viewer}>
      <h1>ウォレット</h1>
      <p class="lede">
        {props.wallet.network} ・ 作成 {when(props.wallet.createdAt)}
      </p>

      <CoinTypeWarning network={props.wallet.network} />
      {props.error === undefined ? null : <Notice tone="bad">{props.error}</Notice>}
      {props.notice === undefined ? null : <Notice tone="ok">{props.notice}</Notice>}
      <StatusBanner status={props.status} />

      <div class="grid">
        <div class="stat">
          <div class="k">残高</div>
          <div class="big">
            {props.status.balance === undefined ? '—' : formatOag(props.status.balance)}
          </div>
          <div class="k">OAG</div>
        </div>
        <div class="stat">
          <div class="k">未使用の出力</div>
          <div class="big">{props.status.utxoCount === undefined ? '—' : String(props.status.utxoCount)}</div>
        </div>
        <div class="stat">
          <div class="k">配った受取住所</div>
          <div class="big">{String(props.wallet.nextReceive)}</div>
        </div>
      </div>

      <h2>受取住所</h2>
      <section class="panel">
        <p class="field-hint" style="margin:0 0 14px">
          住所は使い回さず、受け取るたびに新しいものを配ります。
          過去のものも生きているので、古い住所に届いた分もそのまま数えます。
        </p>
        <form method="post" action="/wallet/address">
          <button class="btn" type="submit">
            新しい受取住所を出す
          </button>
        </form>
        {props.addresses.length === 0 ? null : (
          <div class="scroll" style="margin-top:14px">
            <table>
              <tr>
                <th>番号</th>
                <th>住所</th>
              </tr>
              {props.addresses.map((entry) => (
                <tr>
                  <td class="muted">{String(entry.index)}</td>
                  <td class="mono">{entry.address}</td>
                </tr>
              ))}
            </table>
          </div>
        )}
      </section>

      <h2>送金を提案する</h2>
      <section class="panel">
        <p class="field-hint" style="margin:0 0 14px">
          組織の資金なので、送金も過半数の承認を経ます。可決したら、パスフレーズを知っている
          メンバーが下の一覧から送ります。手数料はノードの最低料率で、送るときに決まります。
        </p>
        <form class="stack" method="post" action="/wallet/propose">
          <Field label="宛先の住所" name="to" required placeholder={`${prefix}1...`} />
          <Field
            label="送る額 (OAG)"
            name="amount"
            required
            inputmode="decimal"
            placeholder="1.5"
            hint="0.0015 以上。小数は 16 桁まで。"
          />
          <Field label="理由" name="memo" hint="提案の一覧と監査ログに残ります。" />
          <Submit>この内容で提案する</Submit>
        </form>
      </section>

      <h2>可決した送金</h2>
      {props.approved.length === 0 ? (
        <section class="panel">
          <span class="muted">送るのを待っているものはありません。</span>
        </section>
      ) : (
        props.approved.map((item) => <ApprovedSendCard item={item} />)
      )}

      <h2>送金の履歴</h2>
      <section class="panel">
        {props.history.length === 0 ? (
          <span class="muted">まだ送っていません。</span>
        ) : (
          <div class="scroll">
            <table>
              <tr>
                <th>日時</th>
                <th>宛先</th>
                <th>額</th>
                <th>手数料</th>
                <th>状態</th>
                <th>txid</th>
              </tr>
              {props.history.map((row) => (
                <tr>
                  <td>{when(row.createdAt)}</td>
                  <td class="mono">{row.toAddress}</td>
                  <td class="mono">{formatUnits(BigInt(row.amount))}</td>
                  <td class="mono">{formatUnits(BigInt(row.fee))}</td>
                  <td>
                    <span class={`tag ${SEND_TONE[row.status]}`}>{SEND_LABEL[row.status]}</span>
                  </td>
                  <td class="mono muted">{row.txid}</td>
                </tr>
              ))}
            </table>
          </div>
        )}
      </section>

      <h2>控え</h2>
      <section class="panel">
        <p class="field-hint" style="margin:0">
          12 語の控えはパスフレーズで封じた形で保管されています。ここから取り出す口は置いていません。
          残高を見るのに秘密は要らず、口座の拡張公開鍵だけで住所を作っています。
          見張っているのは、配った先 {String(GAP_LIMIT)} 個までの受取住所とお釣り住所です。
        </p>
      </section>
    </Layout>
  );
}

export function walletRoutes(deps: RouteDeps) {
  const app = new Hono<AppBindings>();
  app.use('/wallet', requireFullSession());
  app.use('/wallet/*', requireFullSession());

  const network = deps.env.oag?.network ?? 'mainnet';

  async function render(c: Context<AppBindings>, notice?: string, error?: string) {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const wallet = getWallet(deps.db);
    if (wallet === undefined) {
      return c.html(
        <SetupPage
          viewer={viewer.member.displayName}
          network={network}
          nodeConfigured={deps.env.oag !== undefined}
          error={error}
        />,
        error === undefined ? 200 : 400,
      );
    }

    // 配った住所だけを出す。まだ配っていない先の住所を並べても意味がない。
    const addresses = addressesOf(wallet, {
      change: CHANGE_RECEIVE,
      count: wallet.nextReceive,
    }).slice(-20);

    // 可決した送金のうち、まだ送り終えていないもの。送り終えたものは履歴に出る。
    const approved = listProposals(deps.db, { status: 'executed' })
      .filter((proposal) => proposal.type === 'wallet.send')
      .map((proposal) => ({ proposal, send: getSendForProposal(deps.db, proposal.id) }))
      .filter((item) => item.send?.status !== 'broadcast');

    return c.html(
      <WalletPage
        viewer={viewer.member.displayName}
        wallet={wallet}
        status={await readWalletStatus(deps.db, deps.rpc)}
        addresses={addresses.reverse()}
        approved={approved}
        history={listSends(deps.db)}
        notice={notice}
        error={error}
      />,
      error === undefined ? 200 : 400,
    );
  }

  app.get('/wallet', (c) => render(c));

  app.post('/wallet/create', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const passphrase = field(form, 'passphrase');
    if (passphrase !== field(form, 'confirm')) return render(c, undefined, '2 つの入力が一致しません');

    const created = await createWallet(deps.db, {
      network,
      passphrase,
      actorMemberId: viewer.member.id,
    });
    if (!created.ok) return render(c, undefined, created.reason);

    return c.html(
      <MnemonicPage viewer={viewer.member.displayName} mnemonic={created.mnemonic} />,
    );
  });

  app.post('/wallet/address', (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const issued = issueReceiveAddress(deps.db, { actorMemberId: viewer.member.id });
    if ('ok' in issued) return render(c, undefined, issued.reason);

    return render(c, `新しい受取住所を出しました: ${issued.address}`);
  });

  app.post('/wallet/propose', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const result = createProposal(deps.db, {
      type: 'wallet.send',
      proposedBy: viewer.member.id,
      payload: {
        to: field(form, 'to'),
        amount: field(form, 'amount'),
        memo: field(form, 'memo'),
      },
    });
    if (!result.ok) return render(c, undefined, result.reason);

    deps.notify.announce(result.view, viewer.member.displayName);
    return render(
      c,
      result.view.status === 'executed'
        ? '可決しました。下の一覧からパスフレーズを入れて送ってください。'
        : '送金を提案しました。過半数の承認が集まると送れるようになります。',
    );
  });

  /**
   * 署名して送る。
   * パスフレーズの確認と鍵の導出で 1 秒ほどかかる。二度押しされても、
   * 同じ提案からは同じ取引しか出ない (wallet/send.ts)。
   */
  app.post('/wallet/send/:proposalId', async (c) => {
    const viewer = c.get('viewer');
    if (viewer === undefined) return c.redirect('/login');

    const form = await c.req.formData();
    const result = await executeSend(deps.db, deps.rpc, {
      proposalId: c.req.param('proposalId'),
      passphrase: field(form, 'passphrase'),
      actorMemberId: viewer.member.id,
    });
    if (!result.ok) return render(c, undefined, result.reason);

    return render(
      c,
      `${result.rebroadcast ? '送り直しました' : '送りました'}。txid ${result.send.txid}。` +
        '受け取る側には、承認が 10 回付くまで確定として扱わないよう伝えてください。',
    );
  });

  return app;
}

import type { StoredAuditRow } from '../../domain/audit.js';
import type { ChainVerification } from '../../domain/audit.js';
import { PROPOSAL_TYPE_LABELS } from '../../domain/governance.js';
import type { ProposalView } from '../../domain/proposals.js';
import type { MemberRow } from '../../db/schema.js';

const STATUS_LABELS: Record<string, string> = {
  open: '審議中',
  approved: '可決',
  rejected: '否決',
  executed: '実行済み',
  expired: '期限切れ',
  cancelled: '取り消し',
  pending: '登録待ち',
  active: '有効',
  suspended: '停止中',
  removed: '除名済み',
};

const STATUS_TONE: Record<string, string> = {
  open: 'accent',
  approved: 'ok',
  executed: 'ok',
  active: 'ok',
  rejected: 'bad',
  removed: 'bad',
  expired: 'warn',
  suspended: 'warn',
  pending: 'warn',
  cancelled: '',
};

function when(ms: number): string {
  return new Date(ms).toLocaleString('ja-JP', { hour12: false });
}

function Tag({ value }: { value: string }) {
  const tone = STATUS_TONE[value] ?? '';
  return <span class={`tag ${tone}`}>{STATUS_LABELS[value] ?? value}</span>;
}

export interface StatusPageProps {
  readonly members: readonly MemberRow[];
  readonly proposals: readonly ProposalView[];
  readonly audit: readonly StoredAuditRow[];
  readonly chain: ChainVerification;
  readonly wallet: WalletSummary;
  readonly generatedAt: number;
}

export interface WalletSummary {
  /** 内部台帳の発行済み BOAG。 */
  readonly issuedBoag: string;
  /** 台帳に不整合があればその旨。無ければ空。 */
  readonly ledgerNote: string;
  /** OAG ノードに繋がっているか。 */
  readonly connected: boolean;
  /** 繋がっていないときの理由。 */
  readonly note: string;
  readonly balanceOag: string | undefined;
  readonly height: number | undefined;
}

export function StatusPage(props: StatusPageProps) {
  const active = props.members.filter((m) => m.status === 'active');
  const required = Math.floor(active.length / 2) + 1;
  const open = props.proposals.filter((p) => p.status === 'open');

  return (
    <>
      <h1>状態</h1>
      <p class="lede">誰でも見られる読み取り専用の画面です。ここから操作はできません。</p>

      {props.chain.ok ? (
        <div class="banner ok">監査ログの連鎖は健全です（{String(props.chain.length)} 行）</div>
      ) : (
        <div class="banner bad">
          監査ログが壊れています。seq {String(props.chain.brokenAt)}: {props.chain.reason}
        </div>
      )}

      <div class="grid">
        <div class="stat">
          <div class="k">有効なメンバー</div>
          <div class="big">{String(active.length)}</div>
        </div>
        <div class="stat">
          <div class="k">可決に必要な票数</div>
          <div class="big">{String(required)}</div>
        </div>
        <div class="stat">
          <div class="k">審議中の提案</div>
          <div class="big">{String(open.length)}</div>
        </div>
        <div class="stat">
          <div class="k">発行済み BOAG</div>
          <div class="big">{props.wallet.issuedBoag}</div>
          <div class="k">{props.wallet.ledgerNote}</div>
        </div>
        <div class="stat">
          <div class="k">OAG の残高</div>
          <div class="big">{props.wallet.balanceOag ?? '—'}</div>
          <div class="k">
            {props.wallet.connected
              ? `ブロック ${String(props.wallet.height ?? 0)}`
              : props.wallet.note}
          </div>
        </div>
      </div>

      <h2>メンバー</h2>
      <section class="panel scroll">
        <table>
          <thead>
            <tr>
              <th>表示名</th>
              <th>ユーザー名</th>
              <th>状態</th>
              <th>Discord ID</th>
              <th>参加</th>
            </tr>
          </thead>
          <tbody>
            {props.members.length === 0 ? (
              <tr>
                <td colspan={5} class="muted">
                  まだ誰もいません
                </td>
              </tr>
            ) : (
              props.members.map((m) => (
                <tr>
                  <td>{m.displayName}</td>
                  <td class="mono">{m.username}</td>
                  <td>
                    <Tag value={m.status} />
                  </td>
                  <td class="mono muted">{m.id}</td>
                  <td class="muted">{when(m.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <h2>提案</h2>
      <section class="panel scroll">
        <table>
          <thead>
            <tr>
              <th>内容</th>
              <th>種類</th>
              <th>状態</th>
              <th>賛成 / 必要</th>
              <th>作成</th>
            </tr>
          </thead>
          <tbody>
            {props.proposals.length === 0 ? (
              <tr>
                <td colspan={5} class="muted">
                  まだ提案はありません
                </td>
              </tr>
            ) : (
              props.proposals.map((p) => (
                <tr>
                  <td>
                    {p.summary}
                    {p.deadlocked ? (
                      <>
                        {' '}
                        <span class="tag bad">承認者不在</span>
                      </>
                    ) : null}
                  </td>
                  <td class="muted">{PROPOSAL_TYPE_LABELS[p.type]}</td>
                  <td>
                    <Tag value={p.status} />
                  </td>
                  <td class="mono">
                    {String(p.tally.approvals)} / {String(p.tally.required)}
                    {p.tally.rejections > 0 ? (
                      <span class="muted"> （反対 {String(p.tally.rejections)}）</span>
                    ) : null}
                  </td>
                  <td class="muted">{when(p.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <h2>監査ログ</h2>
      <p class="lede">
        追記専用です。各行が直前の行のハッシュを取り込んでいるので、過去を書き換えると連鎖が切れます。
      </p>
      <section class="panel scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>日時</th>
              <th>操作</th>
              <th>実行者</th>
              <th>詳細</th>
              <th>ハッシュ</th>
            </tr>
          </thead>
          <tbody>
            {props.audit.length === 0 ? (
              <tr>
                <td colspan={6} class="muted">
                  まだ記録がありません
                </td>
              </tr>
            ) : (
              props.audit.map((row) => (
                <tr>
                  <td class="mono muted">{String(row.seq)}</td>
                  <td class="muted">{when(row.at)}</td>
                  <td class="mono">{row.action}</td>
                  <td class="mono muted">{row.actorMemberId ?? 'システム'}</td>
                  <td class="mono muted">{JSON.stringify(row.detail)}</td>
                  <td class="mono muted">{row.hash.slice(0, 12)}…</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <footer class="foot">生成 {when(props.generatedAt)}</footer>
    </>
  );
}

import type { Client } from 'discord.js';
import { PROPOSAL_TYPE_LABELS } from '../domain/governance.js';
import type { ProposalView } from '../domain/proposals.js';
import { logger } from '../logger.js';

/**
 * Discord への通知。
 *
 * bot は送る側だけを受け持つ。投票も設定も Web でしか行えないので、
 * 受け取った文字列で何かが動くことはない。届かなくても議事は進む。
 *
 * 送り先は 2 つ。
 *   チャンネル … 提案の開始と決着。メンバー全員が見る。
 *   DM        … 本人だけが持つべきリンク。登録リンクとパスワードの引換リンク。
 */

export type LinkKind = 'enroll' | 'password_reset';

export interface LinkMessage {
  /** 宛先。メンバー ID は Discord のユーザー ID そのもの。 */
  readonly discordId: string;
  readonly kind: LinkKind;
  readonly url: string;
  readonly expiresAt: number;
  readonly displayName: string;
}

export type DeliveryResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface Notifier {
  /** DM を送れる状態か。送れないなら画面にリンクを出す必要がある。 */
  readonly canDeliver: boolean;
  /** 提案の状態をチャンネルに流す。結果は待たない。 */
  announce(view: ProposalView, proposerName?: string): void;
  /** 本人にリンクを届ける。送れたかどうかを返す。 */
  deliverLink(message: LinkMessage): Promise<DeliveryResult>;
}

/** 実際の送信口。discord.js をここだけに閉じ込めて、組み立ての部分を試せるようにする。 */
export interface Transport {
  readonly hasChannel: boolean;
  sendChannel(content: string): Promise<void>;
  sendDirect(discordId: string, content: string): Promise<void>;
}

function day(ms: number): string {
  return new Date(ms).toLocaleString('ja-JP', { hour12: false });
}

/** 提案 1 件を人が読む文にする。投票は Web でしかできないので、必ず場所を添える。 */
export function proposalMessage(
  view: ProposalView,
  input: { readonly webOrigin: string; readonly proposerName?: string | undefined },
): string {
  const label = PROPOSAL_TYPE_LABELS[view.type];
  const lines: string[] = [];

  if (view.status === 'open') {
    lines.push(`**[新しい提案]** ${label}`);
  } else if (view.status === 'executed' || view.status === 'approved') {
    lines.push(`**[可決]** ${label}`);
  } else if (view.status === 'rejected') {
    lines.push(`**[否決]** ${label}`);
  } else if (view.status === 'expired') {
    lines.push(`**[期限切れ]** ${label}`);
  } else {
    lines.push(`**[取り下げ]** ${label}`);
  }

  lines.push(`> ${view.summary}`);
  if (input.proposerName !== undefined) lines.push(`提案者: ${input.proposerName}`);
  lines.push(
    `賛成 ${String(view.tally.approvals)} / 必要 ${String(view.tally.required)}` +
      (view.tally.rejections > 0 ? ` ・ 反対 ${String(view.tally.rejections)}` : ''),
  );

  if (view.status === 'open') {
    if (view.deadlocked) {
      lines.push('利害関係のない有権者がいないため、承認では決着しません。');
    } else {
      lines.push(`期限 ${day(view.expiresAt)}`);
    }
    lines.push(`投票はこちら → ${input.webOrigin}/proposals`);
  }

  return lines.join('\n');
}

export function linkMessage(message: LinkMessage): string {
  const until = `このリンクは ${day(message.expiresAt)} まで有効です。`;

  if (message.kind === 'enroll') {
    return [
      '**orangebot の登録リンク**',
      `${message.displayName} さん、下のリンクからパスワードと二要素認証を設定してください。`,
      message.url,
      until,
      '**このリンクは他の人に渡さないでください。** 誰かに教えると、その人があなたとしてログインできます。',
    ].join('\n');
  }

  return [
    '**パスワード再発行の引換リンク**',
    'このリンクは、他のメンバーの過半数が承認した時点で使えるようになります。',
    message.url,
    '承認されてから 7 日の間だけ使えます。',
    '**心当たりが無い場合は開かないでください。** 誰かがあなたの名前で申し込んだ可能性があります。',
  ].join('\n');
}

/** Discord を設定していないときの受け皿。何も送らないが、呼び出し側は同じように書ける。 */
export const nullNotifier: Notifier = {
  canDeliver: false,
  announce: () => undefined,
  deliverLink: () =>
    Promise.resolve({ ok: false, reason: 'Discord の設定が無いので DM を送れません' }),
};

export function createNotifier(transport: Transport, webOrigin: string): Notifier {
  return {
    canDeliver: true,

    announce(view, proposerName) {
      if (!transport.hasChannel) return;
      // 画面の応答を Discord の都合で遅らせない。失敗しても記録だけ残す。
      void transport
        .sendChannel(proposalMessage(view, { webOrigin, proposerName }))
        .catch((error: unknown) => {
          logger.error('提案の通知を送れませんでした', error);
        });
    },

    async deliverLink(message) {
      try {
        await transport.sendDirect(message.discordId, linkMessage(message));
        return { ok: true };
      } catch (error: unknown) {
        logger.error('DM を送れませんでした', error);
        return {
          ok: false,
          reason: 'DM を送れませんでした。相手が DM を閉じている可能性があります',
        };
      }
    },
  };
}

/** discord.js の client を送信口にする。 */
export function discordTransport(client: Client, channelId: string | undefined): Transport {
  return {
    hasChannel: channelId !== undefined,

    async sendChannel(content) {
      if (channelId === undefined) return;
      const channel = await client.channels.fetch(channelId);
      if (channel === null || !channel.isSendable()) {
        throw new Error(`チャンネル ${channelId} に投稿できません`);
      }
      await channel.send(content);
    },

    async sendDirect(discordId, content) {
      const user = await client.users.fetch(discordId);
      await user.send(content);
    },
  };
}

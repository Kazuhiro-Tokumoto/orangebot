import { describe, expect, it, vi } from 'vitest';
import type { ProposalView } from '../domain/proposals.js';
import {
  createNotifier,
  linkMessage,
  nullNotifier,
  proposalMessage,
  type Transport,
} from './notify.js';

const T0 = 1_700_000_000_000;
const ORIGIN = 'https://mail.shudo-physics.com';

function view(overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    id: 'p1',
    type: 'member.add',
    status: 'open',
    summary: 'ブラボー（bravo）をメンバーに加える',
    payload: {},
    proposedBy: '1529717434259345489',
    subjectMemberId: null,
    createdAt: T0,
    expiresAt: T0 + 7 * 24 * 60 * 60 * 1000,
    decidedAt: null,
    executedAt: null,
    deadlocked: false,
    votes: [],
    ...overrides,
    tally: {
      eligible: ['1529717434259345489'],
      electorateSize: 2,
      required: 2,
      approvals: 1,
      rejections: 0,
      outstanding: 1,
      outcome: 'open',
      ...overrides.tally,
    },
  };
}

/** 送った内容を控えるだけの送信口。 */
function fakeTransport(options: { hasChannel?: boolean; fail?: boolean } = {}) {
  const channel: string[] = [];
  const direct: { discordId: string; content: string }[] = [];

  const transport: Transport = {
    hasChannel: options.hasChannel ?? true,
    sendChannel: (content) => {
      if (options.fail === true) return Promise.reject(new Error('落ちている'));
      channel.push(content);
      return Promise.resolve();
    },
    sendDirect: (discordId, content) => {
      if (options.fail === true) return Promise.reject(new Error('DM を閉じている'));
      direct.push({ discordId, content });
      return Promise.resolve();
    },
  };

  return { transport, channel, direct };
}

describe('提案の文', () => {
  it('審議中なら投票の場所を必ず添える', () => {
    const text = proposalMessage(view(), { webOrigin: ORIGIN, proposerName: 'トクモト' });

    expect(text).toContain('新しい提案');
    expect(text).toContain('メンバーの追加');
    expect(text).toContain('ブラボー');
    expect(text).toContain('提案者: トクモト');
    expect(text).toContain('賛成 1 / 必要 2');
    expect(text).toContain(`${ORIGIN}/proposals`);
  });

  it('決着した提案には投票の場所を載せない', () => {
    const text = proposalMessage(
      view({ status: 'executed', decidedAt: T0, executedAt: T0 }),
      { webOrigin: ORIGIN },
    );

    expect(text).toContain('可決');
    expect(text).not.toContain('/proposals');
    expect(text).not.toContain('提案者');
  });

  it('否決と期限切れを言い分ける', () => {
    expect(proposalMessage(view({ status: 'rejected' }), { webOrigin: ORIGIN })).toContain('否決');
    expect(proposalMessage(view({ status: 'expired' }), { webOrigin: ORIGIN })).toContain(
      '期限切れ',
    );
  });

  it('反対票があるときだけその数を出す', () => {
    expect(proposalMessage(view(), { webOrigin: ORIGIN })).not.toContain('反対');
    expect(
      proposalMessage(view({ tally: { ...view().tally, rejections: 1 } }), { webOrigin: ORIGIN }),
    ).toContain('反対 1');
  });

  it('承認者がいない提案はその旨を書く', () => {
    const text = proposalMessage(view({ deadlocked: true }), { webOrigin: ORIGIN });
    expect(text).toContain('承認では決着しません');
  });
});

describe('リンクの文', () => {
  it('登録リンクには期限と、渡すなという注意を入れる', () => {
    const text = linkMessage({
      discordId: '1529717434259345489',
      kind: 'enroll',
      url: `${ORIGIN}/enroll?token=abc`,
      expiresAt: T0,
      displayName: 'トクモト',
    });

    expect(text).toContain('トクモト さん');
    expect(text).toContain(`${ORIGIN}/enroll?token=abc`);
    expect(text).toContain('他の人に渡さないでください');
  });

  it('再発行のリンクには、承認が要ることと心当たりの確認を入れる', () => {
    const text = linkMessage({
      discordId: '1529717434259345489',
      kind: 'password_reset',
      url: `${ORIGIN}/reset?token=abc`,
      expiresAt: T0,
      displayName: 'トクモト',
    });

    expect(text).toContain('過半数が承認した時点');
    expect(text).toContain('心当たりが無い場合は開かないでください');
  });
});

describe('通知', () => {
  it('チャンネルに提案を流す', () => {
    const { transport, channel } = fakeTransport();
    createNotifier(transport, ORIGIN).announce(view(), 'トクモト');

    expect(channel).toHaveLength(1);
    expect(channel[0]).toContain('新しい提案');
  });

  it('チャンネルが未設定なら何も送らない', () => {
    const { transport, channel } = fakeTransport({ hasChannel: false });
    createNotifier(transport, ORIGIN).announce(view());

    expect(channel).toHaveLength(0);
  });

  it('送れなくても呼び出し側は止まらない', async () => {
    const { transport } = fakeTransport({ fail: true });
    const notifier = createNotifier(transport, ORIGIN);

    expect(() => {
      notifier.announce(view());
    }).not.toThrow();

    // 投げ捨てた promise の後始末が終わるのを待つ。
    await vi.waitFor(() => undefined);
  });

  it('DM は届いたかどうかを返す', async () => {
    const { transport, direct } = fakeTransport();
    const message = {
      discordId: '1529717434259345489',
      kind: 'enroll',
      url: `${ORIGIN}/enroll?token=abc`,
      expiresAt: T0,
      displayName: 'トクモト',
    } as const;

    const sent = await createNotifier(transport, ORIGIN).deliverLink(message);
    expect(sent.ok).toBe(true);
    expect(direct[0]?.discordId).toBe('1529717434259345489');

    const broken = fakeTransport({ fail: true });
    const failed = await createNotifier(broken.transport, ORIGIN).deliverLink(message);
    expect(failed.ok).toBe(false);
  });

  it('Discord を設定していなければ、DM は送れないと答える', async () => {
    expect(nullNotifier.canDeliver).toBe(false);
    const result = await nullNotifier.deliverLink({
      discordId: '1529717434259345489',
      kind: 'enroll',
      url: ORIGIN,
      expiresAt: T0,
      displayName: 'トクモト',
    });
    expect(result.ok).toBe(false);
  });
});

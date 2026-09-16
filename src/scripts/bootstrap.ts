import { openDatabase } from '../db/client.js';
import { listAllMembers } from '../db/members.js';
import { createGenesisMember } from '../domain/members.js';
import { loadEnvWithWarnings } from '../env.js';
import { logger } from '../logger.js';

/**
 * 最初の 1 人を作る。
 *
 * ここで作るのは登録待ちの器と、その人だけが使える登録リンクだけ。
 * パスワードも二要素も本人がブラウザで設定する。
 * 初回だけ別の入口を用意すると、そこが一番弱い場所として残り続けるため。
 *
 * 一度メンバーができたら二度と通らない。以後の追加は必ず提案と承認を通る。
 */

interface Args {
  readonly discordId: string;
  readonly username: string;
  readonly displayName: string;
}

const USAGE = `
使い方:
  npm run bootstrap -- --discord-id=<Discord のユーザー ID> --username=<ログイン名> --display-name=<表示名>

例:
  npm run bootstrap -- --discord-id=1529717434259345489 --username=kazuhiro-tokumoto --display-name="徳本 和寛"

Discord のユーザー ID は、開発者モードを有効にして自分のアイコンを右クリックすると
「ユーザー ID をコピー」で取得できる。
`.trim();

function parseArgs(argv: readonly string[]): Args | undefined {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], match[2]);
  }

  const discordId = values.get('discord-id')?.trim();
  const username = values.get('username')?.trim();
  const displayName = values.get('display-name')?.trim();
  if (
    discordId === undefined ||
    username === undefined ||
    displayName === undefined ||
    discordId === '' ||
    username === '' ||
    displayName === ''
  ) {
    return undefined;
  }
  return { discordId, username, displayName };
}

/** 端末上の見た目の幅。全角と絵文字は 2 桁を占める。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) || // ハングル字母
      (code >= 0x2e80 && code <= 0xa4cf) || // CJK 部首・かな・漢字
      (code >= 0xac00 && code <= 0xd7a3) || // ハングル音節
      (code >= 0xf900 && code <= 0xfaff) || // CJK 互換漢字
      (code >= 0xfe30 && code <= 0xfe6f) || // CJK 互換記号
      (code >= 0xff00 && code <= 0xff60) || // 全角英数記号
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f9ff); // 絵文字
    width += wide ? 2 : 1;
  }
  return width;
}

function banner(lines: readonly string[]): void {
  const width = Math.max(...lines.map(displayWidth), 60);
  const bar = '─'.repeat(width + 2);
  console.log(`┌${bar}┐`);
  for (const line of lines) {
    const pad = ' '.repeat(Math.max(0, width - displayWidth(line)));
    console.log(`│ ${line}${pad} │`);
  }
  console.log(`└${bar}┘`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args === undefined) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const { env, insecureDefaults } = loadEnvWithWarnings();
  if (insecureDefaults.length > 0) {
    logger.warn(
      `開発用の導出値で埋めた設定があります。本番では必ず指定してください: ${insecureDefaults.join(', ')}`,
    );
  }

  const handle = openDatabase({ path: env.databasePath });
  try {
    const existing = listAllMembers(handle.db);
    if (existing.length > 0) {
      logger.error(
        `既にメンバーが ${String(existing.length)} 人います。初期セットアップは 1 回だけです`,
      );
      process.exitCode = 1;
      return;
    }

    const result = createGenesisMember(handle.db, args);
    if (!result.ok) {
      logger.error(result.reason);
      process.exitCode = 1;
      return;
    }

    const url = `${env.webOrigin}/enroll?token=${result.enrollToken}`;
    const expires = new Date(result.expiresAt).toLocaleString('ja-JP');

    console.log('');
    banner([
      `${result.member.displayName} を登録待ちとして作成しました。`,
      '',
      '下のリンクをブラウザで開き、パスワードと二要素認証を設定してください。',
      'このリンクはここでしか表示されません。',
      '',
      url,
      '',
      `有効期限: ${expires}`,
    ]);
    console.log('');
    logger.info(`データベース: ${env.databasePath}`);
  } finally {
    handle.close();
  }
}

main();

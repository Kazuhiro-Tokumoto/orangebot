import { REST, Routes } from 'discord.js';
import { commands } from '../commands/index.js';
import { loadEnv } from '../env.js';
import { logger } from '../logger.js';

/**
 * スラッシュコマンドを Discord に登録する。
 * DISCORD_GUILD_ID があればそのサーバーへ（即時反映）、なければグローバルへ（反映に最大 1 時間）。
 */
async function main(): Promise<void> {
  const { discord } = loadEnv();
  if (discord === undefined) {
    throw new Error('DISCORD_TOKEN と DISCORD_CLIENT_ID を設定してください');
  }

  const body = commands.map((command) => command.data.toJSON());
  const rest = new REST().setToken(discord.token);

  const route =
    discord.guildId === undefined
      ? Routes.applicationCommands(discord.clientId)
      : Routes.applicationGuildCommands(discord.clientId, discord.guildId);

  await rest.put(route, { body });
  logger.info(
    `${String(body.length)} 件のコマンドを登録しました`,
    body.map((c) => c.name),
  );
}

main().catch((error: unknown) => {
  logger.error('コマンド登録に失敗しました', error);
  process.exitCode = 1;
});

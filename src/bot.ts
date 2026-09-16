import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { commandsByName } from './commands/index.js';
import type { DiscordConfig } from './env.js';
import { logger } from './logger.js';

export function createClient(): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, (ready) => {
    logger.info(`ログイン完了: ${ready.user.tag}`);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commandsByName.get(interaction.commandName);
    if (!command) {
      logger.warn(`未登録のコマンドを受信: ${interaction.commandName}`);
      return;
    }

    void command.execute(interaction).catch(async (error: unknown) => {
      logger.error(`コマンド実行に失敗: ${interaction.commandName}`, error);
      const body = {
        content: 'コマンドの実行中にエラーが発生しました。',
        flags: MessageFlags.Ephemeral,
      } as const;
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(body);
        else await interaction.reply(body);
      } catch (replyError: unknown) {
        logger.error('エラー応答の送信に失敗', replyError);
      }
    });
  });

  client.on(Events.Error, (error) => {
    logger.error('クライアントエラー', error);
  });

  return client;
}

export async function startBot(discord: DiscordConfig): Promise<Client> {
  const client = createClient();
  await client.login(discord.token);
  return client;
}

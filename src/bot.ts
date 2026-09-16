import { Client, Events, GatewayIntentBits } from 'discord.js';
import type { DiscordConfig } from './env.js';
import { logger } from './logger.js';

/**
 * Discord の bot。
 *
 * 送るだけで、受け取らない。提案の通知とリンクの DM がこの client から出る。
 * 投票も設定も Web でしか行えないので、誰かが Discord に何を書いても議事は動かない。
 * そのため interaction も message も一切購読しない。
 */
export function createClient(): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, (ready) => {
    logger.info(`ログイン完了: ${ready.user.tag}`);
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

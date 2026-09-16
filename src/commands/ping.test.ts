import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import { commandsByName } from './index.js';
import { ping } from './ping.js';

describe('ping コマンド', () => {
  it('レジストリに name で登録されている', () => {
    expect(commandsByName.get('ping')).toBe(ping);
  });

  it('ゲートウェイ遅延を含めて返信する', async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      reply,
      client: { ws: { ping: 42.4 } },
    } as unknown as ChatInputCommandInteraction;

    await ping.execute(interaction);

    expect(reply).toHaveBeenCalledWith('Pong! (ゲートウェイ遅延: 42ms)');
  });
});

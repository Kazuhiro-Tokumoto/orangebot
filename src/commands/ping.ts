import { SlashCommandBuilder } from 'discord.js';
import type { Command } from './types.js';

export const ping: Command = {
  data: new SlashCommandBuilder().setName('ping').setDescription('ボットの応答速度を返します'),

  async execute(interaction) {
    const latency = Math.round(interaction.client.ws.ping);
    await interaction.reply(`Pong! (ゲートウェイ遅延: ${latency}ms)`);
  },
};

import type {
  ChatInputCommandInteraction,
  RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';

export interface Command {
  /** SlashCommandBuilder など、name と toJSON() を持つもの。 */
  readonly data: {
    readonly name: string;
    toJSON(): RESTPostAPIApplicationCommandsJSONBody;
  };
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

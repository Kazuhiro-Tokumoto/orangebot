import { ping } from './ping.js';
import type { Command } from './types.js';

export const commands: readonly Command[] = [ping];

export const commandsByName: ReadonlyMap<string, Command> = new Map(
  commands.map((command) => [command.data.name, command]),
);

export type { Command };

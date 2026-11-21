#!/usr/bin/env node

import { Command } from 'commander';
import { pickBy } from 'es-toolkit';
import updateNotifier from 'update-notifier';

import type { PortoConfig } from './config';

import { fetchConfig, name, parseConfig, version } from './config';
import { fetchGitContext } from './git';
import { BusyPortsError, cleanupSlots, getAllSlots, getSlot, PortoError, releaseAllSlots, releaseSlot } from './index';
import { logError } from './log';
import {
  fetchExportPaths,
  formatReserveOutput,
  formatStatsTable,
  formatTable,
  updateEnvironmentFile,
  writeReserveJsonFile,
} from './output';
import { commitReservation } from './reserve';
import { parseVars } from './vars';

type ReserveFlags = Omit<PortoConfig, 'idleTtlMinutes' | 'vars'> & {
  idle?: number;
  json?: boolean;
  vars?: false | string;
};

async function fetchSettings(flags: ReserveFlags, command: Command, worktreePath: string) {
  const configured = await fetchConfig(worktreePath);
  const { idle, json, vars, ...overrides } = pickBy(flags, (_flag, key) => command.getOptionValueSource(key) === 'cli');
  const explicit = parseConfig({ ...overrides, ...(idle === undefined ? {} : { idleTtlMinutes: idle }) });
  let entries = configured.vars;
  if (vars !== undefined) entries = vars === false ? undefined : parseVars(vars);
  return { ...configured, ...explicit, json: json ?? false, vars: entries };
}

async function runHook(hookName: string, hook: () => Promise<void> | void) {
  try {
    await hook();
  } catch (error) {
    throw new PortoError('hookFailed', `${hookName}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

function writeOutput(contents: string) {
  process.stdout.write(`${contents}\n`);
}

async function handleReserve(flags: ReserveFlags, command: Command) {
  const git = await fetchGitContext();
  const { json, onReserved, vars: entries, ...settings } = await fetchSettings(flags, command, git.worktreePath);
  const prepared = await commitReservation(git, { ...settings, vars: entries }, async (slot) => {
    const paths = await fetchExportPaths(slot, git.commonDirectory);
    const environment = entries === undefined ? undefined : slot.vars;
    const output = slot.silent ? undefined : formatReserveOutput(slot, environment, json);
    return { ...paths, environment, output, slot };
  });
  const { environment, environmentPath, jsonPath, output, slot } = prepared;
  if (jsonPath) await writeReserveJsonFile(jsonPath, slot, environment);
  if (environmentPath) {
    await updateEnvironmentFile(environmentPath, slot.vars, git.commonDirectory);
  }
  if (onReserved) await runHook('onReserved', () => onReserved(slot, slot.ports));
  if (output !== undefined) writeOutput(output);
}

const cli = new Command('porto');
updateNotifier({
  pkg: { name, version },
  shouldNotifyInNpmScript: true,
  updateCheckInterval: 1000 * 60 * 60 * 24,
}).notify({ defer: false });

cli
  .command('reserve', { isDefault: true })
  .description('Reserve a stable TCP port slot for the current checkout')
  .option('--start <port>', 'First port of the range (default: 10000)', Number)
  .option('--host <host>', 'Host to check for busy ports (default: detect local addresses)')
  .option('--size <count>', 'Number of ports in each slot (default: 10)', Number)
  .option('--idle <minutes>', 'Idle TTL in minutes (default: 60)', Number)
  .option('--vars <entries>', 'NAME or NAME=template variables (| shares a port, ; starts the next)')
  .option('--no-vars', 'Ignore configured variables')
  .option('--json', 'Print JSON to stdout')
  .option('--json-file <file>', 'Save JSON to a file independently of stdout')
  .option('--no-json-file', 'Skip the configured JSON file')
  .option('--silent', 'Skip the reservation output on stdout')
  .option('--no-silent', 'Print the reservation output on stdout')
  .option('--env', 'Update the env file (default: disabled)')
  .option('--no-env', 'Skip the env file')
  .option('--env-file <file>', 'Set the env filename and enable env output (default: .env)')
  .option('--keep', 'Keep this reservation until explicitly released')
  .option('--no-keep', 'Restore idle cleanup for this reservation')
  .action(handleReserve);

cli
  .command('show')
  .argument('[slot-number]', 'Slot index (default: current checkout)', (index) => Number(index.trim() || Number.NaN))
  .description('Show the current checkout slot or select slots by index or --all')
  .option('--all', 'Show all slots in this repository')
  .option('--json', 'Print JSON to stdout')
  .action(async (slotIndex: number | undefined, flags: { all?: boolean; json?: boolean }) => {
    if (flags.all && slotIndex !== undefined) throw new PortoError('slotSelectionInvalid');
    if (flags.all) {
      const reservedSlots = await getAllSlots();
      writeOutput(flags.json ? JSON.stringify(reservedSlots) : formatStatsTable(reservedSlots));
      return;
    }
    const slot = await getSlot(slotIndex);
    if (slot === undefined) throw new PortoError('reservationNotFound');
    writeOutput(flags.json ? JSON.stringify(slot) : String(slot.index));
  });

cli
  .command('release')
  .argument('[slot-number]', 'Slot index (default: current checkout)', (index) => Number(index.trim() || Number.NaN))
  .description('Release the current checkout slot or select slots by index or --all')
  .option('--all', 'Release all slots if every port is free')
  .action(async (slotIndex: number | undefined, flags: { all?: boolean }) => {
    if (flags.all && slotIndex !== undefined) throw new PortoError('slotSelectionInvalid');
    const { worktreePath } = await fetchGitContext();
    const { onReleased } = await fetchConfig(worktreePath);
    const releasedSlots = flags.all
      ? await releaseAllSlots()
      : [await releaseSlot(slotIndex)].filter((slot) => slot !== undefined);
    if (!onReleased) return;
    const results = await Promise.allSettled(
      releasedSlots.map((slot) => runHook('onReleased', () => onReleased(slot, slot.ports))),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  });
cli
  .command('cleanup')
  .description('Remove idle reservations whose ports are all free')
  .action(async () => {
    await cleanupSlots();
  });
cli.version(version);

try {
  await cli.parseAsync();
} catch (error) {
  if (error instanceof BusyPortsError) {
    process.stderr.write(
      `${formatTable(
        ['SLOT', 'PORT'],
        error.ports.map(({ port, slot }) => [String(slot), String(port)]),
      )}\n`,
    );
  }
  logError(error);
  process.exitCode = 1;
}

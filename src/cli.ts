#!/usr/bin/env node
/* oxlint-disable perfectionist/sort-modules -- CLI handlers ordered by use. */

import { Command } from 'commander';
import { compact, pickBy } from 'es-toolkit';
import updateNotifier from 'update-notifier';

import type { PortoConfig } from './config';
import type { PortSlot } from './index';

import { fetchConfig, name, parseConfig, resolveOutputSettings, version } from './config';
import { fetchGitContext } from './git';
import {
  BusyPortsError,
  cleanupSlots,
  destroy,
  getAllSlots,
  getSlot,
  PortoError,
  releaseAllSlots,
  releaseSlot,
} from './index';
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
  let resolvedVars = configured.vars;
  if (vars !== undefined) resolvedVars = vars === false ? undefined : parseVars(vars);
  return { ...configured, ...explicit, json: json ?? false, vars: resolvedVars };
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

function findBusyPortsError(error: unknown): BusyPortsError | undefined {
  if (error instanceof BusyPortsError) return error;
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      const found = findBusyPortsError(inner);
      if (found) return found;
    }
    return undefined;
  }
  if (error instanceof Error && 'cause' in error && error.cause !== undefined) {
    return findBusyPortsError(error.cause);
  }
  return undefined;
}

async function runReleaseHooks(onReleased: PortoConfig['onReleased'], slots: Array<PortSlot>) {
  if (!onReleased) return;
  const results = await Promise.allSettled(slots.map((slot) => runHook('onReleased', () => onReleased(slot))));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

function parseSlotNumber(index: string) {
  return Number(index.trim() || Number.NaN);
}

function writeOutput(contents: string) {
  process.stdout.write(`${contents}\n`);
}

async function handleReserve(flags: ReserveFlags, command: Command) {
  const git = await fetchGitContext();
  const { json, onReserved, vars: resolvedVars, ...settings } = await fetchSettings(flags, command, git.worktreePath);
  const { envPath, jsonPath } = await fetchExportPaths(resolveOutputSettings(settings), git.commonDirectory);
  // Values that cannot be rendered as env lines must fail before the registry is written.
  const needsEnvFormat = envPath !== undefined || (!(settings.silent ?? false) && !json && resolvedVars !== undefined);
  // Registry save happens before JSON/env exports under the same lock.
  // Reserved hook runs only after the lock is released.
  const slot = await commitReservation(
    git,
    { ...settings, vars: resolvedVars },
    needsEnvFormat ? { envFormat: true } : undefined,
    async (vars) => {
      if (jsonPath) await writeReserveJsonFile(jsonPath, vars);
      if (envPath) await updateEnvironmentFile(envPath, vars, git.commonDirectory);
    },
  );
  const vars = resolvedVars === undefined ? undefined : slot.vars;
  const output = slot.silent ? undefined : formatReserveOutput(slot, vars, json);
  if (onReserved) await runHook('onReserved', () => onReserved(slot));
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
  .description('Reserve a stable TCP port slot for the current worktree')
  .option('--start <port>', 'First port of the range (default: 10000)', Number)
  .option('--host <host>', 'Host to check for busy ports (default: detect local addresses)')
  .option('--size <count>', 'Number of ports in each slot (default: 10)', Number)
  .option('--idle <minutes>', 'Idle TTL in minutes (default: 60)', Number)
  .option('--vars <vars>', 'NAME or NAME=template variables (| shares a port, ; starts the next)')
  .option('--no-vars', 'Ignore configured variables')
  .option('--json', 'Print JSON to stdout')
  .option('--json-path <file>', 'Save JSON to a file independently of stdout')
  .option('--no-json-path', 'Skip the configured JSON file')
  .option('--silent', 'Skip the reservation output on stdout')
  .option('--no-silent', 'Print the reservation output on stdout')
  .option('--env', 'Update the env file (default: disabled)')
  .option('--no-env', 'Skip the env file')
  .option('--env-path <file>', 'Set the env filename and enable env output (default: .env)')
  .option('--keep', 'Keep this slot until explicitly released')
  .option('--no-keep', 'Restore idle cleanup for this slot')
  .action(handleReserve);

cli
  .command('show')
  .argument('[slot-number]', 'Slot index (default: current worktree)', parseSlotNumber)
  .description('Show the current worktree slot or select slots by index or --all')
  .option('--all', 'Show all slots in this repository')
  .option('--json', 'Print JSON to stdout')
  .action(async (slotIndex: number | undefined, flags: { all?: boolean; json?: boolean }) => {
    if (flags.all && slotIndex !== undefined) throw new PortoError('slotSelectionInvalid');
    if (flags.all) {
      const slots = await getAllSlots();
      writeOutput(flags.json ? JSON.stringify(slots) : await formatStatsTable(slots));
      return;
    }
    const slot = await getSlot(slotIndex);
    if (slot === undefined) throw new PortoError('reservationNotFound');
    writeOutput(flags.json ? JSON.stringify(slot) : await formatStatsTable([slot]));
  });

cli
  .command('release')
  .argument('[slot-number]', 'Slot index (default: current worktree)', parseSlotNumber)
  .description('Release the current worktree slot or select slots by index or --all')
  .option('--all', 'Release all slots if every port is free')
  .option('--force', 'Release slots even if their ports are busy')
  .action(async (slotIndex: number | undefined, flags: { all?: boolean; force?: boolean }) => {
    if (flags.all && slotIndex !== undefined) throw new PortoError('slotSelectionInvalid');
    const { worktreePath } = await fetchGitContext();
    const { onReleased } = await fetchConfig(worktreePath);
    const force = flags.force ?? false;
    let slots: Array<PortSlot>;
    try {
      slots = flags.all ? await releaseAllSlots(force) : compact([await releaseSlot(slotIndex, force)]);
    } catch (error) {
      if (!(error instanceof BusyPortsError) || !flags.all) throw error;
      // A partial release already saved the free slots; their hooks still run.
      slots = error.releasedSlots;
      try {
        await runReleaseHooks(onReleased, slots);
      } catch (hookError) {
        const hookMessage = hookError instanceof Error ? hookError.message : String(hookError);
        // oxlint-disable-next-line preserve-caught-error -- Both errors are preserved in the AggregateError list.
        throw new AggregateError([error, hookError], `${error.message}\n${hookMessage}`, { cause: error });
      }
      throw error;
    }
    await runReleaseHooks(onReleased, slots);
  });
cli
  .command('destroy')
  .description('Delete the reservation file for this repository')
  .option('--force', 'Delete even if ports are busy')
  .action(async (flags: { force?: boolean }) => {
    await destroy(flags.force ?? false);
  });
cli
  .command('cleanup')
  .description('Remove idle slots whose ports are all free')
  .action(async () => {
    await cleanupSlots();
  });
cli.version(version);

try {
  await cli.parseAsync();
} catch (error) {
  const busyError = findBusyPortsError(error);
  if (busyError) {
    process.stderr.write(
      `${formatTable(
        ['SLOT', 'PORT'],
        busyError.ports.map(({ port, slot }) => [String(slot), String(port)]),
      )}\n`,
    );
  }
  logError(error);
  process.exitCode = 1;
}

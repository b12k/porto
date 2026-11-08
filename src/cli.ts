#!/usr/bin/env node

import { Command } from 'commander';
import { pickBy } from 'es-toolkit';
import updateNotifier from 'update-notifier';

import type { PortoConfig } from './config';

import { applyReserveDefaults, fetchConfig, name, parseConfig, version } from './config';
import { fetchGitContext } from './git';
import { BusyPortsError, cleanup, current, PortoError, release, stats } from './index';
import { logError } from './log';
import {
  fetchExportPaths,
  formatReserveOutput,
  formatTable,
  updateEnvironmentFile,
  writeReserveJsonFile,
} from './output';
import { reserveBlock } from './reserve';
import { mapBlockToVars, parseVars } from './vars';

type ReserveFlags = Omit<PortoConfig, 'idleTtlMinutes' | 'vars'> & {
  idle?: number;
  json?: boolean;
  vars?: false | string;
};

async function fetchSettings(flags: ReserveFlags, command: Command, worktree: string) {
  const configured = await fetchConfig(worktree);
  const { idle, json, vars, ...overrides } = pickBy(flags, (_flag, key) => command.getOptionValueSource(key) === 'cli');
  const explicit = parseConfig({ ...overrides, ...(idle === undefined ? {} : { idleTtlMinutes: idle }) });
  let entries = configured.vars;
  if (vars !== undefined) entries = vars === false ? undefined : parseVars(vars);
  return { ...applyReserveDefaults({ ...configured, ...explicit, vars: entries }), json: json ?? false };
}

function writeOutput(contents: string) {
  process.stdout.write(`${contents}\n`);
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

async function handleReserve(flags: ReserveFlags, command: Command) {
  const git = await fetchGitContext();
  const { vars: entries, ...settings } = await fetchSettings(flags, command, git.worktree);
  const { environmentPath, jsonPath } = await fetchExportPaths(settings, git.commonDirectory);
  const prepared = await reserveBlock({ ...settings, git, portsCount: entries?.length ?? 0 }, ({ ports, ...block }) => {
    const environment = entries === undefined ? undefined : mapBlockToVars(block, entries);
    return { block, environment, output: formatReserveOutput(block, environment, settings.json), ports };
  });
  const { block, environment, output, ports } = prepared;
  if (jsonPath) await writeReserveJsonFile(jsonPath, block, environment);
  if (environmentPath) {
    await updateEnvironmentFile(environmentPath, environment ?? { PORTO_BLOCK: block.index }, git.commonDirectory);
  }
  await runHook('onReserved', async () => settings.onReserved?.(block, ports));
  writeOutput(output);
}

const cli = new Command('porto');
updateNotifier({
  pkg: { name, version },
  shouldNotifyInNpmScript: true,
  updateCheckInterval: 1000 * 60 * 60 * 24,
}).notify({ defer: false });

cli
  .command('reserve', { isDefault: true })
  .description('Reserve a stable TCP port block for the current checkout')
  .option('--start <port>', 'First port of the range (default: 10000)', Number)
  .option('--host <host>', 'Host to check for busy ports (default: detect local addresses)')
  .option('--size <count>', 'Number of ports in each block (default: 10)', Number)
  .option('--idle <minutes>', 'Idle TTL in minutes (default: 60)', Number)
  .option('--vars <entries>', 'Semicolon-separated NAME or NAME:template variables')
  .option('--no-vars', 'Ignore configured variables')
  .option('--json', 'Print JSON to stdout')
  .option('--json-file <file>', 'Save JSON to a file independently of stdout')
  .option('--no-json-file', 'Skip the configured JSON file')
  .option('--env', 'Update the env file (default: disabled)')
  .option('--no-env', 'Skip the env file')
  .option('--env-file <file>', 'Set the env filename and enable env output (default: .env)')
  .option('--keep', 'Keep this reservation until explicitly released')
  .option('--no-keep', 'Restore idle cleanup for this reservation')
  .action(handleReserve);

cli
  .command('current')
  .description('Read the reservations of the current checkout')
  .option('--json', 'Print JSON to stdout')
  .action(async (flags: ReserveFlags) => {
    const blocks = await current();
    if (blocks.length === 0) throw new PortoError('reservationNotFound');
    writeOutput(
      flags.json
        ? JSON.stringify(blocks.length === 1 ? blocks[0] : blocks)
        : blocks.map((block) => block.index).join('\n'),
    );
  });

cli
  .command('stats')
  .description('List all reservations in this repository')
  .option('--json', 'Print JSON to stdout')
  .action(async (flags: ReserveFlags) => {
    const reservations = await stats();
    writeOutput(
      flags.json
        ? JSON.stringify(reservations)
        : formatTable(
            ['BLOCK', 'PORTS', 'WORKTREE', 'LAST USED', 'IDLE (MIN)', 'KEEP', 'EXPIRED'],
            reservations.map((record) => [
              String(record.index),
              `${record.start}-${record.end}`,
              record.worktree,
              record.lastUsedAt,
              String(record.idleTtlMinutes),
              record.keep ? 'yes' : 'no',
              record.isExpired ? 'yes' : 'no',
            ]),
          ),
    );
  });

cli
  .command('release')
  .description('Release current checkout reservations if every port is free')
  .action(async () => {
    const { worktree } = await fetchGitContext();
    const { onReleased } = await fetchConfig(worktree);
    const blocks = await release();
    const results = await Promise.allSettled(
      blocks.map(async ({ ports, ...block }) => runHook('onReleased', async () => onReleased?.(block, ports))),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  });
cli
  .command('cleanup')
  .description('Remove idle reservations whose ports are all free')
  .action(async () => {
    await cleanup();
  });
cli.version(version);

try {
  await cli.parseAsync();
} catch (error) {
  if (error instanceof BusyPortsError) {
    process.stderr.write(
      `${formatTable(
        ['BLOCK', 'PORT'],
        error.ports.map(({ block, port }) => [String(block), String(port)]),
      )}\n`,
    );
  }
  logError(error);
  process.exitCode = 1;
}

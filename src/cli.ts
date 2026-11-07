#!/usr/bin/env -S node --

import { Command } from 'commander';
import { pickBy } from 'es-toolkit';
import path from 'node:path';
import updateNotifier from 'update-notifier';

import type { PortoConfig } from './config';
import type { PortBlock } from './index';
import type { Environment } from './output';

import { DEFAULT_FILES, fetchConfig, name, parseReserveConfig, version } from './config';
import { fetchCanonicalPath, writeFileAtomically } from './files';
import { BusyPortsError, cleanup, current, PortoError, release, reserve, stats } from './index';
import { logError } from './log';
import { formatEnvironment, formatTable, updateEnvironmentFile } from './output';
import { mapBlockToVars, parseVars } from './vars';

type ReserveFlags = Omit<PortoConfig, 'idleTtlMinutes' | 'vars'> & { idle?: number; vars?: false | string };

function getExportPath(flag: boolean | string, fallback: string) {
  if (typeof flag === 'string' && flag.length === 0) {
    throw new PortoError('exportInvalid', 'Filename must not be empty.');
  }
  return path.resolve(typeof flag === 'string' ? flag : fallback);
}

async function fetchExportPaths(settings: PortoConfig) {
  const outputPath =
    settings.write === undefined || settings.write === false
      ? undefined
      : await fetchCanonicalPath(getExportPath(settings.write, DEFAULT_FILES.write));
  const environmentPath =
    settings.envFile === undefined || settings.envFile === false
      ? undefined
      : await fetchCanonicalPath(getExportPath(settings.envFile, DEFAULT_FILES.envFile));
  const arePathsEqual =
    outputPath !== undefined &&
    environmentPath !== undefined &&
    (process.platform === 'win32'
      ? outputPath.toLowerCase() === environmentPath.toLowerCase()
      : outputPath === environmentPath);
  if (arePathsEqual) throw new PortoError('exportInvalid', '--write and --env-file must use different files.');
  return { environmentPath, outputPath };
}

async function fetchSettings(flags: ReserveFlags, command: Command) {
  const configured = await fetchConfig();
  const { idle, vars, ...overrides } = pickBy(flags, (_flag, key) => command.getOptionValueSource(key) === 'cli');
  return parseReserveConfig({
    ...configured,
    ...overrides,
    ...(idle === undefined ? {} : { idleTtlMinutes: idle }),
    ...(vars === undefined ? {} : { vars: vars === false ? undefined : parseVars(vars) }),
  });
}

function formatReserveOutput(block: PortBlock, environment: Environment | undefined, isJson: boolean) {
  if (isJson) return JSON.stringify(environment ?? { end: block.end, index: block.index, start: block.start });
  return environment ? formatEnvironment(environment) : String(block.index);
}

function writeOutput(contents: string) {
  process.stdout.write(`${contents}\n`);
}

async function handleReserve(flags: ReserveFlags, command: Command) {
  const settings = await fetchSettings(flags, command);
  const { environmentPath, outputPath } = await fetchExportPaths(settings);
  const block = await reserve(settings);
  const environment = settings.vars === undefined ? undefined : mapBlockToVars(block, settings.vars);
  const output = formatReserveOutput(block, environment, settings.json ?? false);
  if (outputPath) await writeFileAtomically(outputPath, `${output}\n`);
  if (environmentPath) await updateEnvironmentFile(environmentPath, environment ?? { PORTO_BLOCK: block.index });
  writeOutput(output);
}

const cli = new Command('porto');
updateNotifier({
  pkg: { name, version },
  shouldNotifyInNpmScript: true,
  updateCheckInterval: 1000 * 60 * 60 * 24,
}).notify({ defer: false });

cli
  .command('reserve')
  .description('Reserve a stable TCP port block for the current checkout')
  .option('--start <port>', 'First port of the range (default: 1000)', Number)
  .option('--size <count>', 'Number of ports in each block (default: 10)', Number)
  .option('--idle <minutes>', 'Idle TTL in minutes (default: 60)', Number)
  .option('--vars <entries>', 'Semicolon-separated NAME or NAME:template variables')
  .option('--no-vars', 'Ignore configured variables')
  .option('--json', 'Print JSON')
  .option('--no-json', 'Print text')
  .option('--write [file]', 'Save stdout to a file (default: porto.lock)')
  .option('--no-write', 'Skip the configured output file')
  .option('--env-file [file]', 'Update an env file (default: .env)')
  .option('--no-env-file', 'Skip the configured env file')
  .option('--keep', 'Keep this reservation until explicitly released')
  .option('--no-keep', 'Restore idle cleanup for this reservation')
  .action(handleReserve);

cli
  .command('current')
  .description('Read the reservations of the current checkout')
  .option('--json', 'Print JSON')
  .option('--no-json', 'Print text')
  .action(async (flags: ReserveFlags, command: Command) => {
    const settings = await fetchSettings(flags, command);
    const blocks = await current();
    if (blocks.length === 0) throw new PortoError('reservationNotFound');
    writeOutput(
      settings.json
        ? JSON.stringify(blocks.length === 1 ? blocks[0] : blocks)
        : blocks.map((block) => block.index).join('\n'),
    );
  });

cli
  .command('stats')
  .description('List all reservations in this repository')
  .option('--json', 'Print JSON')
  .option('--no-json', 'Print text')
  .action(async (flags: ReserveFlags, command: Command) => {
    const settings = await fetchSettings(flags, command);
    const reservations = await stats();
    writeOutput(
      settings.json
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
    await release();
  });
cli
  .command('cleanup')
  .description('Remove idle reservations whose ports are all free')
  .action(async () => {
    await cleanup();
  });
cli.version(version);
cli.action(() => {
  cli.outputHelp();
});

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

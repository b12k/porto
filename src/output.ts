/* oxlint-disable import/max-dependencies -- Output formatting needs table, dates, fs, locks and domain helpers. */
import Table from 'cli-table3';
import { differenceInSeconds } from 'date-fns/differenceInSeconds';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import type { SlotVars } from './vars';

import { LOOPBACK_HOST } from './config';
import { assertExportPaths, assertLockPathUsable } from './export-paths';
import { checkIsFileMissing, fetchCanonicalPath, writeFileAtomically } from './files';
import { listBusyPorts } from './ports';
import { checkIsExpired } from './registry';
import { formatLabeledField, maxLineDisplayWidth, wrapTextByWidth } from './terminal';
import { formatEnvironment, formatEnvironmentValue } from './vars';

// Match unrelated names too so their quoted values are skipped as a unit.
const ENV_ASSIGNMENT_PATTERN =
  /^(?<prefix>﻿?[ \t]*(?:export[ \t]+)?)(?<name>[^#=\s][^=\r\n]*?)(?<separator>[ \t]*=[ \t]*)(?:'[^']*'|"(?:\\[\s\S]|[^"\\])*"|`[^`]*`|[^\r\n#]*?)(?<suffix>[ \t]*(?:#[^\r\n]*)?)(?=\r?$)/gmu;

const WORKTREE_WIDTH = 30;
const LAST_USED_UNITS = [
  [86_400, 'd'],
  [3600, 'h'],
  [60, 'min'],
] as const;

type StatsField = [label: string, value: string];

interface StatsInput {
  expiresAt: string;
  firstPort: number;
  host?: string | undefined;
  idleTtlMinutes: number;
  index: number;
  isExpired?: boolean;
  keep: boolean;
  lastPort: number;
  lastUsedAt: string;
  vars: SlotVars;
  worktreePath: string;
}

function formatLastUsed(lastUsedAt: string, now: number) {
  const elapsedSec = differenceInSeconds(now, lastUsedAt);
  const durationSec = Math.abs(elapsedSec);
  const [unitSec, unit] = LAST_USED_UNITS.find(([seconds]) => durationSec >= seconds) ?? [1, 'sec'];
  const duration = `${Math.floor(durationSec / unitSec)} ${unit}`;
  return elapsedSec < 0 ? `in ${duration}` : `${duration} ago`;
}

function formatVarsCell(vars: SlotVars) {
  const entries = Object.entries(vars);
  if (entries.length === 0) return '-';
  return entries.map(([name, value]) => `${name}=${value}`).join('\n');
}

function buildStatsFields(slot: StatsInput, busy: string, now: number): [StatsField, ...Array<StatsField>] {
  const ports = [String(slot.firstPort)];
  if (slot.lastPort > slot.firstPort + 1) ports.push('...');
  if (slot.lastPort > slot.firstPort) ports.push(String(slot.lastPort));
  const worktreeName = path.basename(slot.worktreePath) || slot.worktreePath;
  const isExpired = slot.isExpired ?? checkIsExpired(slot, now);
  return [
    ['SLOT', String(slot.index)],
    ['PORTS', ports.join('\n')],
    ['WORKTREE', wrapTextByWidth(worktreeName, WORKTREE_WIDTH)],
    ['PATH', wrapTextByWidth(slot.worktreePath, WORKTREE_WIDTH)],
    ['LAST USED', formatLastUsed(slot.lastUsedAt, now)],
    ['IDLE IN', `${slot.idleTtlMinutes} min`],
    ['KEEP', slot.keep ? 'yes' : 'no'],
    ['EXPIRED', isExpired ? 'yes' : 'no'],
    ['VARS', formatVarsCell(slot.vars)],
    ['BUSY PORTS', busy],
  ];
}

async function fetchEnvironmentContents(filePath: string) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (!checkIsFileMissing(error)) throw error;
    return '';
  }
}

function formatBusyCell(ports: Array<number>) {
  if (ports.length === 0) return '-';
  return ports.join('\n');
}

async function fetchBusyCell(slot: Pick<StatsInput, 'firstPort' | 'host' | 'lastPort'>) {
  try {
    return formatBusyCell(await listBusyPorts(slot.firstPort, slot.lastPort, { host: slot.host ?? LOOPBACK_HOST }));
  } catch {
    return 'unknown';
  }
}

function formatReserveOutput(
  slot: Pick<StatsInput, 'firstPort' | 'index' | 'lastPort'>,
  vars: SlotVars | undefined,
  isJson: boolean,
) {
  if (isJson) {
    return JSON.stringify(vars ?? { firstPort: slot.firstPort, index: slot.index, lastPort: slot.lastPort });
  }
  return vars ? formatEnvironment(vars) : String(slot.index);
}

function formatTable(headers: Array<string>, rows: Array<Array<string>>) {
  const table = new Table({ head: headers, style: { border: [], head: [] } });
  for (const row of rows) table.push(row);
  return table.toString();
}

function getTerminalWidth(): number | undefined {
  if (process.stdout.isTTY) {
    const width = process.stdout.columns;
    if (typeof width === 'number' && Number.isFinite(width) && width > 0) return width;
  }
  return undefined;
}

async function formatStatsTable(slots: Array<StatsInput>, terminalWidth?: number) {
  const now = Date.now();
  // A slot whose saved host is gone from this machine must not hide the other rows.
  const rows = await Promise.all(slots.map(async (slot) => buildStatsFields(slot, await fetchBusyCell(slot), now)));
  const [firstRow] = rows;
  if (firstRow === undefined) return 'No slots.';
  const termWidth = terminalWidth ?? getTerminalWidth();
  const horizontal = formatTable(
    firstRow.map(([label]) => label),
    rows.map((fields) => fields.map(([, value]) => value)),
  );
  if (termWidth === undefined || maxLineDisplayWidth(horizontal) <= termWidth) return horizontal;
  return rows
    .map(([[label, index], ...fields]) =>
      [`${label} ${index}`, ...fields.map(([name, value]) => formatLabeledField(name, value, termWidth))].join('\n'),
    )
    .join('\n\n');
}

async function saveEnvironmentFile(filePath: string, vars: SlotVars) {
  const contents = await fetchEnvironmentContents(filePath);
  const lineEnding = contents.includes('\r\n') ? '\r\n' : '\n';
  const pendingVars = new Map(Object.entries(vars));
  const updated = contents.replaceAll(
    ENV_ASSIGNMENT_PATTERN,
    (line: string, ...captures: [string, string, string, string, ...Array<unknown>]) => {
      const [prefix, name, separator, suffix] = captures;
      const entry = Object.hasOwn(vars, name) ? vars[name] : undefined;
      if (entry === undefined) return line;
      pendingVars.delete(name);
      return `${prefix}${name}${separator}${formatEnvironmentValue(entry)}${suffix}`;
    },
  );
  const appended = formatEnvironment(Object.fromEntries(pendingVars)).replaceAll('\n', lineEnding);
  const separator = updated.length > 0 && !updated.endsWith('\n') ? lineEnding : '';
  await writeFileAtomically(filePath, `${updated}${appended ? `${separator}${appended}${lineEnding}` : ''}`);
}

async function updateEnvironmentFile(filePath: string, vars: SlotVars, commonDirectory?: string) {
  const targetPath = await fetchCanonicalPath(filePath);
  if (commonDirectory !== undefined) {
    await assertExportPaths([targetPath], commonDirectory);
  }
  await assertLockPathUsable(await fetchCanonicalPath(`${targetPath}.lock`));
  const unlock = await lockfile.lock(targetPath, {
    realpath: false,
    retries: { factor: 1, maxTimeout: 100, minTimeout: 100, retries: 200 },
  });
  try {
    await saveEnvironmentFile(targetPath, vars);
  } finally {
    await unlock();
  }
}

async function writeReserveJsonFile(filePath: string, vars: SlotVars) {
  await writeFileAtomically(filePath, `${JSON.stringify(vars)}\n`);
}

export { fetchExportPaths } from './export-paths';
export { formatEnvironment } from './vars';
export { formatReserveOutput, formatStatsTable, formatTable, updateEnvironmentFile, writeReserveJsonFile };

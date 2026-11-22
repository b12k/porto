/* oxlint-disable import/max-dependencies -- Output formatting needs table, dates, fs, locks and domain helpers. */
import Table from 'cli-table3';
import { formatDistance } from 'date-fns/formatDistance';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import type { SlotVars } from './vars';

import { LOOPBACK_HOST } from './config';
import { assertExportPaths, assertLockPathUsable } from './export-paths';
import { checkIsFileMissing, fetchCanonicalPath, writeFileAtomically } from './files';
import { listBusyPorts } from './ports';
import { checkIsExpired } from './registry';
import { formatLabeledField, maxLineDisplayWidth, truncateMiddle, wrapCommaValue } from './terminal';
import { formatEnvironment, formatEnvironmentValue } from './vars';

// Match unrelated names too so their quoted values are skipped as a unit.
const ENV_ASSIGNMENT_PATTERN =
  /^(?<prefix>﻿?[ \t]*(?:export[ \t]+)?)(?<name>[^#=\s][^=\r\n]*?)(?<separator>[ \t]*=[ \t]*)(?:'[^']*'|"(?:\\[\s\S]|[^"\\])*"|`[^`]*`|[^\r\n#]*?)(?<suffix>[ \t]*(?:#[^\r\n]*)?)(?=\r?$)/gmu;

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

function clampWidth(termWidth: number, reserved: number, min: number, max: number) {
  return Math.max(min, Math.min(max, termWidth - reserved));
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
  return ports.join(', ');
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

function formatVarsCell(vars: SlotVars) {
  const entries = Object.entries(vars);
  if (entries.length === 0) return '-';
  return entries.map(([name, value]) => `${name}=${value}`).join(', ');
}

function getTerminalWidth(): number | undefined {
  if (process.stdout.isTTY) {
    const width = process.stdout.columns;
    if (typeof width === 'number' && Number.isFinite(width) && width > 0) return width;
  }
  return undefined;
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

function wrapVarsCell(vars: SlotVars, maxLine: number) {
  return wrapCommaValue(formatVarsCell(vars), maxLine);
}

function buildHorizontalTable(
  slots: Array<StatsInput>,
  busyCells: Array<string>,
  termWidth: number | undefined,
  now: number,
) {
  const pathMax = termWidth === undefined ? Number.POSITIVE_INFINITY : clampWidth(termWidth, 90, 16, 48);
  const varsMax = termWidth === undefined ? Number.POSITIVE_INFINITY : clampWidth(termWidth, 80, 16, 50);
  const table = new Table({
    head: ['SLOT', 'PORTS', 'WORKTREE', 'PATH', 'LAST USED', 'IDLE (MIN)', 'KEEP', 'EXPIRED', 'VARS', 'BUSY PORTS'],
    style: { border: [], head: [] },
  });
  for (const [position, slot] of slots.entries()) {
    const busy = busyCells[position] ?? 'unknown';
    table.push([
      String(slot.index),
      `${slot.firstPort}-${slot.lastPort}`,
      path.basename(slot.worktreePath) || slot.worktreePath,
      truncateMiddle(slot.worktreePath, pathMax),
      formatDistance(slot.lastUsedAt, now, { addSuffix: true }),
      String(slot.idleTtlMinutes),
      slot.keep ? 'yes' : 'no',
      (slot.isExpired ?? checkIsExpired(slot, now)) ? 'yes' : 'no',
      wrapVarsCell(slot.vars, varsMax),
      busy,
    ]);
  }
  return table.toString();
}

function formatStatsVertical(slots: Array<StatsInput>, busyCells: Array<string>, termWidth: number) {
  const now = Date.now();
  return slots
    .map((slot, position) => {
      const busy = busyCells[position] ?? 'unknown';
      const expired = (slot.isExpired ?? checkIsExpired(slot, now)) ? 'yes' : 'no';
      return [
        `SLOT ${slot.index}`,
        `  PORTS: ${slot.firstPort}-${slot.lastPort}`,
        formatLabeledField('WORKTREE', path.basename(slot.worktreePath) || slot.worktreePath, termWidth),
        formatLabeledField('PATH', slot.worktreePath, termWidth),
        formatLabeledField('LAST USED', formatDistance(slot.lastUsedAt, now, { addSuffix: true }), termWidth),
        formatLabeledField('IDLE (MIN)', String(slot.idleTtlMinutes), termWidth),
        formatLabeledField('KEEP', slot.keep ? 'yes' : 'no', termWidth),
        formatLabeledField('EXPIRED', expired, termWidth),
        formatLabeledField('VARS', formatVarsCell(slot.vars), termWidth),
        formatLabeledField('BUSY PORTS', busy, termWidth),
      ].join('\n');
    })
    .join('\n\n');
}

async function formatStatsTable(slots: Array<StatsInput>, terminalWidth?: number) {
  const now = Date.now();
  // A slot whose saved host is gone from this machine must not hide the other rows.
  const busyCells = await Promise.all(slots.map((slot) => fetchBusyCell(slot)));
  if (slots.length === 0) return 'No slots.';
  const termWidth = terminalWidth ?? getTerminalWidth();
  if (termWidth === undefined) {
    return buildHorizontalTable(slots, busyCells, termWidth, now);
  }
  const horizontal = buildHorizontalTable(slots, busyCells, termWidth, now);
  if (maxLineDisplayWidth(horizontal) <= termWidth) return horizontal;
  return formatStatsVertical(slots, busyCells, termWidth);
}

async function writeReserveJsonFile(filePath: string, vars: SlotVars) {
  await writeFileAtomically(filePath, `${JSON.stringify(vars)}\n`);
}

export { fetchExportPaths } from './export-paths';
export { formatEnvironment } from './vars';
export { formatReserveOutput, formatStatsTable, formatTable, updateEnvironmentFile, writeReserveJsonFile };

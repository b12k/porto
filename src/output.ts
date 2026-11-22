import Table from 'cli-table3';
import { formatDistance } from 'date-fns/formatDistance';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import type { SlotVars } from './vars';

import { PortoError } from './error';
import { checkIsFileMissing, fetchCanonicalPath, writeFileAtomically } from './files';
import { listBusyPorts } from './ports';
import { checkIsExpired, getRegistryPath } from './registry';
import { formatEnvironment, formatEnvironmentValue } from './vars';

// Match unrelated names too so their quoted values are skipped as a unit.
const ENV_ASSIGNMENT_PATTERN =
  /^(?<prefix>\uFEFF?[ \t]*(?:export[ \t]+)?)(?<name>[^#=\s][^=\r\n]*?)(?<separator>[ \t]*=[ \t]*)(?:'[^']*'|"(?:\\[\s\S]|[^"\\])*"|`[^`]*`|[^\r\n#]*?)(?<suffix>[ \t]*(?:#[^\r\n]*)?)(?=\r?$)/gmu;

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

async function fetchFileIdentity(filePath: string) {
  try {
    const { dev, ino } = await stat(filePath, { bigint: true });
    return `${dev}:${ino}`;
  } catch (error) {
    if (!checkIsFileMissing(error)) throw error;
    return false;
  }
}

function normalizePathForComparison(filePath: string) {
  if (process.platform === 'win32') return filePath.replace(/[ .]+$/u, '').toLowerCase();
  return process.platform === 'darwin' ? filePath.toLowerCase() : filePath;
}

async function assertExportPaths(exportPaths: Array<string>, registryPath: string) {
  if (exportPaths.length === 0) return;
  const lockPath = `${registryPath}.lock`;
  const [registryTarget, lockTarget] = await Promise.all([
    fetchCanonicalPath(registryPath),
    fetchCanonicalPath(lockPath),
  ]);
  const registryPaths = new Set([registryPath, registryTarget].map((filePath) => normalizePathForComparison(filePath)));
  const lockPaths = [lockPath, lockTarget].map((filePath) => normalizePathForComparison(filePath));
  const [registryIdentity, lockIdentity, ...exportIdentities] = await Promise.all(
    [registryTarget, lockTarget, ...exportPaths].map((filePath) => fetchFileIdentity(filePath)),
  );
  const hasProtectedPath = exportPaths.some((filePath) => {
    const normalizedPath = normalizePathForComparison(filePath);
    return (
      registryPaths.has(normalizedPath) ||
      lockPaths.some(
        (targetPath) => normalizedPath === targetPath || normalizedPath.startsWith(`${targetPath}${path.sep}`),
      )
    );
  });
  if (
    hasProtectedPath ||
    exportIdentities.some((identity) => identity && (identity === registryIdentity || identity === lockIdentity))
  ) {
    throw new PortoError('exportInvalid', 'The Porto registry and its lock are reserved.');
  }
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

async function fetchExportPaths(
  settings: { env: boolean; envFile: string; jsonFile: false | string },
  commonDirectory: string,
) {
  const jsonPath = settings.jsonFile ? await fetchCanonicalPath(path.resolve(settings.jsonFile)) : undefined;
  const envPath = settings.env ? await fetchCanonicalPath(path.resolve(settings.envFile)) : undefined;
  const arePathsEqual =
    jsonPath !== undefined &&
    envPath !== undefined &&
    normalizePathForComparison(jsonPath) === normalizePathForComparison(envPath);
  if (arePathsEqual) throw new PortoError('exportInvalid', '--json-file and --env-file must use different files.');
  await assertExportPaths(
    [jsonPath, envPath].filter((filePath) => filePath !== undefined),
    getRegistryPath(commonDirectory),
  );
  return { envPath, jsonPath };
}

function formatBusyCell(ports: Array<number>) {
  if (ports.length === 0) return '-';
  return ports.join(', ');
}

async function fetchBusyCell(slot: Pick<StatsInput, 'firstPort' | 'host' | 'lastPort'>) {
  try {
    return formatBusyCell(await listBusyPorts(slot.firstPort, slot.lastPort, { host: slot.host }));
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

function truncateMiddle(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  const ellipsis = '…';
  const keep = maxLength - ellipsis.length;
  const front = Math.ceil(keep / 2);
  const back = Math.floor(keep / 2);
  return `${text.slice(0, front)}${ellipsis}${text.slice(text.length - back)}`;
}

async function updateEnvironmentFile(filePath: string, vars: SlotVars, commonDirectory?: string) {
  const targetPath = await fetchCanonicalPath(filePath);
  if (commonDirectory !== undefined) await assertExportPaths([targetPath], getRegistryPath(commonDirectory));
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
  const text = formatVarsCell(vars);
  if (text.length <= maxLine) return text;
  const lines: Array<string> = [];
  let current = '';
  for (const part of text.split(', ')) {
    const candidate = current === '' ? part : `${current}, ${part}`;
    if (candidate.length > maxLine && current !== '') {
      lines.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current !== '') lines.push(current);
  return lines.join('\n');
}

const NARROW_TERMINAL_WIDTH = 80;

function formatStatsVertical(slots: Array<StatsInput>, busyCells: Array<string>) {
  const now = Date.now();
  return slots
    .map((slot, position) =>
      [
        `SLOT ${slot.index}`,
        `  PORTS: ${slot.firstPort}-${slot.lastPort}`,
        `  WORKTREE: ${path.basename(slot.worktreePath) || slot.worktreePath}`,
        `  PATH: ${slot.worktreePath}`,
        `  LAST USED: ${formatDistance(slot.lastUsedAt, now, { addSuffix: true })}`,
        `  IDLE (MIN): ${slot.idleTtlMinutes}`,
        `  KEEP: ${slot.keep ? 'yes' : 'no'}`,
        `  EXPIRED: ${(slot.isExpired ?? checkIsExpired(slot, now)) ? 'yes' : 'no'}`,
        `  VARS: ${formatVarsCell(slot.vars)}`,
        `  BUSY PORTS: ${busyCells[position] ?? 'unknown'}`,
      ].join('\n'),
    )
    .join('\n\n');
}

async function formatStatsTable(slots: Array<StatsInput>) {
  const now = Date.now();
  // A slot whose saved host is gone from this machine must not hide the other rows.
  const busyCells = await Promise.all(slots.map((slot) => fetchBusyCell(slot)));
  const termWidth = getTerminalWidth();
  if (termWidth !== undefined && termWidth <= NARROW_TERMINAL_WIDTH && slots.length > 0) {
    return formatStatsVertical(slots, busyCells);
  }
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

async function writeReserveJsonFile(filePath: string, vars: SlotVars) {
  await writeFileAtomically(filePath, `${JSON.stringify(vars)}\n`);
}

export { formatEnvironment } from './vars';
export {
  fetchExportPaths,
  formatReserveOutput,
  formatStatsTable,
  formatTable,
  updateEnvironmentFile,
  writeReserveJsonFile,
};

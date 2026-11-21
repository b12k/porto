import { formatDistance } from 'date-fns/formatDistance';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import type { ReservationStats } from './index';
import type { PortSlot } from './ports';
import type { SlotVars } from './vars';

import { PortoError } from './error';
import { checkIsFileMissing, fetchCanonicalPath, writeFileAtomically } from './files';
import { getRegistryPath } from './registry';

// Match unrelated names too so their quoted values are skipped as a unit.
const ENV_ASSIGNMENT_PATTERN =
  /^(?<prefix>\uFEFF?[ \t]*(?:export[ \t]+)?)(?<name>[^#=\s][^=\r\n]*?)(?<separator>[ \t]*=[ \t]*)(?:'[^']*'|"(?:\\[\s\S]|[^"\\])*"|`[^`]*`|[^\r\n#]*?)(?<suffix>[ \t]*(?:#[^\r\n]*)?)(?=\r?$)/gmu;

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

function formatEnvironmentValue(value: number | string) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+,-]*$/u.test(text)) return text;
  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes('"') && !text.includes('\\')) return `"${text}"`;
  throw new PortoError('mappingInvalid', 'Value cannot be represented safely on a single env line.');
}

function formatEnvironment(vars: SlotVars) {
  return Object.entries(vars)
    .map(([name, value]) => `${name}=${formatEnvironmentValue(value)}`)
    .join('\n');
}

function formatReserveOutput(slot: PortSlot, vars: SlotVars | undefined, isJson: boolean) {
  if (isJson) {
    return JSON.stringify(vars ?? { firstPort: slot.firstPort, index: slot.index, lastPort: slot.lastPort });
  }
  return vars ? formatEnvironment(vars) : String(slot.index);
}

function formatTable(headers: Array<string>, rows: Array<Array<string>>) {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));
  return [headers, ...rows]
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function formatStatsTable(slots: Array<ReservationStats>) {
  const now = Date.now();
  return formatTable(
    ['SLOT', 'PORTS', 'WORKTREE', 'PATH', 'LAST USED', 'IDLE (MIN)', 'KEEP', 'EXPIRED'],
    slots.map((slot) => [
      String(slot.index),
      `${slot.firstPort}-${slot.lastPort}`,
      path.basename(slot.worktreePath) || slot.worktreePath,
      slot.worktreePath,
      formatDistance(slot.lastUsedAt, now, { addSuffix: true }),
      String(slot.idleTtlMinutes),
      slot.keep ? 'yes' : 'no',
      slot.isExpired ? 'yes' : 'no',
    ]),
  );
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

async function writeReserveJsonFile(filePath: string, vars: SlotVars) {
  await writeFileAtomically(filePath, `${JSON.stringify(vars)}\n`);
}

export {
  fetchExportPaths,
  formatEnvironment,
  formatReserveOutput,
  formatStatsTable,
  formatTable,
  updateEnvironmentFile,
  writeReserveJsonFile,
};

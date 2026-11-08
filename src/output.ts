import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import type { PortBlock } from './index';

import { PortoError } from './error';
import { checkIsFileMissing, fetchCanonicalPath, writeFileAtomically } from './files';
import { getRegistryPath } from './registry';

export type Environment = Record<string, number | string>;

// Match unrelated names too so their quoted values are skipped as a unit.
const ENV_ASSIGNMENT_PATTERN =
  /^(?<prefix>\uFEFF?[ \t]*(?:export[ \t]+)?)(?<name>[^#=\s][^=\r\n]*?)(?<separator>[ \t]*=[ \t]*)(?:'[^']*'|"(?:\\[\s\S]|[^"\\])*"|`[^`]*`|[^\r\n#]*?)(?<suffix>[ \t]*(?:#[^\r\n]*)?)(?=\r?$)/gmu;

function normalizePathForComparison(filePath: string) {
  if (process.platform === 'win32') return filePath.replace(/[ .]+$/u, '').toLowerCase();
  return process.platform === 'darwin' ? filePath.toLowerCase() : filePath;
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

async function assertExportPaths(exportPaths: string[], registryPath: string) {
  if (exportPaths.length === 0) return;
  const lockPath = `${registryPath}.lock`;
  const [registryTarget, lockTarget] = await Promise.all([
    fetchCanonicalPath(registryPath),
    fetchCanonicalPath(lockPath),
  ]);
  const registryPaths = new Set([registryPath, registryTarget].map((filePath) => normalizePathForComparison(filePath)));
  const lockPaths = [lockPath, lockTarget].map((filePath) => normalizePathForComparison(filePath));
  const protectedIdentities = new Set(
    await Promise.all([fetchFileIdentity(registryTarget), fetchFileIdentity(lockTarget)]),
  );
  protectedIdentities.delete(false);
  const exportIdentities = await Promise.all(exportPaths.map(async (filePath) => fetchFileIdentity(filePath)));
  if (
    exportPaths.some((filePath) => {
      const normalizedPath = normalizePathForComparison(filePath);
      return (
        registryPaths.has(normalizedPath) ||
        lockPaths.some(
          (targetPath) => normalizedPath === targetPath || normalizedPath.startsWith(`${targetPath}${path.sep}`),
        )
      );
    }) ||
    exportIdentities.some((identity) => protectedIdentities.has(identity))
  ) {
    throw new PortoError('exportInvalid', 'The Porto registry and its lock are reserved.');
  }
}

export async function fetchExportPaths(
  settings: { env: boolean; envFile: string; jsonFile: false | string },
  commonDirectory: string,
) {
  const jsonPath = settings.jsonFile ? await fetchCanonicalPath(path.resolve(settings.jsonFile)) : undefined;
  const environmentPath = settings.env ? await fetchCanonicalPath(path.resolve(settings.envFile)) : undefined;
  const arePathsEqual =
    jsonPath !== undefined &&
    environmentPath !== undefined &&
    normalizePathForComparison(jsonPath) === normalizePathForComparison(environmentPath);
  if (arePathsEqual) throw new PortoError('exportInvalid', '--json-file and --env-file must use different files.');
  await assertExportPaths(
    [jsonPath, environmentPath].filter((filePath) => filePath !== undefined),
    getRegistryPath(commonDirectory),
  );
  return { environmentPath, jsonPath };
}

function formatEnvironmentValue(entry: number | string) {
  const text = String(entry);
  if (/^[A-Za-z0-9_./:@%+,-]*$/u.test(text)) return text;
  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes('"') && !text.includes('\\')) return `"${text}"`;
  throw new PortoError('mappingInvalid', 'Value cannot be represented safely on a single env line.');
}

export function formatEnvironment(environment: Environment) {
  return Object.entries(environment)
    .map(([name, entry]) => `${name}=${formatEnvironmentValue(entry)}`)
    .join('\n');
}

export function formatReserveOutput(block: PortBlock, environment: Environment | undefined, isJson: boolean) {
  if (isJson) return JSON.stringify(environment ?? { end: block.end, index: block.index, start: block.start });
  return environment ? formatEnvironment(environment) : String(block.index);
}

export async function writeReserveJsonFile(filePath: string, block: PortBlock, environment: Environment | undefined) {
  await writeFileAtomically(filePath, `${formatReserveOutput(block, environment, true)}\n`);
}

export function formatTable(headers: string[], rows: string[][]) {
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

async function fetchEnvironmentContents(filePath: string) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (!checkIsFileMissing(error)) throw error;
    return '';
  }
}

async function saveEnvironmentFile(filePath: string, environment: Environment) {
  const contents = await fetchEnvironmentContents(filePath);
  const lineEnding = contents.includes('\r\n') ? '\r\n' : '\n';
  const pendingEntries = new Map(Object.entries(environment));
  const updated = contents.replaceAll(
    ENV_ASSIGNMENT_PATTERN,
    (line: string, ...captures: [string, string, string, string, ...unknown[]]) => {
      const [prefix, name, separator, suffix] = captures;
      const entry = Object.hasOwn(environment, name) ? environment[name] : undefined;
      if (entry === undefined) return line;
      pendingEntries.delete(name);
      return `${prefix}${name}${separator}${formatEnvironmentValue(entry)}${suffix}`;
    },
  );
  const appended = formatEnvironment(Object.fromEntries(pendingEntries)).replaceAll('\n', lineEnding);
  const separator = updated.length > 0 && !updated.endsWith('\n') ? lineEnding : '';
  await writeFileAtomically(filePath, `${updated}${appended ? `${separator}${appended}${lineEnding}` : ''}`);
}

export async function updateEnvironmentFile(filePath: string, environment: Environment, commonDirectory?: string) {
  const targetPath = await fetchCanonicalPath(filePath);
  if (commonDirectory !== undefined) await assertExportPaths([targetPath], getRegistryPath(commonDirectory));
  const unlock = await lockfile.lock(targetPath, {
    realpath: false,
    retries: { factor: 1, maxTimeout: 100, minTimeout: 100, retries: 200 },
  });
  try {
    await saveEnvironmentFile(targetPath, environment);
  } finally {
    await unlock();
  }
}

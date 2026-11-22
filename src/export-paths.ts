import { stat } from 'node:fs/promises';
import path from 'node:path';

import { PortoError } from './error';
import { checkIsFileMissing, fetchCanonicalPath } from './files';
import { WORKTREE_ID_FILENAME } from './git';
import { getRegistryPath } from './registry';

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

async function assertExportPaths(
  exportPaths: Array<string>,
  registryPath: string,
  extraProtectedPaths: Array<string> = [],
) {
  if (exportPaths.length === 0 && extraProtectedPaths.length === 0) return;
  // Overwriting a worktree identity file detaches its slot: the worktree
  // Loses its reservation and later reserves take new slots.
  const normalizedIdName = normalizePathForComparison(WORKTREE_ID_FILENAME);
  if (exportPaths.some((filePath) => normalizePathForComparison(path.basename(filePath)) === normalizedIdName)) {
    throw new PortoError('exportInvalid', 'The Porto worktree ID file is reserved.');
  }
  const lockPath = `${registryPath}.lock`;
  const [registryTarget, lockTarget] = await Promise.all([
    fetchCanonicalPath(registryPath),
    fetchCanonicalPath(lockPath),
  ]);
  const extraTargets = await Promise.all(extraProtectedPaths.map((filePath) => fetchCanonicalPath(filePath)));
  const registryPaths = new Set([registryPath, registryTarget].map((filePath) => normalizePathForComparison(filePath)));
  const lockPaths = [lockPath, lockTarget].map((filePath) => normalizePathForComparison(filePath));
  const extraPaths = new Set(
    [...extraProtectedPaths, ...extraTargets].map((filePath) => normalizePathForComparison(filePath)),
  );
  const [registryIdentity, lockIdentity, ...otherIdentities] = await Promise.all(
    [registryTarget, lockTarget, ...extraTargets, ...exportPaths].map((filePath) => fetchFileIdentity(filePath)),
  );
  const protectedIdentities = new Set(
    [registryIdentity, lockIdentity, ...otherIdentities.slice(0, extraTargets.length)].filter(
      (identity): identity is string => typeof identity === 'string',
    ),
  );
  const exportIdentities = otherIdentities.slice(extraTargets.length);
  const hasProtectedPath = exportPaths.some((filePath) => {
    const normalizedPath = normalizePathForComparison(filePath);
    return (
      registryPaths.has(normalizedPath) ||
      extraPaths.has(normalizedPath) ||
      lockPaths.some(
        (targetPath) => normalizedPath === targetPath || normalizedPath.startsWith(`${targetPath}${path.sep}`),
      )
    );
  });
  if (hasProtectedPath || exportIdentities.some((identity) => identity && protectedIdentities.has(identity))) {
    throw new PortoError('exportInvalid', 'The Porto registry and its lock are reserved.');
  }
}

async function assertExportTargetsAreFiles(exportPaths: Array<string>) {
  await Promise.all(
    exportPaths.map(async (filePath) => {
      let targetStat;
      try {
        targetStat = await stat(filePath);
      } catch (error) {
        if (checkIsFileMissing(error)) return;
        throw error;
      }
      if (targetStat.isDirectory()) {
        throw new PortoError('exportInvalid', `Export target is a directory: ${filePath}`);
      }
    }),
  );
}

async function fetchExportPaths(
  settings: { env: boolean; envPath: string; jsonPath: false | string },
  commonDirectory: string,
  extraProtectedPaths: Array<string> = [],
) {
  const jsonPath = settings.jsonPath ? await fetchCanonicalPath(path.resolve(settings.jsonPath)) : undefined;
  const envPath = settings.env ? await fetchCanonicalPath(path.resolve(settings.envPath)) : undefined;
  const arePathsEqual =
    jsonPath !== undefined &&
    envPath !== undefined &&
    normalizePathForComparison(jsonPath) === normalizePathForComparison(envPath);
  if (arePathsEqual) throw new PortoError('exportInvalid', '--json-path and --env-path must use different files.');
  if (envPath !== undefined && jsonPath !== undefined) {
    // The env file is written under a lock directory next to it; a JSON
    // Export there would block the lock and hold the registry lock for retries.
    const envLockPath = await fetchCanonicalPath(`${envPath}.lock`);
    const normalizedLock = normalizePathForComparison(envLockPath);
    const normalizedJson = normalizePathForComparison(jsonPath);
    if (normalizedJson === normalizedLock || normalizedJson.startsWith(`${normalizedLock}${path.sep}`)) {
      throw new PortoError('exportInvalid', '--json-path must not target the env file lock.');
    }
  }
  const exportPaths = [jsonPath, envPath].filter((filePath) => filePath !== undefined);
  await assertExportPaths(exportPaths, getRegistryPath(commonDirectory), extraProtectedPaths);
  await assertExportTargetsAreFiles(exportPaths);
  return { envPath, jsonPath };
}

export { assertExportPaths, assertExportTargetsAreFiles, fetchExportPaths, normalizePathForComparison };

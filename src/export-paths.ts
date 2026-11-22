import { stat } from 'node:fs/promises';
import path from 'node:path';

import { PortoError } from './error';
import { checkIsFileMissing, fetchCanonicalPath } from './files';
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

async function assertExportPaths(exportPaths: Array<string>, commonDirectory: string) {
  if (exportPaths.length === 0) return;
  const registryPath = getRegistryPath(commonDirectory);
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
  // Exports must stay out of the actual Git service directory: overwriting
  // Files there breaks Git itself, while ordinary files with colliding names
  // Outside of it are legitimate export targets.
  const canonicalCommon = await fetchCanonicalPath(commonDirectory);
  const insideGit = exportPaths.filter((filePath) => {
    const normalizedPath = normalizePathForComparison(filePath);
    const normalizedCommon = normalizePathForComparison(canonicalCommon);
    return normalizedPath === normalizedCommon || normalizedPath.startsWith(`${normalizedCommon}${path.sep}`);
  });
  if (insideGit.length > 0) {
    throw new PortoError('exportInvalid', `Exports inside the Git directory are reserved: ${insideGit[0]}`);
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

async function assertLockPathUsable(lockPath: string) {
  let targetStat;
  try {
    targetStat = await stat(lockPath);
  } catch (error) {
    if (checkIsFileMissing(error)) return;
    throw error;
  }
  // A regular file where the lock directory belongs makes locking fail after
  // Retries while the registry stays locked; reject it before booking.
  if (!targetStat.isDirectory()) {
    throw new PortoError('exportInvalid', `Export conflicts with an existing file: ${lockPath}`);
  }
}

async function fetchExportPaths(
  settings: { env: boolean; envPath: string; jsonPath: false | string },
  commonDirectory: string,
) {
  const jsonPath = settings.jsonPath ? await fetchCanonicalPath(path.resolve(settings.jsonPath)) : undefined;
  const envPath = settings.env ? await fetchCanonicalPath(path.resolve(settings.envPath)) : undefined;
  const arePathsEqual =
    jsonPath !== undefined &&
    envPath !== undefined &&
    normalizePathForComparison(jsonPath) === normalizePathForComparison(envPath);
  if (arePathsEqual) throw new PortoError('exportInvalid', '--json-path and --env-path must use different files.');
  if (envPath !== undefined) {
    await assertLockPathUsable(await fetchCanonicalPath(`${envPath}.lock`));
  }
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
  await assertExportPaths(exportPaths, commonDirectory);
  await assertExportTargetsAreFiles(exportPaths);
  return { envPath, jsonPath };
}

export { assertExportPaths, assertLockPathUsable, fetchExportPaths };

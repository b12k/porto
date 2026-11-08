import { randomUUID } from 'node:crypto';
import { chmod, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function checkIsFileMissing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function fetchCanonicalPath(filePath: string) {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (!checkIsFileMissing(error)) throw error;
    let targetPath = filePath;
    try {
      targetPath = path.resolve(path.dirname(filePath), await readlink(filePath));
    } catch (linkError) {
      if (
        !checkIsFileMissing(linkError) &&
        !(linkError instanceof Error && 'code' in linkError && linkError.code === 'EINVAL')
      ) {
        throw linkError;
      }
    }
    if (targetPath !== filePath) return fetchCanonicalPath(targetPath);
    return path.join(await realpath(path.dirname(filePath)), path.basename(filePath));
  }
}

export async function writeFileAtomically(filePath: string, contents: string) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let mode: number | undefined;
  try {
    ({ mode } = await stat(filePath));
  } catch (error) {
    if (!checkIsFileMissing(error)) throw error;
  }
  try {
    await writeFile(temporaryPath, contents, { flag: 'wx', mode });
    // File creation applies umask even when a mode is provided.
    if (mode !== undefined) await chmod(temporaryPath, mode);
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

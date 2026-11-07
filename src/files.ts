import { randomUUID } from 'node:crypto';
import { readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
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

async function fetchFileMode(filePath: string) {
  try {
    const file = await stat(filePath);
    return file.mode;
  } catch (error) {
    if (!checkIsFileMissing(error)) throw error;
    return 0o666;
  }
}

export async function writeFileAtomically(filePath: string, contents: string) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  const mode = await fetchFileMode(filePath);
  try {
    await writeFile(temporaryPath, contents, { flag: 'wx', mode });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

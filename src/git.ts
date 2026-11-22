import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { PortoError } from './error';
import { checkIsFileMissing, writeFileAtomically } from './files';

const execFileAsync = promisify(execFile);
const WORKTREE_ID_FILENAME = 'porto-worktree-id';

async function readWorktreeId(gitDirectory: string): Promise<string | undefined> {
  try {
    const contents = await readFile(path.join(gitDirectory, WORKTREE_ID_FILENAME), 'utf8');
    const id = contents.trim();
    return id === '' ? undefined : id;
  } catch (error) {
    if (checkIsFileMissing(error)) return undefined;
    throw error;
  }
}

async function ensureWorktreeId(gitDirectory: string): Promise<string> {
  // Called under the registry lock so parallel first reservations share one ID.
  const existing = await readWorktreeId(gitDirectory);
  if (existing !== undefined) return existing;
  // Atomic write so an interrupted first write leaves no torn file behind.
  // An empty leftover from an older Porto reads back as missing and is replaced.
  const id = randomUUID();
  await writeFileAtomically(path.join(gitDirectory, WORKTREE_ID_FILENAME), `${id}\n`);
  return id;
}

async function fetchGitContext() {
  try {
    const { stdout } = await execFileAsync('git', [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-common-dir',
      '--absolute-git-dir',
    ]);
    const [rootPath, commonPath, gitPath] = stdout.split(/\r?\n/u);
    if (!rootPath || !commonPath || !gitPath) throw new Error('Missing Git paths.');

    const [worktreePath, commonDirectory, gitDirectory] = await Promise.all([
      realpath(rootPath),
      realpath(commonPath),
      realpath(gitPath),
    ]);
    const worktreeId = await readWorktreeId(gitDirectory);
    return { commonDirectory, gitDirectory, worktreeId, worktreePath };
  } catch (error) {
    throw new PortoError('worktreeNotFound', undefined, { cause: error });
  }
}

async function fetchLinkedWorktreeGitDir(worktreePath: string) {
  const gitLink = await readFile(path.join(worktreePath, '.git'), 'utf8');
  const gitPath = /^gitdir: (?<gitPath>.+)\r?\n?$/u.exec(gitLink)?.groups?.['gitPath'];
  return gitPath ? realpath(path.resolve(worktreePath, gitPath)) : undefined;
}

async function listWorktreePaths(commonDirectory: string) {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain', '-z']);
  const worktreePathsById = new Map<string, string>();
  await Promise.all(
    stdout.split('\0\0').map(async (entry, index) => {
      const [location, ...flags] = entry.split('\0');
      if (!location?.startsWith('worktree ') || flags.some((flag) => flag === 'bare' || flag.startsWith('prunable '))) {
        return;
      }
      try {
        const worktreePath = await realpath(location.slice('worktree '.length));
        // Main checkout stores its ID in the common directory; linked checkouts
        // Store it in their service directory so moves keep the ID and
        // Recreations get a new one.
        const gitDirectory =
          index === 0
            ? commonDirectory
            : await fetchLinkedWorktreeGitDir(worktreePath).catch((error: unknown) => {
                if (checkIsFileMissing(error)) return;
                throw error;
              });
        if (!gitDirectory) return;
        const worktreeId = await readWorktreeId(gitDirectory);
        if (worktreeId) worktreePathsById.set(worktreeId, worktreePath);
      } catch (error) {
        if (!checkIsFileMissing(error)) throw error;
      }
    }),
  );
  return worktreePathsById;
}

export { ensureWorktreeId, fetchGitContext, listWorktreePaths, readWorktreeId };

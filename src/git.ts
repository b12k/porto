import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { PortoError } from './error';
import { checkIsFileMissing } from './files';

const execFileAsync = promisify(execFile);

function getWorktreeId(commonDirectory: string, gitDirectory: string) {
  return path.relative(commonDirectory, gitDirectory).split(path.sep).join('/') || '.';
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
    return { commonDirectory, worktreeId: getWorktreeId(commonDirectory, gitDirectory), worktreePath };
  } catch (error) {
    throw new PortoError('worktreeNotFound', undefined, { cause: error });
  }
}

async function fetchLinkedWorktreeId(commonDirectory: string, worktreePath: string) {
  const gitLink = await readFile(path.join(worktreePath, '.git'), 'utf8');
  const gitPath = /^gitdir: (?<gitPath>.+)\r?\n?$/u.exec(gitLink)?.groups?.['gitPath'];
  return gitPath && getWorktreeId(commonDirectory, await realpath(path.resolve(worktreePath, gitPath)));
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
        const worktreeId = index === 0 ? '.' : await fetchLinkedWorktreeId(commonDirectory, worktreePath);
        if (worktreeId) worktreePathsById.set(worktreeId, worktreePath);
      } catch (error) {
        if (!checkIsFileMissing(error)) throw error;
      }
    }),
  );
  return worktreePathsById;
}

export { fetchGitContext, listWorktreePaths };

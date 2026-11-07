import { readFile } from 'node:fs/promises';
import lockfile from 'proper-lockfile';

import { PortoError } from './error';
import { checkIsFileMissing, fetchCanonicalPath, writeFileAtomically } from './files';

export type Environment = Record<string, number | string>;

const ENV_ASSIGNMENT_PATTERN =
  /^(?<prefix>\uFEFF?[ \t]*(?:export[ \t]+)?)(?<name>[A-Za-z_][A-Za-z0-9_]*)(?<separator>[ \t]*=[ \t]*)(?:'[^']*'|"(?:\\[\s\S]|[^"\\])*"|`[^`]*`|[^\r\n#]*?)(?<suffix>[ \t]*(?:#[^\r\n]*)?)(?=\r?$)/gmu;

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

export async function updateEnvironmentFile(filePath: string, environment: Environment) {
  const targetPath = await fetchCanonicalPath(filePath);
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

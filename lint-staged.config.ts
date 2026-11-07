import type { Configuration } from 'lint-staged';

const SCRIPTS = '*.{js,ts}';
const OTHER = `!(${SCRIPTS})`;

const oxfmt = 'pnpm oxfmt --no-error-on-unmatched-pattern';
const oxlint = 'pnpm oxlint --fix';

function getTypeCheckCommand() {
  return 'pnpm check:types';
}

export default {
  [`${SCRIPTS}|SCRIPTS`]: [oxfmt, oxlint],
  [`${SCRIPTS}|TYPES`]: getTypeCheckCommand,
  [OTHER]: oxfmt,
} satisfies Configuration;

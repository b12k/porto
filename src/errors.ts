type ErrorsByKey = Record<string, { instruction: string; message: string }>;

export const ERRORS_BY_KEY = {
  blockUnavailable: {
    instruction: 'Release unused blocks or choose another range.',
    message: 'No free port block remains in the TCP port range.',
  },
  configInvalid: { instruction: 'Check porto.config.ts or porto.config.js.', message: 'Invalid Porto configuration.' },
  exportInvalid: { instruction: 'Check --json-file and --env-file filenames.', message: 'Invalid export options.' },
  hookFailed: {
    instruction: 'The registry change is already saved. Check the hook in your config.',
    message: 'Lifecycle hook failed.',
  },
  mappingInvalid: {
    instruction: 'Use unique variable names, valid callbacks, and a block large enough for all entries.',
    message: 'Invalid variables.',
  },
  offsetInvalid: { instruction: 'Choose an integer offset inside the block.', message: 'Invalid port offset.' },
  optionsInvalid: {
    instruction: 'Check host, start, size, and idleTtlMinutes.',
    message: 'Invalid reservation options.',
  },
  portsBusy: {
    instruction: 'Stop the services using these ports and try again.',
    message: 'Cannot release reservations while ports are in use.',
  },
  registryInvalid: {
    instruction: 'Restore or repair the reservation file before continuing.',
    message: 'Cannot read reservation.',
  },
  reservationNotFound: { instruction: 'Run porto reserve first.', message: 'No reservation for the current worktree.' },
  worktreeNotFound: {
    instruction: 'Run Porto inside a regular Git checkout or linked worktree.',
    message: 'Porto must run inside a Git working tree.',
  },
} as const satisfies ErrorsByKey;

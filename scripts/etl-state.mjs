const TERMINAL_STATES = new Set(['FINISH', 'ERROR', 'FAIL', 'FAILED', 'KILLED', 'STOP']);

export function isEtlTerminalState(state) {
  return TERMINAL_STATES.has(String(state || '').toUpperCase());
}

export function isEtlSuccessful(state) {
  return String(state || '').toUpperCase() === 'FINISH';
}

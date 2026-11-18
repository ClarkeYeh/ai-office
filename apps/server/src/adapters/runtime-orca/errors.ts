import type { ErrorCategory } from '@ai-office/contracts/events';
import { PortError } from '../../ports/errors.js';

const categories: Record<string, ErrorCategory> = {
  no_active_sender_terminal: 'identity',
  stable_pane_required: 'identity',
  consumer_fenced: 'hijacked',
  request_mismatch: 'bug',
  runtime_unavailable: 'transient',
  ECONNREFUSED: 'transient',
  ECONNRESET: 'transient',
  ETIMEDOUT: 'transient',
  ENOENT: 'transient',
};
/** Never carry Orca messages, argv or subprocess output into application logs. */
export function orcaError(code: string): PortError {
  const category = categories[code] ?? 'permanent';
  const safeCode =
    Object.hasOwn(categories, code) || /^[a-z][a-z_]{0,63}$/.test(code)
      ? code
      : 'orca_command_failed';
  return new PortError(
    category,
    safeCode,
    'Orca command failed',
    category === 'transient',
  );
}
export function guard(code: string): PortError {
  return new PortError('guard', code, 'Runtime safety check failed');
}
export function contractMismatch(): PortError {
  return new PortError(
    'contract_mismatch',
    'runtime_contract_mismatch',
    'Runtime response does not match its contract',
  );
}

/** Internal scheduling signal; never delivered as an application error. */
export class CwdInventoryExpired extends Error {}

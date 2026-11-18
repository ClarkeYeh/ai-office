import { z } from 'zod';
import {
  AgentRefSchema,
  SessionRefSchema,
  WorkspaceRefSchema,
  QuestionRefSchema,
  RuntimeCursorSchema,
  type RuntimeCursor,
} from '../../ports/refs.js';
import { contractMismatch } from './errors.js';
export const agentRef = (dispatchId: string) =>
  AgentRefSchema.parse(dispatchId);
export const sessionRef = (runId: string) => SessionRefSchema.parse(runId);
export const workspaceRef = (worktreeId: string) =>
  WorkspaceRefSchema.parse(worktreeId);
export const questionRef = (messageId: string) =>
  QuestionRefSchema.parse(messageId);
const envelope = z.object({ v: z.literal(1), data: z.unknown() });
/** T6 owns data's schema; the wire envelope is frozen here. */
export function encodeCursor<T>(data: T): RuntimeCursor {
  return RuntimeCursorSchema.parse(
    Buffer.from(JSON.stringify({ v: 1, data })).toString('base64url'),
  );
}
export function decodeCursor<T>(
  cursor: RuntimeCursor,
  schema: z.ZodType<T>,
): T {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw contractMismatch();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw contractMismatch();
    return schema.parse(
      envelope.parse(JSON.parse(bytes.toString('utf8'))).data,
    );
  } catch {
    throw contractMismatch();
  }
}

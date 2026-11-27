import { z } from 'zod';
import {
  RepoRuntimeRefSchema,
  RepoScmRefSchema,
  IssueRefSchema,
  PrRefSchema,
} from '@ai-office/contracts/events';

// Serialized opaque strings match command.issued args; consumers must not parse them.
export const SessionRefSchema = z.string().min(1).brand<'SessionRef'>();
export const AgentRefSchema = z.string().min(1).brand<'AgentRef'>();
export const WorkspaceRefSchema = z.string().min(1).brand<'WorkspaceRef'>();
export const QuestionRefSchema = z.string().min(1).brand<'QuestionRef'>();
export const RuntimeCursorSchema = z.string().brand<'RuntimeCursor'>();
export const ScmCursorSchema = z.string().brand<'ScmCursor'>();
export const UsageCursorSchema = z.string().brand<'UsageCursor'>();
export type SessionRef = z.infer<typeof SessionRefSchema>;
export type AgentRef = z.infer<typeof AgentRefSchema>;
export type WorkspaceRef = z.infer<typeof WorkspaceRefSchema>;
export type QuestionRef = z.infer<typeof QuestionRefSchema>;
export type RuntimeCursor = z.infer<typeof RuntimeCursorSchema>;
export type ScmCursor = z.infer<typeof ScmCursorSchema>;
export type UsageCursor = z.infer<typeof UsageCursorSchema>;
export type RepoRuntimeRef = z.infer<typeof RepoRuntimeRefSchema>;
export type RepoScmRef = z.infer<typeof RepoScmRefSchema>;
export type IssueRef = z.infer<typeof IssueRefSchema>;
export type PrRef = z.infer<typeof PrRefSchema>;

export type AgentKind = z.infer<
  typeof import('@ai-office/contracts/template').AgentKindSchema
>;

/**
 * §17.3: the GitHub owner/name of an `origin` URL (HTTPS, scp-like or ssh://),
 * or null for anything else. Registration and the repo candidates share it.
 */
export function parseGithubOrigin(
  originUrl: string | null | undefined,
): RepoScmRef | null {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      originUrl ?? '',
    );
  return match ? { owner: match[1]!, name: match[2]! } : null;
}

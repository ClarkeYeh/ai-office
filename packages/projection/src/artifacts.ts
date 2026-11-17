import type { DomainEvent } from '@ai-office/contracts/events';
import { findAttempt, type ReadModel } from './model.js';

export function applyArtifacts(m: ReadModel, e: DomainEvent): void {
  if (e.type === 'artifact.created') {
    const p = e.payload;
    if (m.artifacts.some((a) => a.artifactId === p.artifactId)) return;
    const stageId =
      e.stageId ??
      ('attemptId' in p
        ? findAttempt(m, p.attemptId)?.attempt.stageId
        : undefined);
    m.artifacts.push({
      artifactId: p.artifactId,
      kind: p.kind,
      ...('submissionId' in p
        ? { submissionId: p.submissionId, attemptId: p.attemptId }
        : {}),
      ...('number' in p ? { number: p.number, url: p.url } : {}),
      ...('name' in p ? { name: p.name } : {}),
      ...('purpose' in p ? { purpose: p.purpose } : {}),
      ...('itemKey' in p && p.itemKey !== undefined
        ? { itemKey: p.itemKey }
        : {}),
      at: e.occurredAt,
      ...(stageId === undefined ? {} : { stageId }),
    });
    const item =
      'itemKey' in p ? m.workItems.find((w) => w.key === p.itemKey) : undefined;
    if (item && p.kind === 'issue')
      item.issue = { number: p.number, url: p.url };
    if (item && p.kind === 'branch') item.branch = p.name;
    // A PR artifact has no headSha/mergeability; PrSummary waits for pr.status.
  } else if (e.type === 'pr.status') {
    const p = e.payload;
    const artifact = m.artifacts.find(
      (a) => a.kind === 'pr' && a.number === p.pr,
    );
    if (
      !artifact ||
      (artifact.purpose !== 'worker' && artifact.purpose !== 'final')
    )
      return;
    const { pr: number, ...status } = p;
    const summary: ReadModel['prs'][number] = {
      ...status,
      number,
      purpose: artifact.purpose,
      updatedAt: e.occurredAt,
      ...(artifact.url === undefined ? {} : { url: artifact.url }),
      ...(artifact.itemKey === undefined ? {} : { itemKey: artifact.itemKey }),
    };
    const index = m.prs.findIndex((pr) => pr.number === number);
    if (index < 0) m.prs.push(summary);
    else m.prs[index] = summary;
    const item = m.workItems.find((w) => w.key === artifact.itemKey);
    if (item) item.pr = { ...summary };
    for (const gate of m.gates)
      if (
        gate.content.type === 'final-pr' &&
        (gate.content.pr === number ||
          gate.content.artifactId === artifact.artifactId)
      )
        gate.pr = { ...summary };
  }
}

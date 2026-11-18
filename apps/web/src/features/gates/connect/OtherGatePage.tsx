import { useWebState } from '../../../realtime/index.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { Link } from '../../../shared/ui/index.js';
import { isRateLimited, type GateAction } from '../model/actions.js';
import { rerunsLeft } from '../model/gateHeader.js';
import { GateLayout, GateNotice } from '../ui/GateLayout.js';
import { TaskSplitGate } from '../ui/TaskSplitGate.js';
import { ExceptionGate } from '../ui/ExceptionGate.js';
import { FinalPrGate } from '../ui/FinalPrGate.js';
import type { GateBodyProps } from './gateBodyTypes.js';
import { useGateDecision } from './useGateDecision.js';

export function OtherGatePage({
  gate,
  model,
  api,
  refetch,
  layout,
}: GateBodyProps) {
  const replaying = useWebState((state) => state.replay !== null);
  const { pending, notice, decide } = useGateDecision(gate, api, refetch);
  const budgetOff =
    gate.exceptionKind?.includes('budget') &&
    model &&
    'budgetEnforcement' in model.limits &&
    model.limits.budgetEnforcement === 'off';
  const disabled = pending || gate.status !== 'open' || !!budgetOff;
  const onDecision = (body: GateAction) => {
    void decide(body, 'gates.done');
  };
  const questionId =
    gate.questionId ??
    (gate.content.type === 'exception' ? gate.content.questionId : undefined);
  const pr =
    model?.prs.find(
      (p) =>
        p.purpose === 'final' &&
        (gate.content.type !== 'final-pr' ||
          gate.content.pr === undefined ||
          p.number === gate.content.pr),
    ) ?? gate.pr;
  const artifact = model?.artifacts.find(
    (a) =>
      a.kind === 'pr' &&
      a.purpose === 'final' &&
      (pr
        ? a.number === pr.number
        : gate.content.type === 'final-pr' &&
          a.artifactId === gate.content.artifactId),
  );
  const attempt =
    gate.content.type === 'exception'
      ? model?.seats
          .flatMap((s) => s.attempts)
          .find(
            (a) =>
              gate.content.type === 'exception' &&
              a.attemptId === gate.content.attemptId,
          )
      : undefined;
  return (
    <GateLayout {...layout}>
      {replaying && <GateNotice tone="info">{t('gates.replay')}</GateNotice>}
      {notice && <GateNotice tone={notice.tone}>{notice.text}</GateNotice>}
      {budgetOff && <p>{t('gates.exception.budgetOff')}</p>}
      {isRateLimited(attempt) && (
        <p data-testid="gate-rate-limited">{t('gates.rateLimited')}</p>
      )}
      {questionId ? (
        <Link
          href={`/questions/${encodeURIComponent(questionId)}`}
          aria-label={t('gates.question.open')}
          data-testid="gate-question-link"
        >
          {t('gates.question.open')}
        </Link>
      ) : gate.content.type === 'work-items' ? (
        <TaskSplitGate
          key={`${gate.gateId}:${gate.version}`}
          gate={gate}
          links={(model?.artifacts ?? []).flatMap((a) =>
            (a.kind === 'issue' || a.kind === 'pr') &&
            a.itemKey &&
            a.number &&
            a.url
              ? [{ key: a.itemKey, kind: a.kind, number: a.number, url: a.url }]
              : [],
          )}
          disabled={disabled}
          onDecision={onDecision}
        />
      ) : gate.content.type === 'final-pr' ? (
        <FinalPrGate
          gate={pr ? { ...gate, pr } : gate}
          url={pr?.url ?? artifact?.url}
          remaining={rerunsLeft(gate, model)}
          disabled={disabled}
          onDecision={onDecision}
        />
      ) : (
        <ExceptionGate
          key={`${gate.gateId}:${gate.version}`}
          gate={gate}
          disabled={disabled}
          onDecision={onDecision}
        />
      )}
    </GateLayout>
  );
}

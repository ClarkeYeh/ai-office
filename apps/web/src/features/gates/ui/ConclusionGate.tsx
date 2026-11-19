import { useEffect, useId, useRef, useState } from 'react';
import { t } from '../../../shared/lib/i18n/index.js';
import { Button, PixelFrame } from '../../../shared/ui/index.js';
import {
  conclusionFromDraft,
  draftFromConclusion,
  emptyTechDraft,
  type Conclusion,
  type ConclusionDiff,
  type ConclusionDocument,
  type ConclusionDraft,
  type ConclusionViewModel,
} from '../model/index.js';
import { GateLayout, GateNotice, type GateLayoutProps } from './GateLayout.js';
import styles from './gates.module.css';

export type ConclusionView = 'github' | 'original' | 'diff';
export interface ConclusionGateProps {
  layout: Omit<GateLayoutProps, 'children' | 'decision'>;
  vm: ConclusionViewModel;
  version: number;
  /** Decision in flight, or the GitHub body hash is still being computed. */
  pending: boolean;
  notice: { tone: 'info' | 'error'; text: string } | null;
  /** Bumped on every 409: the page re-shows the diff so the owner re-confirms. */
  conflicts: number;
  onApprove: () => Promise<boolean>;
  onRevise: (conclusion: Conclusion) => Promise<boolean>;
  onReject: (feedback: string) => Promise<boolean>;
}

const VIEWS: readonly ConclusionView[] = ['github', 'original', 'diff'];

function StructuredConclusion({ conclusion }: { conclusion: Conclusion }) {
  const none = <p>{t('gates.conclusion.none')}</p>;
  return (
    <div className={styles.doc}>
      <h4>{t('gates.conclusion.summary')}</h4>
      <p>{conclusion.summary || t('gates.conclusion.none')}</p>
      <h4>{t('gates.conclusion.decisions')}</h4>
      {conclusion.decisions.length ? (
        <ol>
          {conclusion.decisions.map((d, i) => (
            <li key={i}>
              {d.title}
              {d.rationale && (
                <span className={styles.considered}> {d.rationale}</span>
              )}
            </li>
          ))}
        </ol>
      ) : (
        none
      )}
      <h4>{t('gates.conclusion.tech')}</h4>
      {conclusion.techDecisions.length ? (
        <table className={styles.table} data-testid="conclusion-tech-table">
          <thead>
            <tr>
              <th scope="col">{t('gates.conclusion.tech.topic')}</th>
              <th scope="col">{t('gates.conclusion.tech.options')}</th>
              <th scope="col">{t('gates.conclusion.tech.chosen')}</th>
              <th scope="col">{t('gates.conclusion.tech.rationale')}</th>
            </tr>
          </thead>
          <tbody>
            {conclusion.techDecisions.map((d, i) => (
              <tr key={i}>
                <td>{d.topic}</td>
                <td className={styles.considered}>{d.options.join('、')}</td>
                <td>
                  <strong>{d.chosen}</strong>
                </td>
                <td>{d.rationale}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        none
      )}
      <h4>{t('gates.conclusion.open')}</h4>
      {conclusion.openQuestions.length ? (
        <ul>
          {conclusion.openQuestions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ul>
      ) : (
        none
      )}
    </div>
  );
}

function ConclusionDocumentView({
  document,
  unavailable,
}: {
  document: ConclusionDocument;
  unavailable: string;
}) {
  if (document.kind === 'unavailable')
    return <p data-testid="conclusion-unavailable">{unavailable}</p>;
  if (document.kind === 'raw')
    return (
      <>
        <p className={styles.callout}>{t('gates.conclusion.unparsed')}</p>
        <pre className={styles.raw} data-testid="conclusion-raw">
          {document.text}
        </pre>
      </>
    );
  return <StructuredConclusion conclusion={document.conclusion} />;
}

function DiffView({ diff }: { diff: ConclusionDiff }) {
  if (diff.kind === 'unavailable')
    return (
      <p data-testid="conclusion-diff-unavailable">
        {t('gates.conclusion.diffUnavailable')}
      </p>
    );
  return (
    <>
      <p className={styles.small}>{t('gates.conclusion.diffLegend')}</p>
      {diff.truncated && (
        <p className={styles.small}>
          {t('gates.conclusion.diffTooLong', { max: 2000 })}
        </p>
      )}
      {diff.same && (
        <p data-testid="conclusion-diff-same">
          {t('gates.conclusion.diffSame')}
        </p>
      )}
      <ol className={styles.diff} data-testid="conclusion-diff">
        {diff.lines.map((line, i) => (
          <li
            key={i}
            data-kind={line.kind}
            className={
              line.kind === 'added'
                ? styles.diffAdded
                : line.kind === 'removed'
                  ? styles.diffRemoved
                  : undefined
            }
          >
            {line.kind !== 'same' && (
              <span className={styles.srOnly}>
                {line.kind === 'added'
                  ? t('gates.conclusion.diffAdded')
                  : t('gates.conclusion.diffRemoved')}
              </span>
            )}
            {line.text || ' '}
          </li>
        ))}
      </ol>
    </>
  );
}

function ConclusionEditor({
  draft,
  onChange,
}: {
  draft: ConclusionDraft;
  onChange: (draft: ConclusionDraft) => void;
}) {
  const setTech = (
    index: number,
    patch: Partial<ConclusionDraft['techDecisions'][number]>,
  ) =>
    onChange({
      ...draft,
      techDecisions: draft.techDecisions.map((d, i) =>
        i === index ? { ...d, ...patch } : d,
      ),
    });
  const textarea = (
    field: 'summary' | 'decisions' | 'openQuestions',
    label: string,
  ) => (
    <label>
      {label}
      <textarea
        className={styles.textarea}
        value={draft[field]}
        aria-label={label}
        data-testid={`conclusion-edit-${field}`}
        onChange={(event) =>
          onChange({ ...draft, [field]: event.target.value })
        }
      />
    </label>
  );
  return (
    <div className={styles.editor}>
      {textarea('summary', t('gates.conclusion.edit.summary'))}
      {textarea('decisions', t('gates.conclusion.edit.decisions'))}
      {draft.techDecisions.map((d, i) => {
        const n = i + 1;
        const input = (
          field: keyof typeof d,
          key:
            | 'gates.conclusion.edit.techTopic'
            | 'gates.conclusion.edit.techOptions'
            | 'gates.conclusion.edit.techChosen'
            | 'gates.conclusion.edit.techRationale',
        ) => (
          <label>
            {t(key, { n })}
            <input
              value={d[field]}
              aria-label={t(key, { n })}
              data-testid={`conclusion-edit-tech-${i}-${field}`}
              onChange={(event) => setTech(i, { [field]: event.target.value })}
            />
          </label>
        );
        return (
          <div key={i} className={styles.techEdit}>
            {input('topic', 'gates.conclusion.edit.techTopic')}
            {input('options', 'gates.conclusion.edit.techOptions')}
            {input('chosen', 'gates.conclusion.edit.techChosen')}
            {input('rationale', 'gates.conclusion.edit.techRationale')}
            <Button
              aria-label={t('gates.conclusion.edit.techRemove', { n })}
              data-testid={`conclusion-edit-tech-${i}-remove`}
              onClick={() =>
                onChange({
                  ...draft,
                  techDecisions: draft.techDecisions.filter((_, j) => j !== i),
                })
              }
            >
              {t('gates.conclusion.edit.techRemove', { n })}
            </Button>
          </div>
        );
      })}
      <Button
        aria-label={t('gates.conclusion.edit.techAdd')}
        data-testid="conclusion-edit-tech-add"
        onClick={() =>
          onChange({
            ...draft,
            techDecisions: [...draft.techDecisions, emptyTechDraft()],
          })
        }
      >
        {t('gates.conclusion.edit.techAdd')}
      </Button>
      {textarea('openQuestions', t('gates.conclusion.edit.openQuestions'))}
    </div>
  );
}

/** Conclusion gate page (I-12, M4_DESIGN §4.3). */
export function ConclusionGate({
  layout,
  vm,
  version,
  pending,
  notice,
  conflicts,
  onApprove,
  onRevise,
  onReject,
}: ConclusionGateProps) {
  const open = layout.header.open;
  const [view, setView] = useState<ConclusionView>(
    vm.github.kind === 'unavailable' && vm.original.kind !== 'unavailable'
      ? 'original'
      : 'github',
  );
  const [draft, setDraft] = useState<ConclusionDraft | null>(null);
  const [feedback, setFeedback] = useState('');
  const [feedbackError, setFeedbackError] = useState(false);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const feedbackId = useId();
  const tabsId = useId();
  // A 409 means the content moved under the owner: show what changed, then ask again.
  useEffect(() => {
    if (conflicts > 0) setView('diff');
  }, [conflicts]);
  const after =
    layout.header.facts.find((fact) => fact.id === 'after')?.value ?? '';
  const reruns = layout.header.rerunsLeft;
  const callout =
    vm.github.kind === 'unavailable'
      ? t('gates.conclusion.githubUnavailable')
      : vm.changedOnGithub
        ? t('gates.conclusion.githubEdited')
        : t('gates.conclusion.githubWins');
  const reject = async () => {
    if (!feedback.trim()) {
      setFeedbackError(true);
      feedbackRef.current?.focus();
      return;
    }
    if (await onReject(feedback.trim())) setFeedback('');
  };
  const decision = open ? (
    <>
      <Button
        variant="primary"
        aria-label={t('gates.conclusion.approve')}
        data-testid="gate-approve"
        disabled={pending}
        onClick={() => void onApprove()}
      >
        {t('gates.conclusion.approve')}
      </Button>
      <p className={styles.small}>
        {t('gates.conclusion.approveHint', { version, after })}
      </p>
      <Button
        aria-label={t('gates.conclusion.revise')}
        aria-expanded={draft !== null}
        data-testid="gate-revise"
        disabled={pending || vm.editBase === null}
        onClick={() =>
          setDraft(
            draft === null && vm.editBase
              ? draftFromConclusion(vm.editBase.conclusion)
              : null,
          )
        }
      >
        {t('gates.conclusion.revise')}
      </Button>
      <p className={styles.small}>
        {vm.editBase === null
          ? t('gates.conclusion.reviseUnavailable')
          : t('gates.conclusion.reviseHint', {
              issue: vm.issue ? ` #${vm.issue.number}` : '',
            })}
      </p>
      <hr className={styles.divider} />
      <h4 className={styles.sectionTitle}>
        {t('gates.conclusion.rejectTitle')}
      </h4>
      <textarea
        ref={feedbackRef}
        id={feedbackId}
        className={styles.textarea}
        value={feedback}
        required
        aria-required="true"
        aria-invalid={feedbackError}
        aria-label={t('gates.conclusion.feedback')}
        aria-describedby={`${feedbackId}-hint`}
        data-testid="gate-feedback"
        onChange={(event) => {
          setFeedback(event.target.value);
          if (event.target.value.trim()) setFeedbackError(false);
        }}
      />
      {feedbackError && (
        <p
          className={styles.invalid}
          role="alert"
          data-testid="gate-feedback-error"
        >
          {t('gates.conclusion.feedbackRequired')}
        </p>
      )}
      <p id={`${feedbackId}-hint`} className={styles.small}>
        {reruns !== null && reruns <= 0
          ? t('gates.conclusion.feedbackHintLast')
          : t('gates.conclusion.feedbackHint', { count: reruns ?? 0 })}
      </p>
      <Button
        variant="danger"
        aria-label={t('gates.conclusion.reject')}
        data-testid="gate-reject"
        disabled={pending}
        onClick={() => void reject()}
      >
        {t('gates.conclusion.reject')}
      </Button>
    </>
  ) : undefined;
  return (
    <GateLayout
      {...layout}
      notice={
        <>
          {layout.notice}
          {notice && <GateNotice tone={notice.tone}>{notice.text}</GateNotice>}
        </>
      }
      decision={decision}
    >
      {draft !== null && vm.editBase && (
        <PixelFrame data-testid="conclusion-editor">
          <h3 className={styles.docTitle}>{t('gates.conclusion.revise')}</h3>
          <p className={styles.small}>
            {vm.editBase.source === 'github'
              ? t('gates.conclusion.reviseFrom')
              : t('gates.conclusion.reviseFromOriginal')}
          </p>
          <ConclusionEditor draft={draft} onChange={setDraft} />
          <div className={styles.docHeader}>
            <Button
              aria-label={t('gates.conclusion.reviseSubmit')}
              data-testid="gate-revise-submit"
              disabled={pending}
              onClick={() =>
                void onRevise(conclusionFromDraft(draft)).then((ok) => {
                  if (ok) setDraft(null);
                })
              }
            >
              {t('gates.conclusion.reviseSubmit')}
            </Button>
            <Button
              aria-label={t('gates.conclusion.reviseCancel')}
              data-testid="gate-revise-cancel"
              onClick={() => setDraft(null)}
            >
              {t('gates.conclusion.reviseCancel')}
            </Button>
          </div>
        </PixelFrame>
      )}
      <PixelFrame data-testid="conclusion-document">
        <div className={styles.docHeader}>
          <div>
            <h3 className={styles.docTitle}>{t('gates.conclusion.title')}</h3>
            {vm.issue && (
              <a
                href={vm.issue.url}
                target="_blank"
                rel="noreferrer"
                aria-label={t('gates.conclusion.openIssue', {
                  number: vm.issue.number,
                })}
                data-testid="conclusion-issue-link"
              >
                {t('gates.conclusion.openIssue', { number: vm.issue.number })}
              </a>
            )}
          </div>
          <div
            className={styles.tabs}
            role="tablist"
            aria-label={t('gates.conclusion.views')}
          >
            {VIEWS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`${tabsId}-${id}`}
                aria-selected={view === id}
                aria-controls={`${tabsId}-panel`}
                aria-label={t(`gates.conclusion.view.${id}`)}
                data-testid={`conclusion-view-${id}`}
                onClick={() => setView(id)}
              >
                {t(`gates.conclusion.view.${id}`)}
              </button>
            ))}
          </div>
        </div>
        <p className={styles.callout} data-testid="conclusion-callout">
          {callout}
        </p>
        <div
          role="tabpanel"
          id={`${tabsId}-panel`}
          aria-labelledby={`${tabsId}-${view}`}
          data-testid={`conclusion-panel-${view}`}
        >
          {view === 'github' ? (
            <ConclusionDocumentView
              document={vm.github}
              unavailable={t('gates.conclusion.githubUnavailable')}
            />
          ) : view === 'original' ? (
            <ConclusionDocumentView
              document={vm.original}
              unavailable={t('gates.conclusion.originalUnavailable')}
            />
          ) : (
            <DiffView diff={vm.diff} />
          )}
        </div>
      </PixelFrame>
      <PixelFrame data-testid="conclusion-statements">
        <h3 className={styles.sectionTitle}>
          {t('gates.conclusion.round', { round: vm.round ?? 2 })}
        </h3>
        {vm.statements.length ? (
          <ul className={styles.statements}>
            {vm.statements.map((s, i) => (
              <li key={i}>
                <span className={styles.role}>{s.role}</span>
                <span>{s.position}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.muted}>{t('gates.conclusion.noStatements')}</p>
        )}
      </PixelFrame>
    </GateLayout>
  );
}

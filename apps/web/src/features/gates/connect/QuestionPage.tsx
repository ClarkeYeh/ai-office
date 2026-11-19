import { useEffect, useRef, useState } from 'react';
import type { QuestionView } from '../model/index.js';
import { ApiError, createIdempotencyKey } from '../../../api/index.js';
import { useRealtime, useWebState } from '../../../realtime/index.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { Question } from '../ui/Question.js';
import { GateNotice, GateStatusMessage } from '../ui/GateLayout.js';
import type { GatePageProps } from './GatePage.js';
export function QuestionPage({ route, api }: GatePageProps) {
  const id = route.params.id ?? '';
  const realtime = useRealtime();
  const replay = useWebState((state) => state.replay);
  const inbox = useWebState((state) => state.overview.questions);
  const [load, setLoad] = useState<{
    id: string;
    question: QuestionView | null;
  } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [answered, setAnswered] = useState<string | null>(null);
  const action = useRef<{ fingerprint: string; key: string } | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    api
      .listQuestions({ status: 'escalated' }, { signal: controller.signal })
      .then(
        (result) => {
          if (!controller.signal.aborted)
            setLoad({
              id,
              question:
                result.questions.find((q) => q.questionId === id) ?? null,
            });
        },
        () => {
          if (!controller.signal.aborted) setNotice(t('gates.loadFailed'));
        },
      );
    return () => controller.abort();
  }, [id, api, nonce, inbox]);
  const question =
    replay !== null
      ? replay.model?.questions.find((q) => q.questionId === id)
      : load?.id === id
        ? load.question
        : null;
  async function answer(body: string, optionId?: string) {
    if (
      busy.current ||
      realtime.store.getState().replay !== null ||
      question?.status !== 'escalated' ||
      answered === id
    )
      return;
    const request = { body, ...(optionId ? { optionId } : {}) };
    const fingerprint = JSON.stringify([id, request]);
    const key =
      action.current?.fingerprint === fingerprint
        ? action.current.key
        : createIdempotencyKey();
    action.current = { fingerprint, key };
    busy.current = true;
    setPending(true);
    setNotice(null);
    try {
      await api.answerQuestion(id, request, { idempotencyKey: key });
      action.current = null;
      setAnswered(id);
      setNotice(t('gates.question.done'));
      setNonce((n) => n + 1);
    } catch (error) {
      setNotice(
        t('gates.error.generic', {
          code: error instanceof ApiError ? error.code : 'network_error',
        }),
      );
      if (error instanceof ApiError && error.status !== 0)
        action.current = null;
      if (error instanceof ApiError && error.status === 409) {
        setLoad(null);
        setNonce((n) => n + 1);
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <>
      {replay !== null && (
        <GateNotice tone="info">{t('gates.replay')}</GateNotice>
      )}
      {notice && (
        <GateNotice tone={answered === id ? 'info' : 'error'}>
          {notice}
        </GateNotice>
      )}
      {question ? (
        <Question
          key={id}
          question={question}
          disabled={
            pending ||
            replay !== null ||
            question.status !== 'escalated' ||
            answered === id
          }
          onAnswer={(body, option) => {
            void answer(body, option);
          }}
        />
      ) : (
        <GateStatusMessage
          message={
            load?.id === id || replay !== null
              ? t('gates.question.missing')
              : t('gates.loading')
          }
        />
      )}
    </>
  );
}

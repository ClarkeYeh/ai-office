import { DecisionSections, type BodyLayout } from './DecisionSections.js';
import { useState } from 'react';
import { t } from '../../../shared/lib/i18n/index.js';
import { Button, Link, PixelFrame } from '../../../shared/ui/index.js';
import {
  dependencyErrors,
  type GateAction,
  type WorkItemDraft,
} from '../model/actions.js';
import type { GateView } from '../model/index.js';
import styles from './forms.module.css';

export function TaskSplitGate({
  gate,
  layout,
  disabled,
  onDecision,
  links = [],
}: {
  links?: readonly {
    key: string;
    kind: 'issue' | 'pr';
    number: number;
    url: string;
  }[];
  layout?: BodyLayout | undefined;
  gate: GateView;
  disabled: boolean;
  onDecision: (body: GateAction) => void;
}) {
  const [items, setItems] = useState<WorkItemDraft[]>(gate.workItems ?? []);
  const [newKey, setNewKey] = useState('');
  const [feedback, setFeedback] = useState('');
  const errors = dependencyErrors(items);
  const changed =
    JSON.stringify(items) !== JSON.stringify(gate.workItems ?? []);
  const editable = new Set(gate.editable ?? []);
  const canAdd = ['title', 'body', 'acceptance', 'role', 'deps'].every(
    (field) => editable.has(field as NonNullable<GateView['editable']>[number]),
  );
  function update(index: number, field: keyof WorkItemDraft, value: string) {
    setItems((prev) =>
      prev.map((item, n) => {
        if (n !== index) return item;
        if (field === 'agent') {
          const rest = { ...item };
          delete rest.agent;
          return value === 'codex' || value === 'claude-code'
            ? { ...rest, agent: value }
            : rest;
        }
        return {
          ...item,
          [field]:
            field === 'acceptance'
              ? value.split('\n')
              : field === 'deps'
                ? value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
                : value,
        };
      }),
    );
  }
  return (
    <DecisionSections
      layout={layout}
      actions={
        <>
          <Button
            aria-label={t(
              changed ? 'gates.tasks.revise' : 'gates.tasks.approve',
            )}
            variant="primary"
            data-testid="tasks-approve"
            disabled={disabled || errors.length > 0 || !items.length}
            onClick={() =>
              onDecision(
                changed
                  ? { decision: 'revise', edits: { type: 'work-items', items } }
                  : { decision: 'approve' },
              )
            }
          >
            {t(changed ? 'gates.tasks.revise' : 'gates.tasks.approve')}
          </Button>
          <label className={styles.field}>
            {t('gates.feedback')}
            <textarea
              aria-label={t('gates.feedback')}
              data-testid="tasks-feedback"
              value={feedback}
              disabled={disabled}
              onChange={(e) => setFeedback(e.target.value)}
            />
          </label>
          <Button
            variant="danger"
            aria-label={t('gates.tasks.reject')}
            data-testid="tasks-reject"
            disabled={disabled || !feedback.trim()}
            onClick={() =>
              onDecision({ decision: 'reject', comment: feedback.trim() })
            }
          >
            {t('gates.tasks.reject')}
          </Button>
        </>
      }
    >
      <h3>{t('gates.tasks.title')}</h3>
      <p>{t('gates.tasks.authority')}</p>
      {items.map((item, index) => (
        <PixelFrame key={item.key}>
          <h4>{item.key}</h4>
          <Button
            variant="danger"
            aria-label={t('gates.tasks.remove', { key: item.key })}
            data-testid={`item-${item.key}-remove`}
            disabled={disabled}
            onClick={() =>
              setItems((prev) => prev.filter((i) => i.key !== item.key))
            }
          >
            {t('gates.tasks.remove', { key: item.key })}
          </Button>
          {links
            .filter((link) => link.key === item.key)
            .map((link) => (
              <Link
                key={`${link.kind}-${link.number}`}
                href={link.url}
                target="_blank"
                rel="noreferrer"
                aria-label={t(`gates.item.${link.kind}`, {
                  number: link.number,
                })}
                data-testid={`item-${item.key}-${link.kind}`}
              >
                {t(`gates.item.${link.kind}`, { number: link.number })}
              </Link>
            ))}
          {(
            ['title', 'body', 'acceptance', 'role', 'agent', 'deps'] as const
          ).map((field) => {
            const label = t(
              field === 'title'
                ? 'gates.tasks.titleField'
                : `gates.tasks.${field}`,
            );
            const value = item[field];
            return (
              <label className={styles.field} key={field}>
                {label}
                {field === 'agent' ? (
                  <select
                    aria-label={`${item.key}: ${label}`}
                    data-testid={`item-${item.key}-${field}`}
                    disabled={disabled || !editable.has(field)}
                    value={value ?? ''}
                    onChange={(e) => update(index, field, e.target.value)}
                  >
                    <option value="">{t('gates.tasks.defaultAgent')}</option>
                    <option value="claude-code">
                      {t('office.vendor.claude-code')}
                    </option>
                    <option value="codex">{t('office.vendor.codex')}</option>
                  </select>
                ) : (
                  <textarea
                    aria-label={`${item.key}: ${label}`}
                    data-testid={`item-${item.key}-${field}`}
                    disabled={disabled || !editable.has(field)}
                    value={
                      Array.isArray(value)
                        ? value.join(field === 'deps' ? ', ' : '\n')
                        : value
                    }
                    onChange={(e) => update(index, field, e.target.value)}
                  />
                )}
              </label>
            );
          })}
        </PixelFrame>
      ))}
      {canAdd && (
        <div className={styles.stack}>
          <label className={styles.field}>
            {t('gates.tasks.key')}
            <input
              aria-label={t('gates.tasks.key')}
              data-testid="task-new-key"
              value={newKey}
              disabled={disabled}
              onChange={(e) => setNewKey(e.target.value)}
            />
          </label>
          <p>{t('gates.tasks.keyHint')}</p>
          <Button
            aria-label={t('gates.tasks.add')}
            data-testid="task-add"
            disabled={
              disabled ||
              !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(newKey) ||
              items.some((item) => item.key === newKey)
            }
            onClick={() => {
              setItems((prev) => [
                ...prev,
                {
                  key: newKey,
                  title: '',
                  body: '',
                  acceptance: [],
                  role: '',
                  deps: [],
                },
              ]);
              setNewKey('');
            }}
          >
            {t('gates.tasks.add')}
          </Button>
        </div>
      )}
      {errors.length > 0 && (
        <p role="alert">
          {t('gates.tasks.invalid', { keys: errors.join(', ') })}
        </p>
      )}
    </DecisionSections>
  );
}

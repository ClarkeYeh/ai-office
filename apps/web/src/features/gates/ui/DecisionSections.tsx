import type { ReactNode } from 'react';
import { GateLayout, type GateLayoutProps } from './GateLayout.js';
import styles from './forms.module.css';
export type BodyLayout = Omit<GateLayoutProps, 'children' | 'decision'>;
/** Keep form state local while placing decision controls in the common shell's slot. */
export function DecisionSections({
  layout,
  actions,
  children,
}: {
  layout?: BodyLayout | undefined;
  actions: ReactNode;
  children: ReactNode;
}) {
  const content = <section className={styles.stack}>{children}</section>;
  const decision = <div className={styles.stack}>{actions}</div>;
  return layout ? (
    <GateLayout {...layout} decision={decision}>
      {content}
    </GateLayout>
  ) : (
    <>
      {content}
      {decision}
    </>
  );
}

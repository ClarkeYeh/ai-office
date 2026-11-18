import type { Conclusion } from '../model/index.js';

// Mirrors the engine's renderMeetingConclusion (packages/engine/src/stages/meeting.ts);
// web must not import engine, so fixtures render the same shape here.
export function renderConclusion(conclusion: Conclusion): string {
  return [
    '# Meeting conclusion',
    ...(
      ['summary', 'decisions', 'techDecisions', 'openQuestions'] as const
    ).flatMap((key) => [
      '',
      `<!-- ai-office:${key}:start -->`,
      `## ${key}`,
      JSON.stringify(conclusion[key], null, 2),
      `<!-- ai-office:${key}:end -->`,
    ]),
  ].join('\n');
}
export const withMarker = (body: string, id = 'wf1/meeting/1/issue') =>
  `${body}\n\n<!-- ai-office:cmd=${id} -->`;

export const CONCLUSION: Conclusion = {
  summary: 'Use CSS variables and a ThemeProvider',
  decisions: [
    { title: 'Site-wide theme', rationale: 'no per-component colours' },
    { title: 'Toggle in settings', rationale: '' },
  ],
  techDecisions: [
    {
      topic: 'Theming',
      options: ['CSS variables', 'CSS-in-JS'],
      chosen: 'CSS variables',
      rationale: 'no re-render',
    },
  ],
  openQuestions: ['Add a third option?'],
};
export const EDITED: Conclusion = {
  ...CONCLUSION,
  decisions: [
    ...CONCLUSION.decisions,
    { title: 'Apply saved theme before first paint', rationale: '' },
  ],
};

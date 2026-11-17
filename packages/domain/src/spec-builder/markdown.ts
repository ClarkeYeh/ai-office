import type { SpecSection } from './types.js';

/**
 * A fenced block whose fence is longer than any backtick run in `content`, so
 * user-provided text (requirement, conclusion, question bodies) cannot close it.
 */
export const fenced = (content: string, info = 'text'): string[] => {
  const longest = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [`${fence}${info}`, ...content.split('\n'), fence];
};

/** POSIX single-quoting: safe for any path or token. */
export const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

export const bullets = (items: readonly string[]): string[] =>
  items.map((item) => `- ${item}`);

/** Renders sections as numbered Markdown; the output always ends with one newline. */
export const renderSpec = (
  title: string,
  intro: readonly string[],
  sections: readonly SpecSection[],
): string =>
  [
    `# ${title}`,
    '',
    ...intro,
    ...sections.flatMap((section, index) => [
      '',
      `## ${index + 1}. ${section.title}`,
      '',
      ...section.lines,
    ]),
  ].join('\n') + '\n';

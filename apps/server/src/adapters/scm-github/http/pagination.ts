import { guard } from '../policy/endpoints.js';
/** Follow only a page number on the exact authorized URL, never a Link destination. */
export function nextPage(
  link: string | null,
  current: URL,
): number | undefined {
  if (!link) return;
  const matches = [...link.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)].filter(
    (match) => match[2]!.split(' ').includes('next'),
  );
  if (!matches.length) return;
  if (matches.length !== 1) guard('invalid_pagination');
  let next: URL;
  try {
    next = new URL(matches[0]![1]!);
  } catch {
    return guard('invalid_pagination');
  }
  if (
    next.origin !== current.origin ||
    next.username ||
    next.password ||
    next.hash ||
    next.pathname !== current.pathname
  )
    guard('invalid_pagination');
  const page = next.searchParams.get('page');
  if (!page || !/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page)))
    guard('invalid_pagination');
  const withoutPage = (url: URL) => {
    const params = new URLSearchParams(url.search);
    params.delete('page');
    params.sort();
    return params.toString();
  };
  if (withoutPage(next) !== withoutPage(current)) guard('invalid_pagination');
  if (Number(page) <= Number(current.searchParams.get('page') ?? 1))
    guard('pagination_repeated');
  return Number(page);
}

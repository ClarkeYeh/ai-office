// Structural sharing for view models (M4_PLAN §3.3): a freshly computed value keeps
// the previous object for every subtree that is deeply equal, so `React.memo`
// components can skip rendering by shallow comparison.

type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

/**
 * Returns `prev` when `next` is deeply equal to it; otherwise `next`, with every
 * deeply equal child replaced by its counterpart from `prev`. Only arrays and plain
 * objects are walked; other values compare with `Object.is`. Neither input is mutated.
 */
export function stabilize<T>(prev: T | null | undefined, next: T): T {
  return share(prev, next) as T;
}

function share(prev: unknown, next: unknown): unknown {
  if (Object.is(prev, next)) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) {
    const out = next.map((item, i) => share(prev[i], item));
    return prev.length === out.length &&
      out.every((item, i) => item === prev[i])
      ? prev
      : out;
  }
  if (isPlain(prev) && isPlain(next)) {
    const keys = Object.keys(next);
    let same = keys.length === Object.keys(prev).length;
    const entries = keys.map((key) => {
      const value = Object.hasOwn(prev, key)
        ? share(prev[key], next[key])
        : next[key];
      if (!Object.hasOwn(prev, key) || value !== prev[key]) same = false;
      return [key, value] as const;
    });
    // fromEntries defines own data properties, so keys such as `__proto__`
    // (work-item keys come from agents) round-trip instead of hitting the setter.
    return same ? prev : Object.fromEntries(entries);
  }
  return next;
}

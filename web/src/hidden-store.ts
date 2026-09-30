import type { HiddenKey } from './visibility';

export interface HiddenStore {
  /** Newest first. */
  keys(): readonly HiddenKey[];
  has(key: HiddenKey): boolean;
  add(key: HiddenKey): void;
  remove(key: HiddenKey): void;
  clear(): void;
  subscribe(listener: (keys: readonly HiddenKey[]) => void): void;
}

// Persists per project in localStorage. Without storage (private mode, blocked site data)
// the list still works for the session.
export function createHiddenStore(project: string): HiddenStore {
  const storageKey = `arachne:hidden:${project}`;
  let keys: HiddenKey[] = load(storageKey);
  const listeners: ((keys: readonly HiddenKey[]) => void)[] = [];

  const commit = (next: HiddenKey[]) => {
    keys = next;
    try {
      localStorage.setItem(storageKey, JSON.stringify(keys));
    } catch {
      // See above: the in-memory list stays authoritative.
    }
    for (const l of listeners) l(keys);
  };

  return {
    keys: () => keys,
    has: (key) => keys.includes(key),
    add: (key) => !keys.includes(key) && commit([key, ...keys]),
    remove: (key) => keys.includes(key) && commit(keys.filter((k) => k !== key)),
    clear: () => keys.length > 0 && commit([]),
    subscribe: (l) => void listeners.push(l),
  };
}

function load(storageKey: string): HiddenKey[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(raw) ? raw.filter((k): k is HiddenKey => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

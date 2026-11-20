// The one way StudyDesk reaches the claude.ai artifact runtime (window.claude).
//
// It also makes the page read-only when an update couldn't upgrade the data
// (design/updates.md, "If anything fails"): every store keeps working for
// reading, but any write to the database is refused, so the new version can
// never save half-understood data over the student's real data. Only the
// update itself (this module's `raw` access) and cloud-session job documents
// (how "Go back" reports) may still write.

type Host = { use: Claude["use"] };

let readOnly: string | null = null;

/** Turns read-only mode on (with the reason shown on refused saves) or off. */
export function setReadOnly(reason: string | null): void {
  readOnly = reason;
}

export const isReadOnly = () => readOnly !== null;

export class ReadOnlyError extends Error {
  code = "read_only";
}

const WRITES = new Set(["set", "update", "delete", "add"]);
/** Job documents (data/users/<uid>/job-…) stay writable: hand-off reports through them. */
const allowed = (path: string) => /^data\/users\/[^/]+\/job-[^/]+$/.test(path);

// The runtime's objects are frozen, so the guard is a stand-in that passes
// every call through (a Proxy over the real object itself would break the
// rules for frozen objects).
function guard<T extends object>(real: T, path: string): T {
  return new Proxy({} as T, {
    has: (_t, prop) => prop in real,
    get(_t, prop) {
      const v = (real as Record<PropertyKey, unknown>)[prop];
      if (typeof v !== "function") return v;
      const name = String(prop);
      return (...args: unknown[]) => {
        if (readOnly && WRITES.has(name) && !allowed(path)) return Promise.reject(new ReadOnlyError(`Not saved: ${readOnly}`));
        const out = (v as (...a: unknown[]) => unknown).apply(real, args);
        // Refs made from refs (doc → collection → doc) get the same guard.
        if (out && typeof out === "object" && (name === "doc" || name === "collection")) {
          const sub = (out as { path?: string }).path ?? `${path}/${String(args[0] ?? "")}`;
          return guard(out as object, sub);
        }
        return out;
      };
    },
  });
}

function window_(): Host | null {
  const c = (globalThis as { claude?: Claude }).claude;
  return c?.use ? c : null;
}

/**
 * The runtime as the rest of the page uses it, or null outside claude.ai.
 * `raw` skips the read-only guard: only for the update module.
 */
export function host(opts: { raw?: boolean } = {}): Host | null {
  const c = window_();
  if (!c) return null;
  if (opts.raw) return c;
  return {
    use: ((name: string) =>
      c.use(name as never).then((ns) => (name === "db" && ns ? (guard(ns as object, "") as never) : ns))) as Claude["use"],
  };
}

const TTL_MS = 5000;

type ExecBrowser = (args: string[], cdpUrl?: string) => Promise<{ stdout: string; exitCode: number }>;

interface CacheEntry {
  text: string;
  capturedAt: number;
}

const cache = new Map<string, CacheEntry>();

export interface SnapshotOptions {
  depth?: number | null;
  scope?: string | null;
  json?: boolean;
  interactive?: boolean;
  compact?: boolean;
}

export type SnapshotResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export function invalidate(sessionId: string): void {
  cache.delete(sessionId);
}

function truncateToDepth(text: string, depth: number): string {
  const maxLeadingSpaces = depth * 2;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.length === 0) {
      out.push(line);
      continue;
    }
    const lead = line.length - trimmed.length;
    if (lead <= maxLeadingSpaces) out.push(line);
  }
  return out.join('\n');
}

// Plain accessible names (e.g. `"Repository"` from the snapshot) become
// aria-label lookups; anything else passes through as CSS / XPath.
export function buildScopeCandidates(scope: string): string[] {
  if (/[[\]#.>~+*]/.test(scope) || scope.startsWith('//')) return [scope];

  const escaped = scope.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    `[aria-label="${escaped}"]`,
    `[role][aria-label="${escaped}"]`,
    scope,
  ];
}

// When the caller doesn't pin a depth and isn't scoping into a subtree, we
// truncate to this depth locally so a default `browser_snapshot()` stays cheap
// (just the top-level clickables). With `scope`, the caller has already
// narrowed the subtree, so we return it whole unless they pin a depth.
const DEFAULT_UNSCOPED_DEPTH = 0;

export async function takeSnapshot(
  sessionId: string,
  opts: SnapshotOptions,
  cdpUrl: string | null,
  execBrowser: ExecBrowser
): Promise<SnapshotResult> {
  // depth semantics: undefined → use default for this mode; -1 → no truncation
  // (full tree); any non-negative integer → truncate / cap at that depth.
  const isUnlimited = opts.depth === -1;
  const explicitDepth =
    typeof opts.depth === 'number' && Number.isInteger(opts.depth) && opts.depth >= 0
      ? opts.depth
      : null;
  const hasScope = typeof opts.scope === 'string' && opts.scope.length > 0;
  const canUseCache =
    !hasScope &&
    !opts.json &&
    opts.interactive !== false &&
    opts.compact !== false;

  if (canUseCache) {
    const cached = cache.get(sessionId);
    const fresh = cached && Date.now() - cached.capturedAt <= TTL_MS;
    let full = fresh ? cached!.text : null;
    if (full == null) {
      const res = await execBrowser(['snapshot', '-i', '-c'], cdpUrl ?? undefined);
      if (res.exitCode !== 0) return { ok: false, error: res.stdout };
      full = res.stdout;
      cache.set(sessionId, { text: full, capturedAt: Date.now() });
    }
    if (isUnlimited) return { ok: true, text: full };
    const effectiveDepth = explicitDepth ?? DEFAULT_UNSCOPED_DEPTH;
    return { ok: true, text: truncateToDepth(full, effectiveDepth) };
  }

  const baseArgs = ['snapshot'];
  if (opts.json) baseArgs.push('--json');
  if (opts.interactive !== false) baseArgs.push('-i');
  if (opts.compact !== false) baseArgs.push('-c');
  if (explicitDepth != null) baseArgs.push('-d', String(explicitDepth));

  const selectors = hasScope ? buildScopeCandidates(opts.scope!) : [null];
  let last = { stdout: '', exitCode: 0 };
  for (const sel of selectors) {
    const args = sel ? [...baseArgs, '-s', sel] : baseArgs;
    last = await execBrowser(args, cdpUrl ?? undefined);
    if (last.exitCode === 0) return { ok: true, text: last.stdout };
  }
  return { ok: false, error: last.stdout };
}

export const __test = { truncateToDepth };

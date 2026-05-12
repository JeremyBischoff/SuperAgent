
import { createHash } from 'crypto';

const LINE_RE =
  /^(\s*)-\s+([A-Za-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?([^\n]*)$/;
// Match `ref=eN`, `ref="eN"`, `ref='eN'` so we survive minor variations in
// agent-browser's snapshot output formatting.
const REF_RE = /ref=["']?(e\d+)["']?/;
const REF_RE_GLOBAL = /ref=["']?(e\d+)["']?/g;

interface StableRefStore {
  keyToSref: Map<string, string>;
  srefToCurrentEref: Map<string, string>;
  srefToCurrentLine: Map<string, string>;
  srefToBaselineLine: Map<string, string> | null;
  /** monotonic counter for new sref allocation */
  nextSrefId: number;
}

const sessions = new Map<string, StableRefStore>();

function getStore(sessionId: string): StableRefStore {
  let store = sessions.get(sessionId);
  if (!store) {
    store = {
      keyToSref: new Map(),
      srefToCurrentEref: new Map(),
      srefToCurrentLine: new Map(),
      srefToBaselineLine: null,
      nextSrefId: 1,
    };
    sessions.set(sessionId, store);
  }
  return store;
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Drop every `keyToSref` binding whose key carries an occurrence-disambiguation
 * suffix (`#1`, `#2`, ...). Returns the number of entries removed.
 *
 * Used to recover from occurrence-index drift after a list element is removed:
 * the remaining identical siblings would otherwise inherit srefs pointing at
 * the wrong physical element. After this call, those siblings get fresh srefs
 * on the next annotate pass. Unique-key bindings (occurrence 0) are preserved
 * because they cannot drift.
 */
export function resetDuplicateOccurrences(sessionId: string): number {
  const store = sessions.get(sessionId);
  if (!store) return 0;
  let removed = 0;
  for (const key of [...store.keyToSref.keys()]) {
    if (key.includes('#')) {
      store.keyToSref.delete(key);
      removed++;
    }
  }
  return removed;
}

function computeStableKey(
  role: string,
  name: string,
  parentPath: string
): string {
  return createHash('sha1')
    .update(`${parentPath}|${role}|${name}`)
    .digest('hex')
    .slice(0, 10);
}

interface ParsedNode {
  indent: number;
  role: string;
  name: string;
  attrs: string;
  raw: string;
  parentPath: string;
  eref: string; // ephemeral ref, may be ''
}

function parseSnapshot(text: string): ParsedNode[] {
  const nodes: ParsedNode[] = [];
  /** stack of (indent, role, name) for parent-path computation */
  const stack: Array<{ indent: number; role: string; name: string }> = [];
  for (const raw of text.split('\n')) {
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    const indent = m[1].length;
    const role = m[2];
    const name = m[3] ?? '';
    const attrs = m[4] ?? '';
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parentPath = stack
      .map((s) => `${s.role}:${s.name.slice(0, 20)}`)
      .join('/');
    const erefMatch = REF_RE.exec(attrs);
    const eref = erefMatch ? erefMatch[1] : '';
    nodes.push({ indent, role, name, attrs, raw, parentPath, eref });
    stack.push({ indent, role, name });
  }
  return nodes;
}


export function annotateSnapshot(sessionId: string, text: string): string {
  const store = getStore(sessionId);

  store.srefToCurrentEref = new Map();
  store.srefToCurrentLine = new Map();

  const nodes = parseSnapshot(text);
  /** per-snapshot counter to disambiguate same-key duplicates */
  const occCount = new Map<string, number>();
  /** eref → sref translation table for this snapshot */
  const erefToSref = new Map<string, string>();

  for (const node of nodes) {
    if (!node.eref) continue;
    const baseKey = computeStableKey(node.role, node.name, node.parentPath);
    const occ = occCount.get(baseKey) ?? 0;
    occCount.set(baseKey, occ + 1);
    const fullKey = occ === 0 ? baseKey : `${baseKey}#${occ}`;

    let sref = store.keyToSref.get(fullKey);
    if (!sref) {
      sref = `s${store.nextSrefId++}`;
      store.keyToSref.set(fullKey, sref);
    }
    store.srefToCurrentEref.set(sref, node.eref);
    erefToSref.set(node.eref, sref);
  }

  // Rewrite each `ref=eN` → `ref=sN` so the model never sees the unstable
  // ephemeral ref. Works whether the attr stands alone (`[ref=e1]`) or is
  // merged with others (`[expanded=false, ref=e1]`).
  const annotated = text.replace(REF_RE_GLOBAL, (whole, eref) => {
    const sref = erefToSref.get(eref);
    return sref ? `ref=${sref}` : whole;
  });

  // Record each sref's current annotated line so we can diff against the
  // baseline on the next snapshot.
  for (const line of annotated.split('\n')) {
    const m = /ref=(s\d+)/.exec(line);
    if (m) store.srefToCurrentLine.set(m[1], line);
  }

  return annotated;
}

/**
 * Promote the most recently annotated snapshot to the diff baseline. Call
 * this whenever the model receives a full or differential snapshot, so the
 * next diff is computed against what the model just saw.
 */
export function commitBaseline(sessionId: string): void {
  const store = sessions.get(sessionId);
  if (!store) return;
  // Clone so subsequent annotate calls do not mutate the baseline.
  store.srefToBaselineLine = new Map(store.srefToCurrentLine);
}

export interface SnapshotDiff {
  /** srefs that newly appeared (with their annotated lines). */
  added: string[];
  /** srefs that vanished (with the line as it appeared in the baseline). */
  removed: string[];
  /** Elements with the same sref but a changed line (e.g. attrs flipped). */
  changed: Array<{ before: string; after: string }>;
  /** Count of srefs whose line is byte-identical to the baseline. */
  unchanged: number;
  /** True when no baseline exists yet (first snapshot of the session). */
  noBaseline: boolean;
}

export function diffAgainstBaseline(sessionId: string): SnapshotDiff {
  const store = sessions.get(sessionId);
  if (!store) {
    return { added: [], removed: [], changed: [], unchanged: 0, noBaseline: true };
  }
  const baseline = store.srefToBaselineLine;
  const current = store.srefToCurrentLine;

  if (!baseline) {
    return {
      added: [...current.values()],
      removed: [],
      changed: [],
      unchanged: 0,
      noBaseline: true,
    };
  }

  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ before: string; after: string }> = [];
  let unchanged = 0;

  for (const [sref, line] of current) {
    const prior = baseline.get(sref);
    if (prior === undefined) {
      added.push(line);
    } else if (prior !== line) {
      changed.push({ before: prior, after: line });
    } else {
      unchanged++;
    }
  }
  for (const [sref, line] of baseline) {
    if (!current.has(sref)) removed.push(line);
  }

  return { added, removed, changed, unchanged, noBaseline: false };
}

/** Render a SnapshotDiff into model-friendly text. */
export function formatDiff(diff: SnapshotDiff): string {
  if (diff.noBaseline) {
    return (
      'No previous snapshot to diff against. ' +
      'Returning the full snapshot below.\n' +
      diff.added.join('\n')
    );
  }
  const sections: string[] = [];
  sections.push(
    `Snapshot diff: +${diff.added.length} added, ` +
      `-${diff.removed.length} removed, ` +
      `~${diff.changed.length} changed, ` +
      `${diff.unchanged} unchanged.`
  );
  if (diff.added.length > 0) {
    sections.push(`\nADDED (${diff.added.length}):`);
    sections.push(diff.added.map((l) => `+ ${l.trimStart()}`).join('\n'));
  }
  if (diff.removed.length > 0) {
    sections.push(`\nREMOVED (${diff.removed.length}):`);
    sections.push(diff.removed.map((l) => `- ${l.trimStart()}`).join('\n'));
  }
  if (diff.changed.length > 0) {
    sections.push(`\nCHANGED (${diff.changed.length}):`);
    sections.push(
      diff.changed
        .map((c) => `~ before: ${c.before.trimStart()}\n  after:  ${c.after.trimStart()}`)
        .join('\n')
    );
  }
  return sections.join('\n');
}

/**
 * True when the formatted diff would be at least as long as the full snapshot
 * — at that point a full tree is unambiguously the better thing to send.
 *
 * Line accounting (matches `formatDiff` output):
 *   - added:     1 line each
 *   - removed:   1 line each
 *   - changed:   2 lines each (`before` + `after`)
 *   - unchanged: 0 lines in diff, 1 line in full
 *
 * So full = added + unchanged + changed   (current tree size)
 *    diff = added + removed + 2 * changed
 * Fall back when diff >= full. No magic threshold, no buffer — attention
 * pieces fragmented diffs together fine; the only thing that matters is
 * whether we're sending more tokens than we have to.
 */
export function diffIsLargerThanFull(diff: SnapshotDiff): boolean {
  if (diff.noBaseline) return false;
  const fullLines =
    diff.added.length + diff.unchanged + diff.changed.length;
  const diffLines =
    diff.added.length + diff.removed.length + 2 * diff.changed.length;
  return diffLines >= fullLines;
}

/**
 * Translate a ref string from the model into an ephemeral ref usable by
 * agent-browser. Accepts:
 *   - "@s14" → current @eN for stable ref s14 (or throws if not found)
 *   - "@e102" / "e102" → returned as-is (canonicalized with @ prefix)
 *   - any other shape → returned as-is (let agent-browser report the error)
 */
export function resolveRef(sessionId: string, refStr: string): string {
  if (!refStr) return refStr;
  const trimmed = refStr.trim();
  // Stable ref form: @sN or sN
  const srefMatch = /^@?(s\d+)$/.exec(trimmed);
  if (srefMatch) {
    const store = sessions.get(sessionId);
    const eref = store?.srefToCurrentEref.get(srefMatch[1]);
    if (!eref) {
      throw new StableRefNotFoundError(srefMatch[1]);
    }
    return `@${eref}`;
  }
  // Ephemeral or unknown form: leave alone, just ensure @-prefix is normalized
  if (/^e\d+$/.test(trimmed)) return `@${trimmed}`;
  return trimmed;
}

export class StableRefNotFoundError extends Error {
  constructor(public sref: string) {
    super(
      `Stable ref @${sref} is not present in the most recent snapshot. ` +
        `Call browser_snapshot to refresh, then use the current ref.`
    );
    this.name = 'StableRefNotFoundError';
  }
}

/**
 * Translate any `@sN` tokens embedded in a free-form command string (used by
 * `browser_run`). Returns the rewritten command. Leaves unknown tokens alone.
 */
export function resolveRefsInCommand(
  sessionId: string,
  command: string
): string {
  return command.replace(/@(s\d+)\b/g, (full, sref) => {
    const store = sessions.get(sessionId);
    const eref = store?.srefToCurrentEref.get(sref);
    return eref ? `@${eref}` : full;
  });
}

/**
 * Rewrite an annotate-mode legend so it uses stable refs (`@sN`) instead of
 * agent-browser's raw ephemeral refs (`@eN`). Legend lines look like:
 *
 *   [1] @e15 button "Submit"
 *   [2] @e23 link "Sign in"
 *
 * We don't have the legend's parentPath info, so we match by (role, name)
 * against the most recent snapshot. When multiple lines share the same
 * (role, name) the first match wins — same disambiguation order as the
 * snapshot's occurrence index, so it lines up in well-behaved pages.
 *
 * Lines that can't be matched are kept unchanged (still `@eN`) so the model
 * sees that something is off rather than silently misleading it.
 */
export function rewriteAnnotateLegend(
  sessionId: string,
  legend: string
): string {
  const store = sessions.get(sessionId);
  if (!store) return legend;

  // (role + name) → sref, taken from the most recent snapshot. First sref
  // wins on collisions (matches the occurrence-index ordering).
  const lookup = new Map<string, string>();
  for (const [sref, line] of store.srefToCurrentLine) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const role = m[2];
    const name = m[3] ?? '';
    const key = `${role}\u0000${name}`;
    if (!lookup.has(key)) lookup.set(key, sref);
  }

  // Match either `@eN role "name"` or `@eN role` (no name).
  const LEGEND_LINE = /@e\d+\s+([A-Za-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?/g;
  return legend.replace(LEGEND_LINE, (whole, role, name) => {
    const key = `${role}\u0000${name ?? ''}`;
    const sref = lookup.get(key);
    if (!sref) return whole;
    return name ? `@${sref} ${role} "${name}"` : `@${sref} ${role}`;
  });
}

import { describe, it, expect, vi } from 'vitest';
import { takeSnapshot, invalidate, buildScopeCandidates, __test } from './snapshot';

const { truncateToDepth } = __test;

const TREE = [
  '- WebArea "Title"',
  '  - banner',
  '    - link "Logo"',
  '  - main',
  '    - heading "Welcome"',
  '      - text "Hello world"',
  '    - button "Sign in" [ref=e1]',
].join('\n');

describe('truncateToDepth', () => {
  it('depth=0 keeps only the root', () => {
    expect(truncateToDepth(TREE, 0)).toBe('- WebArea "Title"');
  });

  it('depth=1 keeps root + landmarks', () => {
    expect(truncateToDepth(TREE, 1)).toBe(
      ['- WebArea "Title"', '  - banner', '  - main'].join('\n')
    );
  });

  it('depth=2 keeps three levels', () => {
    expect(truncateToDepth(TREE, 2)).toBe(
      [
        '- WebArea "Title"',
        '  - banner',
        '    - link "Logo"',
        '  - main',
        '    - heading "Welcome"',
        '    - button "Sign in" [ref=e1]',
      ].join('\n')
    );
  });

  it('depth large enough keeps everything', () => {
    expect(truncateToDepth(TREE, 99)).toBe(TREE);
  });
});

describe('buildScopeCandidates', () => {
  it('passes CSS / XPath through unchanged', () => {
    expect(buildScopeCandidates('[role=dialog]')).toEqual(['[role=dialog]']);
    expect(buildScopeCandidates('#login')).toEqual(['#login']);
    expect(buildScopeCandidates('form.login')).toEqual(['form.login']);
    expect(buildScopeCandidates('nav > ul')).toEqual(['nav > ul']);
    expect(buildScopeCandidates('//main')).toEqual(['//main']);
  });

  it('plain names try aria-label first, fall back to bare CSS', () => {
    expect(buildScopeCandidates('Repository')).toEqual([
      '[aria-label="Repository"]',
      '[role][aria-label="Repository"]',
      'Repository',
    ]);
  });

  it('multi-word names', () => {
    expect(buildScopeCandidates('Personal tools')).toEqual([
      '[aria-label="Personal tools"]',
      '[role][aria-label="Personal tools"]',
      'Personal tools',
    ]);
  });

  it('escapes double quotes', () => {
    expect(buildScopeCandidates('He said "hi"')[0]).toBe('[aria-label="He said \\"hi\\""]');
  });
});

describe('takeSnapshot', () => {
  it('caches full snapshot and serves depth slices locally', async () => {
    invalidate('s1');
    const exec = vi.fn(async (args: string[]) => ({
      stdout: TREE,
      exitCode: 0,
    }));

    const r1 = await takeSnapshot('s1', { depth: 0 }, null, exec);
    expect(r1).toEqual({ ok: true, text: '- WebArea "Title"' });
    expect(exec).toHaveBeenCalledTimes(1);

    const r2 = await takeSnapshot('s1', { depth: 1 }, null, exec);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.text.split('\n')).toHaveLength(3);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('invalidate clears the cache', async () => {
    invalidate('s2');
    const exec = vi.fn(async () => ({ stdout: TREE, exitCode: 0 }));
    await takeSnapshot('s2', {}, null, exec);
    invalidate('s2');
    await takeSnapshot('s2', {}, null, exec);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('scope tries candidates in order until one succeeds', async () => {
    invalidate('s3');
    let call = 0;
    const exec = vi.fn(async (args: string[]) => {
      call++;
      const scopeArg = args[args.indexOf('-s') + 1];
      if (scopeArg === '[aria-label="Repository"]') {
        return { stdout: '- navigation "Repository" [ref=e7]', exitCode: 0 };
      }
      return { stdout: "Selector didn't match", exitCode: 1 };
    });

    const r = await takeSnapshot('s3', { scope: 'Repository' }, null, exec);
    expect(r).toEqual({ ok: true, text: '- navigation "Repository" [ref=e7]' });
    expect(call).toBe(1);
  });

  it('scope falls through candidates when earlier ones miss', async () => {
    invalidate('s4');
    const exec = vi.fn(async (args: string[]) => {
      const scopeArg = args[args.indexOf('-s') + 1];
      if (scopeArg === 'main') return { stdout: '- main', exitCode: 0 };
      return { stdout: 'no match', exitCode: 1 };
    });

    const r = await takeSnapshot('s4', { scope: 'main' }, null, exec);
    expect(r).toEqual({ ok: true, text: '- main' });
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('returns error when all scope candidates fail', async () => {
    invalidate('s5');
    const exec = vi.fn(async () => ({ stdout: 'nope', exitCode: 1 }));

    const r = await takeSnapshot('s5', { scope: 'Nonexistent' }, null, exec);
    expect(r).toEqual({ ok: false, error: 'nope' });
  });

  it('no scope + no depth truncates to default (top-level only)', async () => {
    invalidate('s6');
    const exec = vi.fn(async () => ({ stdout: TREE, exitCode: 0 }));
    const r = await takeSnapshot('s6', {}, null, exec);
    expect(r).toEqual({ ok: true, text: '- WebArea "Title"' });
  });

  it('scope + no depth does NOT pass -d to CLI (returns full subtree)', async () => {
    invalidate('s7');
    const exec = vi.fn(async (args: string[]) => ({
      stdout: args.includes('-d') ? 'truncated' : 'full subtree',
      exitCode: 0,
    }));
    const r = await takeSnapshot('s7', { scope: 'Repository' }, null, exec);
    expect(r).toEqual({ ok: true, text: 'full subtree' });
    expect(exec).toHaveBeenCalled();
    const calledArgs = exec.mock.calls[0]![0] as string[];
    expect(calledArgs).not.toContain('-d');
  });

  it('depth=-1 returns the full unfiltered snapshot (no truncation)', async () => {
    invalidate('s9');
    const exec = vi.fn(async () => ({ stdout: TREE, exitCode: 0 }));
    const r = await takeSnapshot('s9', { depth: -1 }, null, exec);
    expect(r).toEqual({ ok: true, text: TREE });
  });

  it('scope + explicit depth passes -d to CLI', async () => {
    invalidate('s8');
    const exec = vi.fn(async (args: string[]) => ({ stdout: args.join(' '), exitCode: 0 }));
    await takeSnapshot('s8', { scope: 'Repository', depth: 2 }, null, exec);
    const calledArgs = exec.mock.calls[0]![0] as string[];
    expect(calledArgs).toContain('-d');
    expect(calledArgs[calledArgs.indexOf('-d') + 1]).toBe('2');
  });
});

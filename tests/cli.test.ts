import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const cliPath = join(process.cwd(), 'dist', 'cli.js');
const validExample = join(process.cwd(), 'examples', 'valid.json');
const invalidExample = join(process.cwd(), 'examples', 'merge-conflict.json');
const constPrunedExample = join(process.cwd(), 'examples', 'const-pruned.json');
const constantModeExample = join(process.cwd(), 'examples', 'constant-mode.json');

function runCli(args: string[], input?: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    input,
    encoding: 'utf8',
  });
}

describe('JSON command-line entrypoint', () => {
  it('exits 0 and prints signatures for a valid file', () => {
    const result = runCli([validExample]);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(true);
    expect(output.analysis.pcSignatures).toMatchObject({
      0: [],
      5: ['bool'],
    });
  });

  it('exits 1 and prints a control-flow witness for an invalid file', () => {
    const result = runCli([invalidExample]);
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.analysis.issues[0].code).toBe('stack_merge_conflict');
    expect(output.analysis.issues[0].witness.conflicts.existingPath.length).toBeGreaterThan(0);
    expect(output.analysis.issues[0].witness.conflicts.incomingPath.length).toBeGreaterThan(0);
  });

  it('reads JSON from stdin when no file is given', () => {
    const result = runCli([], '{"instructions":[{"op":"PUSH_BOOL","value":true},{"op":"HALT"}]}');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).analysis.maxStackDepth).toBe(1);
  });
});

describe('constant-aware mode selection', () => {
  it('keeps the default type-only mode on a program with a prunable bad instruction', () => {
    const result = runCli([constPrunedExample]);
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.analysis.issues[0].code).toBe('malformed_instruction');
    expect(output.analysis).not.toHaveProperty('mode');
    expect(output.analysis).not.toHaveProperty('pcStates');
  });

  it('prunes the proven-dead bad instruction with --constants', () => {
    const result = runCli(['--constants', constPrunedExample]);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.analysis.mode).toBe('constants');
    expect(output.analysis.deadPcs).toEqual([4]);
    expect(output.analysis.pcStates[3]).toEqual([
      { kind: 'const', type: 'bool', value: true },
    ]);
  });

  it('accepts --mode constants like --constants', () => {
    const result = runCli(['--mode', 'constants', constPrunedExample]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).analysis.mode).toBe('constants');
  });

  it('honours the envelope mode field without any flag', () => {
    const result = runCli([constantModeExample]);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.analysis.mode).toBe('constants');
    expect(output.analysis.deadPcs).toEqual([4]);
  });

  it('lets an explicit CLI mode override the envelope mode', () => {
    const result = runCli(['--types', constantModeExample]);
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.analysis.issues[0].code).toBe('malformed_instruction');
    expect(output.analysis).not.toHaveProperty('mode');
  });

  it('rejects an unknown CLI mode with exit code 2', () => {
    const result = runCli(['--mode', 'sometimes', constPrunedExample]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
  });

  it('rejects an invalid envelope mode without a partial report', () => {
    const result = runCli([], '{"mode":"sometimes","instructions":[{"op":"HALT"}]}');
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      ok: false,
      kind: 'structural_error',
      issue: { code: 'invalid_mode' },
    });
    expect(output).not.toHaveProperty('analysis');
  });
});

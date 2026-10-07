import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const cliPath = join(process.cwd(), 'dist', 'cli.js');
const validExample = join(process.cwd(), 'examples', 'valid.json');
const invalidExample = join(process.cwd(), 'examples', 'merge-conflict.json');
const constPrunedExample = join(process.cwd(), 'examples', 'const-pruned.json');
const constantModeExample = join(process.cwd(), 'examples', 'constant-mode.json');
const registersExample = join(process.cwd(), 'examples', 'registers.json');

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

describe('register programs on the command line', () => {
  it('exits 0 and prints register states for a valid register file', () => {
    const result = runCli([registersExample]);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.analysis.registerCount).toBe(1);
    expect(output.analysis.pcRegisterStates).toMatchObject({
      0: [{ kind: 'unassigned' }],
      2: [{ kind: 'unknown', type: 'bool' }],
      3: [{ kind: 'unknown', type: 'bool' }],
    });
    expect(Object.keys(output.analysis.pcRegisterStates).map(Number)).toEqual(
      output.analysis.reachablePcs
    );
  });

  it('exits 1 with a reachable witness for an unassigned register read from stdin', () => {
    const result = runCli(
      [],
      '{"registers":1,"instructions":[{"op":"LOAD","slot":0},{"op":"HALT"}]}'
    );
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.analysis.issues[0].code).toBe('register_read_unassigned');
    expect(output.analysis.issues[0].pc).toBe(0);
    expect(output.analysis.reachablePcs).toContain(0);
    expect(output.analysis.issues[0].witness.path).toEqual([]);
  });

  it('exits 1 with both real paths for a register merge conflict from stdin', () => {
    const result = runCli(
      [],
      JSON.stringify({
        registers: 1,
        instructions: [
          { op: 'PUSH_BOOL', value: true },
          { op: 'JUMP_IF_FALSE', target: 5 },
          { op: 'PUSH_INT', value: 1 },
          { op: 'STORE', slot: 0 },
          { op: 'JUMP', target: 7 },
          { op: 'PUSH_BOOL', value: false },
          { op: 'STORE', slot: 0 },
          { op: 'LOAD', slot: 0 },
          { op: 'HALT' },
        ],
      })
    );
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.analysis.issues[0].code).toBe('register_merge_conflict');
    const conflict = output.analysis.issues[0].witness.registerConflict;
    expect(conflict.slot).toBe(0);
    expect(conflict.existingPath.length).toBeGreaterThan(0);
    expect(conflict.incomingPath.length).toBeGreaterThan(0);
    expect(output.analysis.reachablePcs).toContain(7);
  });

  it('rejects an out-of-range register count without a partial report', () => {
    const result = runCli([], '{"registers":9,"instructions":[{"op":"HALT"}]}');
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      ok: false,
      kind: 'structural_error',
      issue: { code: 'invalid_register_count' },
    });
    expect(output).not.toHaveProperty('analysis');
  });

  it('keeps register-free output free of register fields', () => {
    const result = runCli([validExample]);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.analysis).not.toHaveProperty('registerCount');
    expect(output.analysis).not.toHaveProperty('pcRegisterStates');
  });
});

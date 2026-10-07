import { describe, expect, it } from 'vitest';
import {
  MAX_STACK_DEPTH,
  validateJsonText,
  validateProgram,
  type StackType,
} from '../src/validator';

interface RawInstruction {
  op: string;
  value?: number | boolean;
  target?: number;
}

const program = (instructions: RawInstruction[]) => ({ instructions });

const int = (value = 1): RawInstruction => ({ op: 'PUSH_INT', value });
const bool = (value = true): RawInstruction => ({ op: 'PUSH_BOOL', value });
const add = (): RawInstruction => ({ op: 'ADD' });
const eq = (): RawInstruction => ({ op: 'EQ' });
const not = (): RawInstruction => ({ op: 'NOT' });
const dup = (): RawInstruction => ({ op: 'DUP' });
const pop = (): RawInstruction => ({ op: 'POP' });
const jump = (target: number): RawInstruction => ({ op: 'JUMP', target });
const jif = (target: number): RawInstruction => ({
  op: 'JUMP_IF_FALSE',
  target,
});
const halt = (): RawInstruction => ({ op: 'HALT' });
const bad = (): RawInstruction => ({ op: 'NOPE' });

function expectInvalidAt(pc: number, code: string, instructions: RawInstruction[]) {
  const result = validateProgram(program(instructions));
  expect(result.kind).toBe('program');
  if (result.kind !== 'program') {
    throw new Error('unexpected result kind');
  }
  expect(result.ok).toBe(false);
  expect(result.analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
    [pc, code],
  ]);
  return result.analysis.issues[0]!;
}

function expectValid(instructions: RawInstruction[]) {
  const result = validateProgram(program(instructions));
  expect(result.kind).toBe('program');
  if (result.kind !== 'program') {
    throw new Error('unexpected result kind');
  }
  expect(result.ok, JSON.stringify(result.analysis.issues)).toBe(true);
  return result.analysis;
}

describe('stack-machine validator semantics', () => {
  it('accepts a boolean result on HALT and records entry signatures', () => {
    const analysis = expectValid([bool(true), halt()]);
    expect(analysis.maxStackDepth).toBe(1);
    expect(analysis.pcSignatures).toEqual({
      0: [],
      1: ['bool'],
    });
    expect(analysis.reachablePcs).toEqual([0, 1]);
    expect(analysis.deadPcs).toEqual([]);
  });

  it('rejects ADD when a boolean would be used as a number', () => {
    const issue = expectInvalidAt(2, 'type_error', [
      bool(true),
      bool(false),
      add(),
      halt(),
    ]);
    expect(issue.details).toMatchObject({
      expected: ['int', 'int'],
      actual: ['bool', 'bool'],
    });
    expect(issue.witness.attempted).toMatchObject({ type: 'operation', pc: 2 });
  });

  it('rejects EQ for values of different types', () => {
    expectInvalidAt(2, 'type_error', [int(1), bool(true), eq(), halt()]);
  });

  it('accepts EQ for two booleans', () => {
    const analysis = expectValid([bool(true), bool(false), eq(), halt()]);
    expect(analysis.pcSignatures[3]).toEqual(['bool']);
  });

  it('rejects NOT for an integer', () => {
    expectInvalidAt(1, 'type_error', [int(1), not(), halt()]);
  });

  it('rejects HALT with an integer result', () => {
    expectInvalidAt(1, 'halt_stack_not_boolean', [int(1), halt()]);
  });

  it('rejects HALT with the wrong stack size', () => {
    expectInvalidAt(0, 'halt_stack_size', [halt()]);
  });

  it('reports underflow with a reachable witness', () => {
    const issue = expectInvalidAt(0, 'stack_underflow', [pop(), halt()]);
    expect(issue.witness.path).toEqual([]);
    expect(issue.entryStack).toEqual([]);
  });

  it('rejects falling off the end', () => {
    const issue = expectInvalidAt(0, 'fall_through', [int(1)]);
    expect(issue.witness.attempted).toEqual({
      type: 'fall_through',
      fromPc: 0,
      targetPc: 1,
      programLength: 1,
    });
  });

  it('rejects out-of-range absolute jumps', () => {
    expectInvalidAt(0, 'jump_target_out_of_bounds', [jump(3), halt()]);
    expectInvalidAt(0, 'jump_target_out_of_bounds', [jump(-1), halt()]);
  });

  it('requires JUMP_IF_FALSE to pop a boolean', () => {
    expectInvalidAt(1, 'type_error', [int(1), jif(3), halt(), halt()]);
  });
});

describe('control-flow merge', () => {
  it('accepts branches that arrive at the same PC with the same stack type sequence', () => {
    const analysis = expectValid([
      bool(true),
      jif(4),
      bool(false),
      jump(5),
      bool(true),
      halt(),
    ]);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3, 4, 5]);
    expect(analysis.pcSignatures[4]).toEqual([]);
    expect(analysis.pcSignatures[5]).toEqual(['bool']);
    expect(analysis.maxStackDepth).toBe(1);
  });

  it('reports a merge conflict with both incoming witnesses', () => {
    const issue = expectInvalidAt(6, 'stack_merge_conflict', [
      bool(true),
      jif(4),
      bool(false),
      jump(6),
      int(1),
      jump(6),
      halt(),
    ]);
    expect(issue.witness.conflicts).toBeDefined();
    expect(issue.witness.conflicts).toMatchObject({
      existingStack: ['int'],
      incomingStack: ['bool'],
    });
    expect(issue.witness.conflicts!.existingPath.at(-1)).toMatchObject({
      type: 'jump',
      fromPc: 5,
      toPc: 6,
    });
    expect(issue.witness.conflicts!.incomingPath.at(-1)).toMatchObject({
      type: 'jump',
      fromPc: 3,
      toPc: 6,
    });
  });

  it('accepts a balanced infinite loop without increasing stack depth', () => {
    const analysis = expectValid([jump(0)]);
    expect(analysis.pcSignatures[0]).toEqual([]);
    expect(analysis.maxStackDepth).toBe(0);
  });

  it('rejects a loop whose back edge increases the stack', () => {
    const issue = expectInvalidAt(0, 'stack_merge_conflict', [
      jump(1),
      bool(false),
      jump(0),
    ]);
    expect(issue.witness.conflicts).toMatchObject({
      existingStack: [],
      incomingStack: ['bool'],
    });
    expect(issue.witness.conflicts!.incomingPath.map((edgeItem) => edgeItem.type)).toEqual([
      'jump',
      'fall',
      'jump',
    ]);
  });
});

describe('dead code and reachability', () => {
  it('lists bad instructions after HALT as dead code without reporting them', () => {
    const analysis = expectValid([
      bool(true),
      halt(),
      add(),
      { op: 'UNKNOWN' },
    ]);
    expect(analysis.reachablePcs).toEqual([0, 1]);
    expect(analysis.deadPcs).toEqual([2, 3]);
  });

  it('still reports a bad instruction reached by absolute jump', () => {
    const analysis = validateProgram(
      program([jump(2), { op: 'DEAD_BAD' }, { op: 'LIVE_BAD' }])
    );
    expect(analysis.kind).toBe('program');
    if (analysis.kind !== 'program') throw new Error('kind');
    expect(analysis.analysis.deadPcs).toEqual([1]);
    expect(analysis.analysis.issues).toHaveLength(1);
    expect(analysis.analysis.issues[0]).toMatchObject({
      pc: 2,
      code: 'malformed_instruction',
    });
  });
});

describe('stack depth', () => {
  it('allows exactly 32 entries', () => {
    const instructions = [
      ...Array.from({ length: MAX_STACK_DEPTH }, () => bool(true)),
      ...Array.from({ length: MAX_STACK_DEPTH - 1 }, () => pop()),
      halt(),
    ];
    const analysis = expectValid(instructions);
    expect(analysis.maxStackDepth).toBe(MAX_STACK_DEPTH);
  });

  it('rejects the 33rd push', () => {
    const instructions = Array.from({ length: MAX_STACK_DEPTH + 1 }, () => bool(true));
    const issue = expectInvalidAt(MAX_STACK_DEPTH, 'stack_overflow', instructions);
    expect(issue.details).toMatchObject({
      maxStackDepth: 32,
      attemptedSize: 33,
    });
  });

  it('rejects DUP at depth 32', () => {
    const instructions = [
      ...Array.from({ length: MAX_STACK_DEPTH }, () => bool(true)),
      dup(),
    ];
    expectInvalidAt(MAX_STACK_DEPTH, 'stack_overflow', instructions);
  });
});

describe('input envelope', () => {
  it('rejects malformed JSON', () => {
    const result = validateJsonText('{"instructions":');
    expect(result).toMatchObject({
      ok: false,
      kind: 'json_parse_error',
      issue: { code: 'invalid_json' },
    });
  });

  it('rejects programs outside the 1..500 instruction range', () => {
    expect(validateProgram({ instructions: [] })).toMatchObject({
      ok: false,
      kind: 'structural_error',
    });
    const tooLarge = validateProgram({
      instructions: Array.from({ length: 501 }, () => ({ op: 'HALT' })),
    });
    expect(tooLarge).toMatchObject({
      ok: false,
      kind: 'structural_error',
      issue: { code: 'instruction_count_out_of_range' },
    });
  });

  it('accepts a top-level instruction array as an alternative envelope', () => {
    const result = validateProgram([bool(true), halt()]);
    expect(result.kind).toBe('program');
    if (result.kind !== 'program') throw new Error('kind');
    expect(result.ok).toBe(true);
    expect(result.analysis.pcSignatures).toEqual({
      0: [],
      1: ['bool'],
    });
  });

  it('accepts exactly 500 syntactic instructions when unreachable bad ones are dead', () => {
    const analysis = expectValid([
      bool(true),
      halt(),
      ...Array.from({ length: 498 }, () => bad()),
    ]);
    expect(analysis.deadPcs).toHaveLength(498);
  });
});

interface ReferenceResult {
  error?: { pc: number; code: string };
  signatures: Record<number, StackType[]>;
  maxStackDepth: number;
}

const straightLineOps: RawInstruction[] = [
  int(1),
  bool(true),
  add(),
  eq(),
  not(),
  dup(),
  pop(),
  halt(),
];

function runStraightLineReference(instructions: readonly RawInstruction[]): ReferenceResult {
  let stack: StackType[] = [];
  let maxStackDepth = 0;
  const signatures: Record<number, StackType[]> = {};

  const fail = (pc: number, code: string): ReferenceResult => ({
    error: { pc, code },
    signatures,
    maxStackDepth,
  });

  for (let pc = 0; pc < instructions.length; pc += 1) {
    signatures[pc] = [...stack];
    maxStackDepth = Math.max(maxStackDepth, stack.length);
    const item = instructions[pc]!;

    const push = (type: StackType): ReferenceResult | undefined => {
      if (stack.length >= MAX_STACK_DEPTH) {
        return fail(pc, 'stack_overflow');
      }
      stack = [...stack, type];
      return undefined;
    };

    switch (item.op) {
      case 'PUSH_INT': {
        const error = push('int');
        if (error) return error;
        break;
      }
      case 'PUSH_BOOL': {
        const error = push('bool');
        if (error) return error;
        break;
      }
      case 'ADD': {
        if (stack.length < 2) return fail(pc, 'stack_underflow');
        const right = stack.at(-1)!;
        const left = stack.at(-2)!;
        if (left !== 'int' || right !== 'int') return fail(pc, 'type_error');
        stack = [...stack.slice(0, -2), 'int'];
        break;
      }
      case 'EQ': {
        if (stack.length < 2) return fail(pc, 'stack_underflow');
        const right = stack.at(-1)!;
        const left = stack.at(-2)!;
        if (left !== right) return fail(pc, 'type_error');
        stack = [...stack.slice(0, -2), 'bool'];
        break;
      }
      case 'NOT': {
        if (stack.length < 1) return fail(pc, 'stack_underflow');
        if (stack.at(-1) !== 'bool') return fail(pc, 'type_error');
        stack = [...stack.slice(0, -1), 'bool'];
        break;
      }
      case 'DUP': {
        if (stack.length < 1) return fail(pc, 'stack_underflow');
        if (stack.length >= MAX_STACK_DEPTH) return fail(pc, 'stack_overflow');
        stack = [...stack, stack.at(-1)!];
        break;
      }
      case 'POP': {
        if (stack.length < 1) return fail(pc, 'stack_underflow');
        stack = stack.slice(0, -1);
        break;
      }
      case 'HALT': {
        maxStackDepth = Math.max(maxStackDepth, stack.length);
        if (stack.length !== 1) return fail(pc, 'halt_stack_size');
        if (stack[0] !== 'bool') return fail(pc, 'halt_stack_not_boolean');
        return { signatures, maxStackDepth };
      }
      default:
        throw new Error(`reference does not generate ${item.op}`);
    }

    maxStackDepth = Math.max(maxStackDepth, stack.length);
    if (pc + 1 === instructions.length) {
      return fail(pc, 'fall_through');
    }
  }

  throw new Error('unreachable reference state');
}

describe('small straight-line abstract-state enumeration differential test', () => {
  const sequences: RawInstruction[][] = [];

  function enumerate(prefix: RawInstruction[], depth: number): void {
    if (depth === 4) {
      return;
    }
    for (const instruction of straightLineOps) {
      const next = [...prefix, instruction];
      sequences.push(next);
      enumerate(next, depth + 1);
    }
  }

  enumerate([], 0);

  it('matches the independent reference evaluator on every 1..4 instruction program', () => {
    expect(sequences).toHaveLength(8 + 8 ** 2 + 8 ** 3 + 8 ** 4);

    for (const instructions of sequences) {
      const expected = runStraightLineReference(instructions);
      const result = validateProgram(program(instructions));
      expect(result.kind, JSON.stringify(instructions)).toBe('program');
      if (result.kind !== 'program') {
        throw new Error('unexpected structural result');
      }

      const actualIssues = result.analysis.issues.map((issue) => ({
        pc: issue.pc,
        code: issue.code,
      }));
      const expectedIssues = expected.error ? [expected.error] : [];

      expect(actualIssues, JSON.stringify(instructions)).toEqual(expectedIssues);
      expect(result.analysis.maxStackDepth, JSON.stringify(instructions)).toBe(
        expected.maxStackDepth
      );
      expect(result.analysis.pcSignatures, JSON.stringify(instructions)).toEqual(
        expected.signatures
      );
    }
  });
});

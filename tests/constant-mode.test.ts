import { describe, expect, it } from 'vitest';
import {
  MAX_STACK_DEPTH,
  validateJsonText,
  validateProgram,
  type AnalysisMode,
  type ValidationResult,
  type WitnessEdge,
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

// ---------------------------------------------------------------------------
// 独立的具体执行器：不经过校验器的任何代码，用真实值单道执行程序，
// 作为常量感知抽象分析的参照物。
// ---------------------------------------------------------------------------

type ConcreteValue = number | boolean;

interface ConcreteRun {
  visitedPcs: number[];
  maxStackDepth: number;
  outcome: 'halted' | 'fuel_exceeded' | 'error';
  error?: { pc: number; code: string };
}

const CONCRETE_OPS: ReadonlySet<string> = new Set([
  'PUSH_INT',
  'PUSH_BOOL',
  'ADD',
  'EQ',
  'NOT',
  'DUP',
  'POP',
  'JUMP',
  'JUMP_IF_FALSE',
  'HALT',
]);

function runConcrete(
  instructions: readonly RawInstruction[],
  fuel = 10_000
): ConcreteRun {
  const visited = new Set<number>();
  const stack: ConcreteValue[] = [];
  let maxStackDepth = 0;
  let pc = 0;

  const finish = (
    outcome: ConcreteRun['outcome'],
    error?: { pc: number; code: string }
  ): ConcreteRun => ({
    visitedPcs: [...visited].sort((a, b) => a - b),
    maxStackDepth,
    outcome,
    ...(error ? { error } : {}),
  });

  for (let step = 0; step < fuel; step += 1) {
    const item = instructions[pc];
    if (item === undefined) {
      throw new Error('concrete executor reached an out-of-range pc');
    }
    visited.add(pc);
    maxStackDepth = Math.max(maxStackDepth, stack.length);

    const fail = (code: string): ConcreteRun => finish('error', { pc, code });

    if (!CONCRETE_OPS.has(item.op)) {
      return fail('malformed_instruction');
    }

    const push = (value: ConcreteValue): ConcreteRun | undefined => {
      if (stack.length >= MAX_STACK_DEPTH) {
        return fail('stack_overflow');
      }
      stack.push(value);
      return undefined;
    };

    let nextPc = pc + 1;
    switch (item.op) {
      case 'PUSH_INT': {
        if (typeof item.value !== 'number' || !Number.isInteger(item.value)) {
          return fail('malformed_instruction');
        }
        const error = push(item.value);
        if (error) return error;
        break;
      }
      case 'PUSH_BOOL': {
        if (typeof item.value !== 'boolean') {
          return fail('malformed_instruction');
        }
        const error = push(item.value);
        if (error) return error;
        break;
      }
      case 'ADD': {
        if (stack.length < 2) return fail('stack_underflow');
        const right = stack.pop()!;
        const left = stack.pop()!;
        if (typeof left !== 'number' || typeof right !== 'number') {
          return fail('type_error');
        }
        stack.push(left + right);
        break;
      }
      case 'EQ': {
        if (stack.length < 2) return fail('stack_underflow');
        const right = stack.pop()!;
        const left = stack.pop()!;
        if (typeof left !== typeof right) {
          return fail('type_error');
        }
        stack.push(left === right);
        break;
      }
      case 'NOT': {
        if (stack.length < 1) return fail('stack_underflow');
        const top = stack.pop()!;
        if (typeof top !== 'boolean') {
          return fail('type_error');
        }
        stack.push(!top);
        break;
      }
      case 'DUP': {
        if (stack.length < 1) return fail('stack_underflow');
        if (stack.length >= MAX_STACK_DEPTH) return fail('stack_overflow');
        stack.push(stack[stack.length - 1]!);
        break;
      }
      case 'POP': {
        if (stack.length < 1) return fail('stack_underflow');
        stack.pop();
        break;
      }
      case 'JUMP': {
        if (typeof item.target !== 'number' || !Number.isInteger(item.target)) {
          return fail('malformed_instruction');
        }
        if (item.target < 0 || item.target >= instructions.length) {
          return fail('jump_target_out_of_bounds');
        }
        nextPc = item.target;
        break;
      }
      case 'JUMP_IF_FALSE': {
        if (typeof item.target !== 'number' || !Number.isInteger(item.target)) {
          return fail('malformed_instruction');
        }
        if (stack.length < 1) return fail('stack_underflow');
        const top = stack.pop()!;
        if (typeof top !== 'boolean') {
          return fail('type_error');
        }
        if (!top) {
          if (item.target < 0 || item.target >= instructions.length) {
            return fail('jump_target_out_of_bounds');
          }
          nextPc = item.target;
        }
        break;
      }
      case 'HALT': {
        if (stack.length !== 1) return fail('halt_stack_size');
        if (typeof stack[0] !== 'boolean') return fail('halt_stack_not_boolean');
        return finish('halted');
      }
      default:
        throw new Error(`concrete executor does not handle ${item.op}`);
    }

    maxStackDepth = Math.max(maxStackDepth, stack.length);
    if (nextPc >= instructions.length) {
      return fail('fall_through');
    }
    pc = nextPc;
  }

  return finish('fuel_exceeded');
}

// ---------------------------------------------------------------------------
// 一致性辅助
// ---------------------------------------------------------------------------

function programAnalysis(result: ValidationResult) {
  if (result.kind !== 'program') {
    throw new Error(`expected program result, got ${result.kind}`);
  }
  return result.analysis;
}

function analyzeConst(instructions: RawInstruction[]) {
  return programAnalysis(validateProgram(program(instructions), { mode: 'constants' }));
}

function analyzeTypes(instructions: RawInstruction[]) {
  return programAnalysis(validateProgram(program(instructions)));
}

/** 可达清单、pcStates/pcSignatures 与错误见证必须描述同一份控制流。 */
function expectWitnessConsistency(analysis: {
  reachablePcs: number[];
  deadPcs: number[];
  pcSignatures: Record<number, unknown>;
  pcStates?: Record<number, { type: string }[]>;
  issues: {
    pc: number;
    witness: { path: WitnessEdge[]; conflicts?: { existingPath: WitnessEdge[]; incomingPath: WitnessEdge[] } };
  }[];
}): void {
  const reachable = new Set(analysis.reachablePcs);
  const dead = new Set(analysis.deadPcs);

  expect([...analysis.reachablePcs].sort((a, b) => a - b)).toEqual(analysis.reachablePcs);
  for (const pc of analysis.reachablePcs) {
    expect(dead.has(pc)).toBe(false);
  }
  expect(Object.keys(analysis.pcSignatures).map(Number).sort((a, b) => a - b)).toEqual(
    analysis.reachablePcs
  );

  if (analysis.pcStates !== undefined) {
    expect(Object.keys(analysis.pcStates).map(Number).sort((a, b) => a - b)).toEqual(
      analysis.reachablePcs
    );
    for (const [pc, states] of Object.entries(analysis.pcStates)) {
      expect(states.map((state) => state.type)).toEqual(
        analysis.pcSignatures[Number(pc)]
      );
    }
  }

  const checkPath = (path: WitnessEdge[], issuePc: number): void => {
    let cursor = 0;
    for (const step of path) {
      expect(step.fromPc).toBe(cursor);
      expect(reachable.has(step.fromPc)).toBe(true);
      expect(reachable.has(step.toPc)).toBe(true);
      cursor = step.toPc;
    }
    expect(cursor).toBe(issuePc);
  };

  for (const issue of analysis.issues) {
    expect(reachable.has(issue.pc)).toBe(true);
    checkPath(issue.witness.path, issue.pc);
    if (issue.witness.conflicts) {
      checkPath(issue.witness.conflicts.existingPath, issue.pc);
      checkPath(issue.witness.conflicts.incomingPath, issue.pc);
    }
  }
}

/**
 * 常量感知分析是具体执行的保守上近似：具体执行访问过的 PC 必须可达、
 * 不得出现在 deadPcs；具体执行撞上的错误必须在 issues 里有对应报告。
 * 存在栈合流冲突时，被丢弃的入边之后的路径不再传播，跳过轨迹包含断言。
 */
function expectConcreteAgreement(instructions: RawInstruction[]) {
  const analysis = analyzeConst(instructions);
  const concrete = runConcrete(instructions);
  expectWitnessConsistency(analysis);

  const hasMergeConflict = analysis.issues.some(
    (issue) => issue.code === 'stack_merge_conflict'
  );
  if (!hasMergeConflict) {
    const reachable = new Set(analysis.reachablePcs);
    for (const pc of concrete.visitedPcs) {
      expect(reachable.has(pc)).toBe(true);
      expect(analysis.deadPcs).not.toContain(pc);
    }
    expect(analysis.maxStackDepth).toBeGreaterThanOrEqual(concrete.maxStackDepth);
    if (concrete.outcome === 'error') {
      expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toContainEqual([
        concrete.error!.pc,
        concrete.error!.code,
      ]);
    }
    if (analysis.issues.length === 0) {
      expect(concrete.outcome).not.toBe('error');
    }
  }
  return { analysis, concrete };
}

// ---------------------------------------------------------------------------
// 分支剪枝
// ---------------------------------------------------------------------------

describe('constant-aware branch pruning', () => {
  it('prunes the false branch when the condition is provably true', () => {
    const instructions = [bool(true), jif(4), bool(false), halt(), int(7), halt()];
    const { analysis, concrete } = expectConcreteAgreement(instructions);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3]);
    expect(analysis.deadPcs).toEqual([4, 5]);
    expect(analysis.pcStates![1]).toEqual([{ kind: 'const', type: 'bool', value: true }]);
    expect(analysis.pcStates![3]).toEqual([{ kind: 'const', type: 'bool', value: false }]);
    expect(concrete.outcome).toBe('halted');
    expect(concrete.visitedPcs).toEqual(analysis.reachablePcs);

    // 默认模式不跟踪常量，死分支里的 HALT 仍会报类型错误。
    const typesAnalysis = analyzeTypes(instructions);
    expect(typesAnalysis.reachablePcs).toEqual([0, 1, 2, 3, 4, 5]);
    expect(typesAnalysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [5, 'halt_stack_not_boolean'],
    ]);
  });

  it('prunes the fall-through branch when the condition is provably false', () => {
    const instructions = [bool(false), jif(3), bool(true), bool(true), halt()];
    const { analysis, concrete } = expectConcreteAgreement(instructions);
    expect(analysis.reachablePcs).toEqual([0, 1, 3, 4]);
    expect(analysis.deadPcs).toEqual([2]);
    expect(analysis.pcStates![4]).toEqual([{ kind: 'const', type: 'bool', value: true }]);
    expect(concrete.visitedPcs).toEqual(analysis.reachablePcs);
  });

  it('folds arithmetic and comparison results into provable constants', () => {
    const instructions = [
      int(2),
      int(3),
      add(),
      int(5),
      eq(),
      jif(8),
      bool(true),
      halt(),
      bool(false),
      halt(),
    ];
    const { analysis, concrete } = expectConcreteAgreement(instructions);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(analysis.deadPcs).toEqual([8, 9]);
    expect(analysis.pcStates![3]).toEqual([{ kind: 'const', type: 'int', value: 5 }]);
    expect(analysis.pcStates![5]).toEqual([{ kind: 'const', type: 'bool', value: true }]);
    expect(concrete.visitedPcs).toEqual(analysis.reachablePcs);
  });

  it('lists a proven-unreachable bad instruction in deadPcs without reporting it', () => {
    const instructions = [bool(true), jif(4), bool(true), halt(), bad()];
    const { analysis, concrete } = expectConcreteAgreement(instructions);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3]);
    expect(analysis.deadPcs).toEqual([4]);
    expect(analysis.issues).toEqual([]);
    expect(concrete.outcome).toBe('halted');

    const typesAnalysis = analyzeTypes(instructions);
    expect(typesAnalysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [4, 'malformed_instruction'],
    ]);
  });

  it('does not check the jump target of a pruned branch', () => {
    const instructions = [bool(true), jif(99), bool(true), halt()];
    const { analysis, concrete } = expectConcreteAgreement(instructions);
    expect(analysis.issues).toEqual([]);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3]);
    expect(concrete.outcome).toBe('halted');

    const typesAnalysis = analyzeTypes(instructions);
    expect(typesAnalysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [1, 'jump_target_out_of_bounds'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 回边
// ---------------------------------------------------------------------------

describe('constant-aware back edges', () => {
  it('accepts a balanced infinite loop', () => {
    const { analysis, concrete } = expectConcreteAgreement([jump(0)]);
    expect(analysis.reachablePcs).toEqual([0]);
    expect(analysis.pcStates![0]).toEqual([]);
    expect(concrete.outcome).toBe('fuel_exceeded');
    expect(concrete.visitedPcs).toEqual([0]);
  });

  it('widens a loop-carried constant to unknown at the loop head', () => {
    const instructions = [int(0), int(1), add(), jump(1)];
    const { analysis, concrete } = expectConcreteAgreement(instructions);
    expect(analysis.issues).toEqual([]);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3]);
    expect(analysis.pcStates![1]).toEqual([{ kind: 'unknown', type: 'int' }]);
    expect(analysis.pcStates![2]).toEqual([
      { kind: 'unknown', type: 'int' },
      { kind: 'const', type: 'int', value: 1 },
    ]);
    expect(analysis.pcStates![3]).toEqual([{ kind: 'unknown', type: 'int' }]);
    expect(analysis.maxStackDepth).toBe(2);
    expect(concrete.outcome).toBe('fuel_exceeded');
    expect(concrete.visitedPcs).toEqual([0, 1, 2, 3]);
    expect(concrete.maxStackDepth).toBe(2);
  });

  it('still rejects a loop whose back edge grows the stack', () => {
    const instructions = [jump(1), bool(false), jump(0)];
    const { analysis } = expectConcreteAgreement(instructions);
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [0, 'stack_merge_conflict'],
    ]);
    expect(analysis.issues[0]!.witness.conflicts).toMatchObject({
      existingStack: [],
      incomingStack: ['bool'],
    });
  });
});

// ---------------------------------------------------------------------------
// 合流后变未知与重新传播
// ---------------------------------------------------------------------------

describe('merge to unknown and re-propagation', () => {
  // 循环计数器在 PC 1 合流后变成未知，PC 6 的条件随之变未知，
  // 分析必须重新传播并探索首次到达时被裁掉的落分支（PC 7-9）。
  const wideningLoop = [
    int(0),
    int(1),
    add(),
    dup(),
    int(0),
    eq(),
    jif(1),
    pop(),
    bool(true),
    halt(),
  ];

  it('re-explores pruned successors once the condition becomes unknown', () => {
    const { analysis, concrete } = expectConcreteAgreement(wideningLoop);
    expect(analysis.issues).toEqual([]);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(analysis.deadPcs).toEqual([]);
    expect(analysis.pcStates![1]).toEqual([{ kind: 'unknown', type: 'int' }]);
    expect(analysis.pcStates![2]).toEqual([
      { kind: 'unknown', type: 'int' },
      { kind: 'const', type: 'int', value: 1 },
    ]);
    expect(analysis.pcStates![5]).toEqual([
      { kind: 'unknown', type: 'int' },
      { kind: 'unknown', type: 'int' },
      { kind: 'const', type: 'int', value: 0 },
    ]);
    expect(analysis.pcStates![6]).toEqual([
      { kind: 'unknown', type: 'int' },
      { kind: 'unknown', type: 'bool' },
    ]);
    expect(analysis.pcStates![7]).toEqual([{ kind: 'unknown', type: 'int' }]);
    expect(analysis.pcStates![9]).toEqual([{ kind: 'const', type: 'bool', value: true }]);

    // 具体执行里条件永远为假，循环不止；抽象分析保守地多覆盖 PC 7-9。
    expect(concrete.outcome).toBe('fuel_exceeded');
    expect(concrete.visitedPcs).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const pc of [7, 8, 9]) {
      expect(concrete.visitedPcs).not.toContain(pc);
      expect(analysis.reachablePcs).toContain(pc);
    }
  });

  it('reports an error that only becomes reachable after re-propagation', () => {
    const instructions = [int(0), int(1), add(), dup(), int(0), eq(), jif(1), pop(), add()];
    const { analysis, concrete } = expectConcreteAgreement(instructions);
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [8, 'stack_underflow'],
    ]);
    expect(analysis.reachablePcs).toContain(8);

    // 具体执行永远走不到 PC 7-8，但未知条件必须保守探索两边，
    // 因此抽象报告的错误与可达清单描述的是同一份控制流。
    expect(concrete.outcome).toBe('fuel_exceeded');
    expect(concrete.visitedPcs).toEqual([0, 1, 2, 3, 4, 5, 6]);

    const typesAnalysis = analyzeTypes(instructions);
    expect(typesAnalysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [8, 'stack_underflow'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 模式选择
// ---------------------------------------------------------------------------

describe('mode selection', () => {
  const sample = [bool(true), jif(4), bool(true), halt(), bad()];

  it('rejects an invalid envelope mode without a partial report', () => {
    for (const badMode of ['sometimes', 7, null, { kind: 'constants' }]) {
      const result = validateProgram({ mode: badMode, instructions: sample });
      expect(result).toMatchObject({
        ok: false,
        kind: 'structural_error',
        issue: { code: 'invalid_mode' },
      });
      expect('analysis' in result).toBe(false);
    }
  });

  it('rejects an invalid programmatic mode without a partial report', () => {
    const result = validateProgram(program(sample), {
      mode: 'sometimes' as unknown as AnalysisMode,
    });
    expect(result).toMatchObject({
      ok: false,
      kind: 'structural_error',
      issue: { code: 'invalid_mode' },
    });
    expect('analysis' in result).toBe(false);
  });

  it('honours the envelope mode field and lets explicit options override it', () => {
    const viaEnvelope = programAnalysis(
      validateProgram({ mode: 'constants', instructions: sample })
    );
    const viaOption = analyzeConst(sample);
    expect(viaEnvelope).toEqual(viaOption);
    expect(viaEnvelope.mode).toBe('constants');
    expect(viaEnvelope.deadPcs).toEqual([4]);

    const overridden = programAnalysis(
      validateProgram({ mode: 'constants', instructions: sample }, { mode: 'types' })
    );
    expect(overridden).toEqual(analyzeTypes(sample));
  });

  it('threads the mode through the JSON text entry point', () => {
    const text = JSON.stringify(program(sample));
    const viaOption = programAnalysis(validateJsonText(text, { mode: 'constants' }));
    expect(viaOption.mode).toBe('constants');
    expect(viaOption.deadPcs).toEqual([4]);

    const viaEnvelope = programAnalysis(
      validateJsonText(JSON.stringify({ mode: 'constants', instructions: sample }))
    );
    expect(viaEnvelope).toEqual(viaOption);

    const invalid = validateJsonText(
      JSON.stringify({ mode: 'sometimes', instructions: sample })
    );
    expect(invalid).toMatchObject({
      ok: false,
      kind: 'structural_error',
      issue: { code: 'invalid_mode' },
    });
  });
});

// ---------------------------------------------------------------------------
// 默认模式兼容
// ---------------------------------------------------------------------------

describe('default mode compatibility', () => {
  const directedPrograms: RawInstruction[][] = [
    [bool(true), jif(4), bool(false), halt(), int(7), halt()],
    [bool(false), jif(3), bool(true), bool(true), halt()],
    [int(2), int(3), add(), int(5), eq(), jif(8), bool(true), halt(), bool(false), halt()],
    [bool(true), jif(4), bool(true), halt(), bad()],
    [bool(true), jif(99), bool(true), halt()],
    [jump(0)],
    [int(0), int(1), add(), jump(1)],
    [jump(1), bool(false), jump(0)],
    [int(0), int(1), add(), dup(), int(0), eq(), jif(1), pop(), bool(true), halt()],
    [int(0), int(1), add(), dup(), int(0), eq(), jif(1), pop(), add()],
    [bool(true), not(), jif(4), bool(true), jump(5), bool(false), halt()],
  ];

  it('produces field-identical results for old inputs across all entry points', () => {
    for (const instructions of directedPrograms) {
      const viaDefault = validateProgram(program(instructions));
      const viaTypesOption = validateProgram(program(instructions), { mode: 'types' });
      const viaEnvelope = validateProgram({ mode: 'types', instructions });
      const viaJson = validateJsonText(JSON.stringify(program(instructions)));

      expect(viaTypesOption).toEqual(viaDefault);
      expect(viaEnvelope).toEqual(viaDefault);
      expect(viaJson).toEqual(viaDefault);

      const analysis = programAnalysis(viaDefault);
      expect(analysis).not.toHaveProperty('mode');
      expect(analysis).not.toHaveProperty('pcStates');
    }
  });

  it('marks constants-mode reports and keeps type signatures consistent with states', () => {
    for (const instructions of directedPrograms) {
      const analysis = analyzeConst(instructions);
      expect(analysis.mode).toBe('constants');
      expect(analysis.pcStates).toBeDefined();
      expectWitnessConsistency(analysis);
    }
  });
});

// ---------------------------------------------------------------------------
// 直线小程序枚举：常量模式、默认模式与具体执行器逐项对拍
// ---------------------------------------------------------------------------

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

describe('straight-line enumeration vs concrete executor', () => {
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

  it('matches the concrete executor and the default mode on every 1..4 instruction program', () => {
    expect(sequences).toHaveLength(8 + 8 ** 2 + 8 ** 3 + 8 ** 4);

    for (const instructions of sequences) {
      const label = JSON.stringify(instructions);
      const typesAnalysis = analyzeTypes(instructions);
      const constAnalysis = analyzeConst(instructions);

      // 直线程序没有分支，常量模式与默认模式必须给出同一份控制流描述。
      const { mode, pcStates, ...constRest } = constAnalysis;
      expect(mode, label).toBe('constants');
      expect(constRest, label).toEqual(typesAnalysis);
      expect(pcStates, label).toBeDefined();
      for (const [pc, states] of Object.entries(pcStates!)) {
        expect(states.map((state) => state.type), label).toEqual(
          typesAnalysis.pcSignatures[Number(pc)]
        );
      }

      // 具体执行器是独立参照：可达集合、最大栈深、错误必须完全一致。
      const concrete = runConcrete(instructions);
      expect(concrete.visitedPcs, label).toEqual(constAnalysis.reachablePcs);
      expect(concrete.maxStackDepth, label).toBe(constAnalysis.maxStackDepth);
      const expectedIssues =
        concrete.outcome === 'error'
          ? [{ pc: concrete.error!.pc, code: concrete.error!.code }]
          : [];
      expect(
        constAnalysis.issues.map((issue) => ({ pc: issue.pc, code: issue.code })),
        label
      ).toEqual(expectedIssues);
      expect(constAnalysis.deadPcs, label).toEqual(
        instructions.map((_, pc) => pc).filter((pc) => !concrete.visitedPcs.includes(pc))
      );
    }
  });
});

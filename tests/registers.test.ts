import { describe, expect, it } from 'vitest';
import {
  MAX_REGISTERS,
  MAX_STACK_DEPTH,
  validateJsonText,
  validateProgram,
  type RegisterState,
  type ValidationResult,
  type WitnessEdge,
} from '../src/validator';

interface RawInstruction {
  op: string;
  value?: number | boolean;
  target?: number;
  slot?: number;
}

const program = (instructions: RawInstruction[], registers?: number) =>
  registers === undefined ? { instructions } : { instructions, registers };

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
const store = (slot: number): RawInstruction => ({ op: 'STORE', slot });
const load = (slot: number): RawInstruction => ({ op: 'LOAD', slot });
const bad = (): RawInstruction => ({ op: 'NOPE' });

// ---------------------------------------------------------------------------
// 独立的具体执行器：不经过校验器的任何代码，用真实值单道执行程序（含寄存器），
// 作为寄存器抽象分析的参照物。
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
  'STORE',
  'LOAD',
  'HALT',
]);

function runConcrete(
  instructions: readonly RawInstruction[],
  registerCount: number,
  fuel = 10_000
): ConcreteRun {
  const visited = new Set<number>();
  const stack: ConcreteValue[] = [];
  const registers: (ConcreteValue | undefined)[] = Array.from(
    { length: registerCount },
    () => undefined
  );
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
      case 'STORE': {
        if (typeof item.slot !== 'number' || !Number.isInteger(item.slot)) {
          return fail('malformed_instruction');
        }
        if (item.slot < 0 || item.slot >= registerCount) {
          return fail('register_slot_out_of_range');
        }
        if (stack.length < 1) return fail('stack_underflow');
        registers[item.slot] = stack.pop()!;
        break;
      }
      case 'LOAD': {
        if (typeof item.slot !== 'number' || !Number.isInteger(item.slot)) {
          return fail('malformed_instruction');
        }
        if (item.slot < 0 || item.slot >= registerCount) {
          return fail('register_slot_out_of_range');
        }
        const value = registers[item.slot];
        if (value === undefined) return fail('register_read_unassigned');
        const error = push(value);
        if (error) return error;
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

function analyzeConst(instructions: RawInstruction[], registers: number) {
  return programAnalysis(
    validateProgram(program(instructions, registers), { mode: 'constants' })
  );
}

function analyzeTypes(instructions: RawInstruction[], registers?: number) {
  return programAnalysis(validateProgram(program(instructions, registers)));
}

/** 可达清单、pcSignatures/pcStates/pcRegisterStates 与错误见证必须描述同一份控制流。 */
function expectWitnessConsistency(analysis: {
  reachablePcs: number[];
  deadPcs: number[];
  pcSignatures: Record<number, unknown>;
  pcStates?: Record<number, { type: string }[]>;
  registerCount?: number;
  pcRegisterStates?: Record<number, RegisterState[]>;
  issues: {
    pc: number;
    witness: {
      path: WitnessEdge[];
      conflicts?: { existingPath: WitnessEdge[]; incomingPath: WitnessEdge[] };
      registerConflict?: { existingPath: WitnessEdge[]; incomingPath: WitnessEdge[] };
    };
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

  if (analysis.pcRegisterStates !== undefined) {
    expect(analysis.registerCount).toBeDefined();
    expect(
      Object.keys(analysis.pcRegisterStates).map(Number).sort((a, b) => a - b)
    ).toEqual(analysis.reachablePcs);
    for (const states of Object.values(analysis.pcRegisterStates)) {
      expect(states).toHaveLength(analysis.registerCount!);
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
    if (issue.witness.registerConflict) {
      checkPath(issue.witness.registerConflict.existingPath, issue.pc);
      checkPath(issue.witness.registerConflict.incomingPath, issue.pc);
    }
  }
}

/**
 * 寄存器抽象分析是具体执行的保守上近似：具体执行访问过的 PC 必须可达、
 * 不得出现在 deadPcs；具体执行撞上的错误（包括未赋值读取）必须在 issues
 * 里有对应报告。存在合流冲突时，被丢弃的入边之后的路径不再传播，
 * 跳过轨迹包含断言。
 */
function expectConcreteAgreement(instructions: RawInstruction[], registerCount: number) {
  const analysis = analyzeConst(instructions, registerCount);
  const concrete = runConcrete(instructions, registerCount);
  expectWitnessConsistency(analysis);

  const hasMergeConflict = analysis.issues.some(
    (issue) =>
      issue.code === 'stack_merge_conflict' || issue.code === 'register_merge_conflict'
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
// 基本语义
// ---------------------------------------------------------------------------

describe('register STORE/LOAD semantics', () => {
  it('round-trips a value through a register and reports entry states', () => {
    const analysis = analyzeTypes([bool(true), store(0), load(0), halt()], 1);
    expect(analysis.valid).toBe(true);
    expect(analysis.registerCount).toBe(1);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3]);
    expect(analysis.pcRegisterStates).toEqual({
      0: [{ kind: 'unassigned' }],
      1: [{ kind: 'unassigned' }],
      2: [{ kind: 'unknown', type: 'bool' }],
      3: [{ kind: 'unknown', type: 'bool' }],
    });
    expect(analysis.pcSignatures).toEqual({ 0: [], 1: ['bool'], 2: [], 3: ['bool'] });
    expect(analysis.maxStackDepth).toBe(1);
  });

  it('tracks provable constants through registers in constants mode', () => {
    const { analysis, concrete } = expectConcreteAgreement(
      [int(40), int(2), add(), store(0), load(0), int(42), eq(), halt()],
      1
    );
    expect(analysis.issues).toEqual([]);
    expect(analysis.pcRegisterStates![3]).toEqual([{ kind: 'unassigned' }]);
    expect(analysis.pcRegisterStates![4]).toEqual([
      { kind: 'const', type: 'int', value: 42 },
    ]);
    expect(analysis.pcStates![5]).toEqual([{ kind: 'const', type: 'int', value: 42 }]);
    expect(analysis.pcStates![7]).toEqual([{ kind: 'const', type: 'bool', value: true }]);
    expect(concrete.outcome).toBe('halted');
    expect(concrete.visitedPcs).toEqual(analysis.reachablePcs);
  });

  it('supports the maximum of 4 independent registers', () => {
    const analysis = analyzeTypes(
      [
        int(1),
        store(0),
        int(2),
        store(1),
        bool(true),
        store(2),
        bool(false),
        store(3),
        load(2),
        halt(),
      ],
      MAX_REGISTERS
    );
    expect(analysis.valid).toBe(true);
    expect(analysis.pcRegisterStates![8]).toEqual([
      { kind: 'unknown', type: 'int' },
      { kind: 'unknown', type: 'int' },
      { kind: 'unknown', type: 'bool' },
      { kind: 'unknown', type: 'bool' },
    ]);
  });

  it('rejects STORE with an empty stack', () => {
    const analysis = analyzeTypes([store(0), halt()], 1);
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [0, 'stack_underflow'],
    ]);
  });

  it('rejects LOAD that would push past the stack depth limit', () => {
    const instructions = [
      bool(true),
      store(0),
      ...Array.from({ length: MAX_STACK_DEPTH }, () => bool(true)),
      load(0),
    ];
    const analysis = analyzeTypes(instructions, 1);
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [MAX_STACK_DEPTH + 2, 'stack_overflow'],
    ]);
    expect(analysis.issues[0]!.details).toMatchObject({
      maxStackDepth: MAX_STACK_DEPTH,
      attemptedSize: MAX_STACK_DEPTH + 1,
    });
  });
});

// ---------------------------------------------------------------------------
// 未赋值读取
// ---------------------------------------------------------------------------

describe('unassigned register reads', () => {
  it('rejects a read of a register that was never stored', () => {
    const { analysis, concrete } = expectConcreteAgreement([load(0), halt()], 1);
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [0, 'register_read_unassigned'],
    ]);
    expect(analysis.issues[0]!.details).toMatchObject({ slot: 0 });
    expect(analysis.issues[0]!.witness.path).toEqual([]);
    expect(analysis.issues[0]!.witness.attempted).toMatchObject({
      type: 'operation',
      pc: 0,
      op: 'LOAD',
    });
    expect(analysis.pcRegisterStates![0]).toEqual([{ kind: 'unassigned' }]);
    expect(analysis.reachablePcs).toEqual([0]);
    expect(analysis.deadPcs).toEqual([1]);
    expect(concrete.outcome).toBe('error');
    expect(concrete.error).toEqual({ pc: 0, code: 'register_read_unassigned' });
  });

  it('rejects a read when only one branch stored the register', () => {
    // 假分支跳过 STORE：合流后寄存器 0 仍视为未赋值，读取失败。
    const instructions = [bool(true), jif(4), bool(false), store(0), load(0), halt()];
    const typesAnalysis = analyzeTypes(instructions, 1);
    expectWitnessConsistency(typesAnalysis);
    expect(typesAnalysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [4, 'register_read_unassigned'],
    ]);
    expect(typesAnalysis.pcRegisterStates![4]).toEqual([{ kind: 'unassigned' }]);
    // 读取失败不再传播，HALT 不可达。
    expect(typesAnalysis.reachablePcs).toEqual([0, 1, 2, 3, 4]);
    expect(typesAnalysis.deadPcs).toEqual([5]);

    // 常量模式证明假分支不可达：寄存器在唯一可达路径上已赋值，程序有效。
    const { analysis, concrete } = expectConcreteAgreement(instructions, 1);
    expect(analysis.issues).toEqual([]);
    expect(analysis.pcRegisterStates![4]).toEqual([
      { kind: 'const', type: 'bool', value: false },
    ]);
    expect(concrete.outcome).toBe('halted');
  });

  it('reports a read that becomes unassigned only after a later merge', () => {
    // BFS 先沿 STORE 路径到达 LOAD（已赋值），另一条路径随后把寄存器
    // 合流回未赋值，分析必须重新传播并在同一 PC 报出未赋值读取。
    const instructions = [
      bool(true),
      jif(5),
      bool(true),
      store(0),
      jump(6),
      jump(6),
      load(0),
      halt(),
    ];
    const analysis = analyzeTypes(instructions, 1);
    expectWitnessConsistency(analysis);
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [6, 'register_read_unassigned'],
    ]);
    expect(analysis.pcRegisterStates![6]).toEqual([{ kind: 'unassigned' }]);
  });
});

// ---------------------------------------------------------------------------
// 分支与类型冲突
// ---------------------------------------------------------------------------

describe('register merges at branches', () => {
  it('accepts branches that store the same type into one register', () => {
    const instructions = [
      bool(true),
      jif(5),
      bool(false),
      store(0),
      jump(7),
      bool(true),
      store(0),
      load(0),
      halt(),
    ];
    const analysis = analyzeTypes(instructions, 1);
    expectWitnessConsistency(analysis);
    expect(analysis.issues).toEqual([]);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(analysis.pcRegisterStates![7]).toEqual([{ kind: 'unknown', type: 'bool' }]);
  });

  const conflictProgram = [
    bool(true),
    jif(5),
    int(1),
    store(0),
    jump(7),
    bool(false),
    store(0),
    load(0),
    halt(),
  ];

  it('reports a register merge conflict with both real paths when types differ', () => {
    const analysis = analyzeTypes(conflictProgram, 1);
    expectWitnessConsistency(analysis);
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [7, 'register_merge_conflict'],
    ]);
    const conflict = analysis.issues[0]!.witness.registerConflict!;
    expect(conflict.slot).toBe(0);
    expect(conflict.existing).toEqual({ kind: 'unknown', type: 'bool' });
    expect(conflict.incoming).toEqual({ kind: 'unknown', type: 'int' });
    expect(conflict.existingPath.at(-1)).toMatchObject({
      type: 'fall',
      fromPc: 6,
      toPc: 7,
    });
    expect(conflict.incomingPath.at(-1)).toMatchObject({
      type: 'jump',
      fromPc: 4,
      toPc: 7,
    });
    expect(conflict.existingPath[0]).toMatchObject({ fromPc: 0 });
    expect(conflict.incomingPath[0]).toMatchObject({ fromPc: 0 });
    expect(analysis.issues[0]!.details).toMatchObject({
      slot: 0,
      existing: { kind: 'unknown', type: 'bool' },
      incoming: { kind: 'unknown', type: 'int' },
    });
    // 冲突 PC 本身仍可达（首次到达已传播过后继），可达清单与错误路径不矛盾。
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('prunes the conflicting branch in constants mode and agrees with concrete execution', () => {
    // 常量模式证明假分支不可达：只剩 int 路径，冲突消失，
    // 但 HALT 处的 int 结果照常报错，且与具体执行一致。
    const { analysis, concrete } = expectConcreteAgreement(conflictProgram, 1);
    expect(analysis.deadPcs).toEqual([5, 6]);
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [8, 'halt_stack_not_boolean'],
    ]);
    expect(analysis.pcRegisterStates![7]).toEqual([
      { kind: 'const', type: 'int', value: 1 },
    ]);
    expect(concrete.outcome).toBe('error');
    expect(concrete.error).toEqual({ pc: 8, code: 'halt_stack_not_boolean' });
  });
});

// ---------------------------------------------------------------------------
// 回边
// ---------------------------------------------------------------------------

describe('register states across back edges', () => {
  it('accepts a loop that carries an assigned register across iterations', () => {
    const instructions = [
      bool(true),
      store(0),
      load(0),
      jif(5),
      jump(2),
      load(0),
      halt(),
    ];
    const typesAnalysis = analyzeTypes(instructions, 1);
    expectWitnessConsistency(typesAnalysis);
    expect(typesAnalysis.issues).toEqual([]);
    expect(typesAnalysis.reachablePcs).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(typesAnalysis.pcRegisterStates![2]).toEqual([{ kind: 'unknown', type: 'bool' }]);
    expect(typesAnalysis.pcRegisterStates![5]).toEqual([{ kind: 'unknown', type: 'bool' }]);

    // 常量模式证明循环出口不可达，与具体执行的无限循环一致。
    const { analysis, concrete } = expectConcreteAgreement(instructions, 1);
    expect(analysis.issues).toEqual([]);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3, 4]);
    expect(analysis.deadPcs).toEqual([5, 6]);
    expect(analysis.pcRegisterStates![2]).toEqual([
      { kind: 'const', type: 'bool', value: true },
    ]);
    expect(concrete.outcome).toBe('fuel_exceeded');
    expect(concrete.visitedPcs).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps a register unassigned when the only store is inside an unreachable loop tail', () => {
    // 回边把未赋值状态带回循环头：头部读取必然失败。
    const instructions = [load(0), store(0), jump(0)];
    const analysis = analyzeTypes(instructions, 1);
    expectWitnessConsistency(analysis);
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [0, 'register_read_unassigned'],
    ]);
    expect(analysis.reachablePcs).toEqual([0]);
    expect(analysis.deadPcs).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// 常量退化与重新传播
// ---------------------------------------------------------------------------

describe('constant widening through registers', () => {
  // 循环计数器经寄存器 0 携带，回边合流把常量拓宽为未知；
  // PC 9 的条件随之变未知，分析必须重新传播并探索首次到达时
  // 被裁掉的落分支（PC 10-11）。
  const wideningLoop = [
    int(0),
    store(0),
    load(0),
    int(1),
    add(),
    store(0),
    load(0),
    int(0),
    eq(),
    jif(2),
    bool(true),
    halt(),
  ];

  it('widens a loop-carried register constant to unknown and re-propagates successors', () => {
    const { analysis, concrete } = expectConcreteAgreement(wideningLoop, 1);
    expect(analysis.issues).toEqual([]);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(analysis.deadPcs).toEqual([]);
    expect(analysis.pcRegisterStates![1]).toEqual([{ kind: 'unassigned' }]);
    expect(analysis.pcRegisterStates![2]).toEqual([{ kind: 'unknown', type: 'int' }]);
    expect(analysis.pcRegisterStates![6]).toEqual([{ kind: 'unknown', type: 'int' }]);
    expect(analysis.pcStates![3]).toEqual([{ kind: 'unknown', type: 'int' }]);
    expect(analysis.pcStates![9]).toEqual([{ kind: 'unknown', type: 'bool' }]);
    expect(analysis.pcStates![11]).toEqual([{ kind: 'const', type: 'bool', value: true }]);
    expect(analysis.maxStackDepth).toBe(2);

    // 具体执行里条件永远为假，循环不止；抽象分析保守地多覆盖 PC 10-11。
    expect(concrete.outcome).toBe('fuel_exceeded');
    expect(concrete.visitedPcs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const pc of [10, 11]) {
      expect(concrete.visitedPcs).not.toContain(pc);
      expect(analysis.reachablePcs).toContain(pc);
    }
  });

  it('keeps type-mode results identical on the same widening loop', () => {
    const typesAnalysis = analyzeTypes(wideningLoop, 1);
    expectWitnessConsistency(typesAnalysis);
    expect(typesAnalysis.issues).toEqual([]);
    expect(typesAnalysis.reachablePcs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(typesAnalysis.pcRegisterStates![2]).toEqual([
      { kind: 'unknown', type: 'int' },
    ]);
    expect(typesAnalysis).not.toHaveProperty('mode');
    expect(typesAnalysis).not.toHaveProperty('pcStates');
  });

  // 常量模式下同型不同常量的菱形合流：循环把条件拓宽为未知后，
  // 两条分支给寄存器 1 存入不同的 int 常量，合流后降为未知并重新传播。
  const wideningDiamond = [
    int(0),
    store(0),
    load(0),
    int(1),
    add(),
    store(0),
    load(0),
    int(0),
    eq(),
    jif(2),
    load(0),
    int(5),
    eq(),
    jif(17),
    int(1),
    store(1),
    jump(19),
    int(2),
    store(1),
    load(1),
    pop(),
    bool(true),
    halt(),
  ];

  it('widens same-type different constants to unknown at a diamond merge', () => {
    const { analysis, concrete } = expectConcreteAgreement(wideningDiamond, 2);
    expect(analysis.issues).toEqual([]);
    expect(analysis.reachablePcs).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      22,
    ]);
    // 合流点：寄存器 1 从 const 1 / const 2 降为未知 int。
    expect(analysis.pcRegisterStates![19]).toEqual([
      { kind: 'unknown', type: 'int' },
      { kind: 'unknown', type: 'int' },
    ]);
    expect(analysis.pcStates![20]).toEqual([{ kind: 'unknown', type: 'int' }]);
    expect(analysis.pcStates![22]).toEqual([{ kind: 'const', type: 'bool', value: true }]);
    expect(concrete.outcome).toBe('fuel_exceeded');
    expect(concrete.visitedPcs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  // 常量模式下的寄存器类型冲突：循环把条件拓宽为未知后，两条分支
  // 给寄存器 1 赋予不同类型，合流时报带双方真实路径的冲突。
  const constantConflictLoop = [
    int(0),
    store(0),
    load(0),
    int(1),
    add(),
    store(0),
    load(0),
    int(0),
    eq(),
    dup(),
    store(1),
    jif(2),
    load(1),
    jif(17),
    int(1),
    store(1),
    jump(19),
    bool(true),
    store(1),
    load(1),
    halt(),
  ];

  it('reports a register merge conflict with constant states in constants mode', () => {
    const { analysis, concrete } = expectConcreteAgreement(constantConflictLoop, 2);
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [19, 'register_merge_conflict'],
    ]);
    const conflict = analysis.issues[0]!.witness.registerConflict!;
    expect(conflict.slot).toBe(1);
    expect(conflict.existing).toEqual({ kind: 'const', type: 'bool', value: true });
    expect(conflict.incoming).toEqual({ kind: 'const', type: 'int', value: 1 });
    expect(conflict.existingPath.at(-1)).toMatchObject({ fromPc: 18, toPc: 19 });
    expect(conflict.incomingPath.at(-1)).toMatchObject({
      type: 'jump',
      fromPc: 16,
      toPc: 19,
    });
    expect(analysis.reachablePcs).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);

    // 具体执行永远走不到冲突点（循环不止），冲突属于抽象保守探索的发现。
    expect(concrete.outcome).toBe('fuel_exceeded');
    expect(concrete.visitedPcs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});

// ---------------------------------------------------------------------------
// 不可达坏指令
// ---------------------------------------------------------------------------

describe('dead code with illegal register operations', () => {
  it('lists unreachable bad register instructions in deadPcs without reporting them', () => {
    const instructions = [
      bool(true),
      halt(),
      load(0), // 死代码：未赋值读取
      store(9), // 死代码：槽位越界
      { op: 'LOAD' }, // 死代码：缺少 slot
    ];
    const { analysis } = expectConcreteAgreement(instructions, 1);
    expect(analysis.issues).toEqual([]);
    expect(analysis.reachablePcs).toEqual([0, 1]);
    expect(analysis.deadPcs).toEqual([2, 3, 4]);
    expect(analysis.pcRegisterStates).toEqual({
      0: [{ kind: 'unassigned' }],
      1: [{ kind: 'unassigned' }],
    });
  });

  it('does not report an unassigned read on a branch pruned by constants mode', () => {
    const instructions = [bool(true), jif(4), bool(true), halt(), load(0)];
    const { analysis, concrete } = expectConcreteAgreement(instructions, 1);
    expect(analysis.issues).toEqual([]);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3]);
    expect(analysis.deadPcs).toEqual([4]);
    expect(concrete.outcome).toBe('halted');

    // 默认模式不跟踪常量，死分支上的未赋值读取按可达处理。
    const typesAnalysis = analyzeTypes(instructions, 1);
    expect(typesAnalysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [4, 'register_read_unassigned'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 槽位与结构校验
// ---------------------------------------------------------------------------

describe('register slot and envelope validation', () => {
  it('rejects reachable out-of-range slots in both directions', () => {
    for (const slot of [2, -1]) {
      const analysis = analyzeTypes([int(1), store(slot), halt()], 2);
      expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
        [1, 'register_slot_out_of_range'],
      ]);
      expect(analysis.issues[0]!.details).toMatchObject({ slot, registerCount: 2 });
    }
    const loadAnalysis = analyzeTypes([load(5), halt()], 2);
    expect(loadAnalysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [0, 'register_slot_out_of_range'],
    ]);
  });

  it('treats every slot as out of range when no registers are configured', () => {
    const analysis = analyzeTypes([int(1), store(0), halt()]);
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [1, 'register_slot_out_of_range'],
    ]);
    // 未声明寄存器配置：输出保持旧格式，不出现寄存器字段。
    expect(analysis).not.toHaveProperty('registerCount');
    expect(analysis).not.toHaveProperty('pcRegisterStates');
  });

  it('rejects malformed STORE/LOAD instructions only when reachable', () => {
    const live = analyzeTypes([{ op: 'STORE' }, halt()], 1);
    expect(live.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [0, 'malformed_instruction'],
    ]);
    expect(live.issues[0]!.details).toMatchObject({ reason: 'missing_integer_slot' });

    const dead = analyzeTypes([bool(true), halt(), { op: 'LOAD' }], 1);
    expect(dead.issues).toEqual([]);
    expect(dead.deadPcs).toEqual([2]);
  });

  it('rejects invalid register counts as a structural error without a partial report', () => {
    for (const registers of [-1, 5, 2.5, '2', null, { count: 1 }]) {
      const result = validateProgram({ registers, instructions: [halt()] });
      expect(result).toMatchObject({
        ok: false,
        kind: 'structural_error',
        issue: { code: 'invalid_register_count' },
      });
      expect('analysis' in result).toBe(false);
    }
  });

  it('accepts the boundary register counts 0 and 4', () => {
    const zero = programAnalysis(validateProgram({ registers: 0, instructions: [bool(true), halt()] }));
    expect(zero.registerCount).toBe(0);
    expect(zero.pcRegisterStates).toEqual({ 0: [], 1: [] });

    const four = programAnalysis(
      validateProgram({ registers: 4, instructions: [bool(true), halt()] })
    );
    expect(four.registerCount).toBe(4);
    expect(four.pcRegisterStates![0]).toEqual([
      { kind: 'unassigned' },
      { kind: 'unassigned' },
      { kind: 'unassigned' },
      { kind: 'unassigned' },
    ]);
  });

  it('threads the register envelope through the JSON text entry point', () => {
    const text = JSON.stringify(program([bool(true), store(0), load(0), halt()], 1));
    const analysis = programAnalysis(validateJsonText(text));
    expect(analysis.valid).toBe(true);
    expect(analysis.registerCount).toBe(1);
    expect(analysis.pcRegisterStates![2]).toEqual([{ kind: 'unknown', type: 'bool' }]);
  });
});

// ---------------------------------------------------------------------------
// 旧程序兼容
// ---------------------------------------------------------------------------

describe('compatibility with programs that omit the register config', () => {
  const legacyPrograms: RawInstruction[][] = [
    [bool(true), halt()],
    [bool(true), jif(4), bool(false), halt(), int(7), halt()],
    [int(0), int(1), add(), jump(1)],
    [jump(1), bool(false), jump(0)],
    [bool(true), jif(4), bool(true), halt(), bad()],
  ];

  it('produces field-identical results for old programs in both modes', () => {
    for (const instructions of legacyPrograms) {
      const typesResult = validateProgram(program(instructions));
      const constResult = validateProgram(program(instructions), { mode: 'constants' });
      for (const result of [typesResult, constResult]) {
        const analysis = programAnalysis(result);
        expect(analysis).not.toHaveProperty('registerCount');
        expect(analysis).not.toHaveProperty('pcRegisterStates');
      }
      // 顶层数组信封同样没有寄存器字段。
      const arrayResult = programAnalysis(validateProgram(instructions));
      expect(arrayResult).toEqual(programAnalysis(typesResult));
    }
  });
});

// ---------------------------------------------------------------------------
// 直线小程序枚举：寄存器程序与具体执行器逐项对拍
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
  store(0),
  load(0),
];

describe('straight-line register enumeration vs concrete executor', () => {
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

  it('matches the concrete executor and both modes on every 1..4 instruction program', () => {
    expect(sequences).toHaveLength(10 + 10 ** 2 + 10 ** 3 + 10 ** 4);

    const project = (states: RegisterState[]) =>
      states.map((state) => (state.kind === 'unassigned' ? 'unassigned' : state.type));

    for (const instructions of sequences) {
      const label = JSON.stringify(instructions);
      const typesAnalysis = analyzeTypes(instructions, 1);
      const constAnalysis = analyzeConst(instructions, 1);

      // 直线程序没有分支，两种模式必须给出同一份控制流描述；
      // 常量模式只多出常量视角字段。
      const {
        mode,
        pcStates,
        pcRegisterStates: constRegisters,
        ...constRest
      } = constAnalysis;
      const { pcRegisterStates: typesRegisters, ...typesRest } = typesAnalysis;
      expect(mode, label).toBe('constants');
      expect(constRest, label).toEqual(typesRest);
      for (const [pc, states] of Object.entries(constRegisters!)) {
        expect(project(states), label).toEqual(project(typesRegisters![Number(pc)]!));
      }

      // 具体执行器是独立参照：可达集合、最大栈深、错误必须完全一致。
      const concrete = runConcrete(instructions, 1);
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

import { describe, expect, it } from 'vitest';
import {
  MAX_REGISTER_COUNT,
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

const program = (instructions: RawInstruction[]) => ({ instructions });
const withRegisters = (registers: number, instructions: RawInstruction[]) => ({
  registers,
  instructions,
});

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
const store = (slot: number): RawInstruction => ({ op: 'STORE', slot });
const load = (slot: number): RawInstruction => ({ op: 'LOAD', slot });
const halt = (): RawInstruction => ({ op: 'HALT' });

// ---------------------------------------------------------------------------
// 独立的具体执行器：不经过校验器的任何代码，用真实值单道执行程序（含寄存器），
// 作为寄存器感知抽象分析的参照物。检查顺序必须与抽象分析逐条对应。
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
        if (stack.length < 1) return fail('stack_underflow');
        if (item.slot < 0 || item.slot >= registerCount) {
          return fail('register_slot_out_of_bounds');
        }
        registers[item.slot] = stack.pop()!;
        break;
      }
      case 'LOAD': {
        if (typeof item.slot !== 'number' || !Number.isInteger(item.slot)) {
          return fail('malformed_instruction');
        }
        if (item.slot < 0 || item.slot >= registerCount) {
          return fail('register_slot_out_of_bounds');
        }
        const value = registers[item.slot];
        if (value === undefined) {
          return fail('register_read_unassigned');
        }
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

function analyzeConst(input: unknown) {
  return programAnalysis(validateProgram(input, { mode: 'constants' }));
}

function analyzeTypes(input: unknown) {
  return programAnalysis(validateProgram(input));
}

function analyze(
  instructions: RawInstruction[],
  registerCount: number,
  mode: 'types' | 'constants'
) {
  return mode === 'constants'
    ? analyzeConst(withRegisters(registerCount, instructions))
    : analyzeTypes(withRegisters(registerCount, instructions));
}

const registerTypes = (registers: readonly RegisterState[]) =>
  registers.map((value) => (value === null ? null : value.type));

/** 可达清单、pcSignatures/pcRegisters 与错误见证必须描述同一份控制流。 */
function expectWitnessConsistency(analysis: {
  reachablePcs: number[];
  deadPcs: number[];
  pcSignatures: Record<number, unknown>;
  pcStates?: Record<number, { type: string }[]>;
  pcRegisters?: Record<number, RegisterState[]>;
  registerCount?: number;
  issues: {
    pc: number;
    witness: {
      path: WitnessEdge[];
      conflicts?: { existingPath: WitnessEdge[]; incomingPath: WitnessEdge[] };
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
  }

  if (analysis.pcRegisters !== undefined) {
    expect(Object.keys(analysis.pcRegisters).map(Number).sort((a, b) => a - b)).toEqual(
      analysis.reachablePcs
    );
    for (const states of Object.values(analysis.pcRegisters)) {
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
  }
}

/**
 * 寄存器感知分析是具体执行的保守上近似：具体执行访问过的 PC 必须可达、
 * 不得出现在 deadPcs；具体执行撞上的错误必须在 issues 里有对应报告。
 * 存在合流冲突时，被丢弃的入边之后的路径不再传播，跳过轨迹包含断言。
 */
function expectConcreteAgreement(
  instructions: RawInstruction[],
  registerCount: number,
  mode: 'types' | 'constants' = 'constants'
) {
  const analysis = analyze(instructions, registerCount, mode);
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

describe('register store/load semantics', () => {
  it('round-trips a value through a register', () => {
    const instructions = [bool(true), store(0), load(0), halt()];
    const { analysis, concrete } = expectConcreteAgreement(instructions, 1);
    expect(analysis.issues).toEqual([]);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3]);
    expect(analysis.registerCount).toBe(1);
    expect(analysis.pcRegisters![0]).toEqual([null]);
    expect(analysis.pcRegisters![2]).toEqual([
      { kind: 'const', type: 'bool', value: true },
    ]);
    expect(analysis.pcRegisters![3]).toEqual([
      { kind: 'const', type: 'bool', value: true },
    ]);
    expect(concrete.outcome).toBe('halted');
    expect(concrete.visitedPcs).toEqual(analysis.reachablePcs);
  });

  it('supports the maximum of four registers independently', () => {
    const instructions = [
      int(1),
      int(2),
      store(1),
      store(0),
      int(3),
      store(2),
      int(4),
      store(3),
      load(0),
      load(1),
      add(),
      load(2),
      load(3),
      add(),
      eq(),
      halt(),
    ];
    const { analysis, concrete } = expectConcreteAgreement(instructions, 4);
    expect(analysis.issues).toEqual([]);
    expect(analysis.pcRegisters![15]).toEqual([
      { kind: 'const', type: 'int', value: 1 },
      { kind: 'const', type: 'int', value: 2 },
      { kind: 'const', type: 'int', value: 3 },
      { kind: 'const', type: 'int', value: 4 },
    ]);
    expect(concrete.outcome).toBe('halted');
  });

  it('rejects reading a register that was never assigned', () => {
    const instructions = [load(0), halt()];
    const { analysis, concrete } = expectConcreteAgreement(instructions, 1);
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [0, 'register_read_unassigned'],
    ]);
    expect(analysis.issues[0]!.details).toMatchObject({ slot: 0, registerCount: 1 });
    expect(analysis.issues[0]!.witness.attempted).toMatchObject({
      type: 'operation',
      pc: 0,
      op: 'LOAD',
    });
    expect(concrete.outcome).toBe('error');
    expect(concrete.error).toEqual({ pc: 0, code: 'register_read_unassigned' });
  });

  it('rejects STORE with an empty stack before checking the slot', () => {
    const analysis = analyzeTypes(withRegisters(1, [store(0)]));
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [0, 'stack_underflow'],
    ]);
  });

  it('rejects out-of-range and negative slots on reachable STORE/LOAD', () => {
    const cases: [RawInstruction[], number, number][] = [
      [[int(1), store(2), halt()], 1, 1],
      [[load(9), halt()], 1, 0],
      [[int(1), store(-1), halt()], 2, 1],
      [[int(1), store(0), halt()], 0, 1],
    ];
    for (const [instructions, registerCount, pc] of cases) {
      const { analysis, concrete } = expectConcreteAgreement(instructions, registerCount);
      expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
        [pc, 'register_slot_out_of_bounds'],
      ]);
      expect(analysis.issues[0]!.details).toMatchObject({ registerCount });
      expect(concrete.error).toEqual({ pc, code: 'register_slot_out_of_bounds' });
    }
  });

  it('treats STORE/LOAD without any configured registers as out of bounds', () => {
    const analysis = analyzeTypes(program([int(1), store(0), halt()]));
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [1, 'register_slot_out_of_bounds'],
    ]);
    // 未配置寄存器的旧程序不新增任何报告字段。
    expect(analysis).not.toHaveProperty('registerCount');
    expect(analysis).not.toHaveProperty('pcRegisters');
  });

  it('reports a malformed instruction when the slot is not an integer', () => {
    for (const raw of [
      { op: 'STORE' },
      { op: 'LOAD', slot: 'x' },
      { op: 'STORE', slot: 1.5 },
    ]) {
      const analysis = analyzeTypes(withRegisters(1, [raw, halt()]));
      expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
        [0, 'malformed_instruction'],
      ]);
      expect(analysis.issues[0]!.details).toMatchObject({
        reason: 'missing_integer_slot',
      });
    }
  });

  it('reports stack overflow when LOAD would exceed the maximum depth', () => {
    const instructions = [
      bool(true),
      store(0),
      ...Array.from({ length: MAX_STACK_DEPTH }, () => int(1)),
      load(0),
    ];
    const { analysis, concrete } = expectConcreteAgreement(instructions, 1);
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [2 + MAX_STACK_DEPTH, 'stack_overflow'],
    ]);
    expect(analysis.maxStackDepth).toBe(MAX_STACK_DEPTH);
    expect(concrete.error).toEqual({
      pc: 2 + MAX_STACK_DEPTH,
      code: 'stack_overflow',
    });
  });
});

// ---------------------------------------------------------------------------
// 分支合流
// ---------------------------------------------------------------------------

/**
 * 循环前奏：计数器在 PC 1 合流后拓宽为未知，PC 8 因此产生一个未知布尔值，
 * 让常量模式下随后的钻石形分支两边都保持可达（具体执行永远停在循环里）。
 */
const unknownBoolPrelude: RawInstruction[] = [
  int(0), // 0
  int(1), // 1
  add(), // 2
  dup(), // 3
  int(0), // 4
  eq(), // 5
  jif(1), // 6  回边把循环计数器拓宽为未知
  int(0), // 7
  eq(), // 8  栈顶是未知布尔值
];

describe('register definite-assignment merges at branches', () => {
  it('accepts a read when both branches assign the same type', () => {
    // 类型模式：JUMP_IF_FALSE 总是探索两边，简单的钻石形即可合流。
    const simpleDiamond = [
      bool(true), // 0
      jif(5), // 1
      int(1), // 2
      store(0), // 3
      jump(7), // 4
      int(2), // 5
      store(0), // 6
      load(0), // 7
      int(0), // 8
      eq(), // 9
      halt(), // 10
    ];
    const { analysis, concrete } = expectConcreteAgreement(simpleDiamond, 1, 'types');
    expect(analysis.issues).toEqual([]);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(analysis.pcRegisters![7]).toEqual([{ kind: 'unknown', type: 'int' }]);
    expect(concrete.outcome).toBe('halted');

    // 常量模式：两条路径赋予不同常量（1 与 2），合流后必须拓宽为未知。
    const constantsDiamond = [
      ...unknownBoolPrelude,
      jif(13), // 9
      int(1), // 10
      store(0), // 11
      jump(15), // 12
      int(2), // 13
      store(0), // 14
      load(0), // 15
      int(0), // 16
      eq(), // 17
      halt(), // 18
    ];
    const constResult = expectConcreteAgreement(constantsDiamond, 1);
    expect(constResult.analysis.issues).toEqual([]);
    expect(constResult.analysis.reachablePcs).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ]);
    expect(constResult.analysis.pcRegisters![15]).toEqual([
      { kind: 'unknown', type: 'int' },
    ]);
    expect(constResult.concrete.outcome).toBe('fuel_exceeded');
    expect(constResult.concrete.visitedPcs).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('keeps a provable constant when both branches assign the same value', () => {
    const instructions = [
      ...unknownBoolPrelude,
      jif(13), // 9
      int(7), // 10
      store(0), // 11
      jump(15), // 12
      int(7), // 13
      store(0), // 14
      load(0), // 15
      int(7), // 16
      eq(), // 17
      halt(), // 18
    ];
    const { analysis } = expectConcreteAgreement(instructions, 1);
    expect(analysis.issues).toEqual([]);
    expect(analysis.pcRegisters![15]).toEqual([
      { kind: 'const', type: 'int', value: 7 },
    ]);
    expect(analysis.pcStates![18]).toEqual([
      { kind: 'const', type: 'bool', value: true },
    ]);
  });

  it('fails a later read when one path leaves the register unassigned', () => {
    const instructions = [
      bool(false), // 0
      jif(4), // 1
      int(1), // 2
      store(0), // 3  真分支赋值，假分支从 1 直接到 4 未赋值
      load(0), // 4  合流后寄存器失去确定赋值
      halt(), // 5
    ];
    // 两种模式与具体执行都必须报同一个未赋值读取。
    for (const mode of ['types', 'constants'] as const) {
      const { analysis, concrete } = expectConcreteAgreement(instructions, 1, mode);
      expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
        [4, 'register_read_unassigned'],
      ]);
      expect(analysis.pcRegisters![4]).toEqual([null]);
      expect(analysis.reachablePcs).toContain(4);
      // 常量模式证明条件恒为假，真分支的赋值指令也被列入死代码。
      expect(analysis.deadPcs).toEqual(mode === 'constants' ? [2, 3, 5] : [5]);
      expect(concrete.outcome).toBe('error');
      expect(concrete.error).toEqual({ pc: 4, code: 'register_read_unassigned' });
    }
  });

  it('merges to unassigned in constants mode when only one branch stores', () => {
    const instructions = [
      ...unknownBoolPrelude,
      jif(12), // 9
      int(1), // 10
      store(0), // 11  假分支从 9 直接到 12，未赋值
      load(0), // 12  合流后寄存器失去确定赋值
      halt(), // 13
    ];
    const { analysis, concrete } = expectConcreteAgreement(instructions, 1);
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [12, 'register_read_unassigned'],
    ]);
    expect(analysis.pcRegisters![12]).toEqual([null]);
    expect(concrete.outcome).toBe('fuel_exceeded');
  });

  it('reports a merge conflict with both real paths when branches assign different types', () => {
    // 类型模式：简单钻石形即可触发冲突。
    const typesDiamond = [
      bool(true), // 0
      jif(5), // 1
      int(1), // 2
      store(0), // 3
      jump(7), // 4
      bool(false), // 5
      store(0), // 6
      load(0), // 7
      halt(), // 8
    ];
    const typesAnalysis = analyzeTypes(withRegisters(1, typesDiamond));
    expectWitnessConsistency(typesAnalysis);
    expect(typesAnalysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [7, 'register_merge_conflict'],
    ]);
    const typesIssue = typesAnalysis.issues[0]!;
    expect(typesIssue.details).toMatchObject({
      slot: 0,
      existingType: 'bool',
      incomingType: 'int',
    });
    const typesConflicts = typesIssue.witness.conflicts!;
    expect(typesConflicts.register).toEqual({
      slot: 0,
      existingType: 'bool',
      incomingType: 'int',
    });
    // 双方路径都必须是从 PC 0 出发到达冲突点的真实控制流。
    expect(typesConflicts.existingPath.map((step) => [step.fromPc, step.toPc])).toEqual([
      [0, 1],
      [1, 5],
      [5, 6],
      [6, 7],
    ]);
    expect(typesConflicts.incomingPath.map((step) => [step.fromPc, step.toPc])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 7],
    ]);
    expect(typesConflicts.existingStack).toEqual(typesConflicts.incomingStack);

    // 常量模式：未知条件下的钻石形同样报寄存器合流冲突。
    const constantsDiamond = [
      ...unknownBoolPrelude,
      jif(13), // 9
      int(1), // 10
      store(0), // 11
      jump(15), // 12
      bool(false), // 13
      store(0), // 14
      load(0), // 15
      halt(), // 16
    ];
    const constAnalysis = analyzeConst(withRegisters(1, constantsDiamond));
    expectWitnessConsistency(constAnalysis);
    expect(constAnalysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [15, 'register_merge_conflict'],
    ]);
    const constConflicts = constAnalysis.issues[0]!.witness.conflicts!;
    expect(constConflicts.register).toEqual({
      slot: 0,
      existingType: 'bool',
      incomingType: 'int',
    });
    expect(constConflicts.existingPath.at(-1)).toMatchObject({
      type: 'fall',
      fromPc: 14,
      toPc: 15,
    });
    expect(constConflicts.incomingPath.at(-1)).toMatchObject({
      type: 'jump',
      fromPc: 12,
      toPc: 15,
    });
  });
});

// ---------------------------------------------------------------------------
// 回边
// ---------------------------------------------------------------------------

describe('register states across back edges', () => {
  it('accepts a balanced loop that carries a register around', () => {
    const instructions = [
      int(0), // 0
      store(0), // 1
      load(0), // 2
      int(1), // 3
      add(), // 4
      store(0), // 5
      jump(2), // 6
    ];
    const { analysis, concrete } = expectConcreteAgreement(instructions, 1);
    expect(analysis.issues).toEqual([]);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // 回边把循环携带的常量拓宽为未知。
    expect(analysis.pcRegisters![2]).toEqual([{ kind: 'unknown', type: 'int' }]);
    expect(analysis.pcRegisters![6]).toEqual([{ kind: 'unknown', type: 'int' }]);
    expect(analysis.maxStackDepth).toBe(2);
    expect(concrete.outcome).toBe('fuel_exceeded');
    expect(concrete.visitedPcs).toEqual(analysis.reachablePcs);
    expect(concrete.maxStackDepth).toBe(analysis.maxStackDepth);

    // 类型模式描述同一份控制流，只是不区分常量。
    const typesAnalysis = analyzeTypes(withRegisters(1, instructions));
    expect(typesAnalysis.issues).toEqual([]);
    expect(typesAnalysis.reachablePcs).toEqual(analysis.reachablePcs);
    expect(typesAnalysis.pcRegisters![2]).toEqual([{ kind: 'unknown', type: 'int' }]);
  });

  it('keeps an unassigned-at-loop-head read an error even though the body stores', () => {
    const instructions = [
      jump(1), // 0
      load(0), // 1  首次到达时寄存器未赋值
      int(1), // 2
      store(0), // 3
      jump(1), // 4  回边虽赋值，合流后仍视为未赋值
    ];
    const analysis = analyzeTypes(withRegisters(1, instructions));
    expect(analysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [1, 'register_read_unassigned'],
    ]);
    expect(analysis.pcRegisters![1]).toEqual([null]);
  });

  it('widens a merged register constant and re-explores pruned successors', () => {
    const instructions = [
      bool(true), // 0
      store(0), // 1  reg0 = 常量 true
      load(0), // 2
      jif(7), // 3  首次到达时条件为常量 true，假分支被裁掉
      bool(false), // 4
      store(0), // 5  reg0 = 常量 false
      jump(2), // 6  回边使 PC 2 的 reg0 合流为未知
      bool(true), // 7  只有重新传播后才会探索到这里
      halt(), // 8
    ];
    const { analysis, concrete } = expectConcreteAgreement(instructions, 1);
    expect(analysis.issues).toEqual([]);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(analysis.deadPcs).toEqual([]);
    expect(analysis.pcRegisters![2]).toEqual([{ kind: 'unknown', type: 'bool' }]);
    expect(analysis.pcStates![3]).toEqual([{ kind: 'unknown', type: 'bool' }]);
    expect(concrete.outcome).toBe('halted');
    expect(concrete.visitedPcs).toEqual(analysis.reachablePcs);
  });
});

// ---------------------------------------------------------------------------
// 不可达坏指令
// ---------------------------------------------------------------------------

describe('unreachable bad register instructions', () => {
  const deadVariants: [string, RawInstruction][] = [
    ['unassigned read', load(0)],
    ['out-of-bounds read', load(9)],
    ['out-of-bounds write', store(9)],
    ['malformed store', { op: 'STORE' }],
    ['unknown op', { op: 'NOPE' }],
  ];

  it('lists dead register instructions in deadPcs without reporting them', () => {
    for (const [label, badInstruction] of deadVariants) {
      const instructions = [jump(2), badInstruction, bool(true), halt()];
      const analysis = analyzeTypes(withRegisters(1, instructions));
      expect(analysis.issues, label).toEqual([]);
      expect(analysis.deadPcs, label).toEqual([1]);
      expect(analysis.reachablePcs, label).toEqual([0, 2, 3]);
      expect(analysis.pcRegisters, label).toEqual({
        0: [null],
        2: [null],
        3: [null],
      });
    }
  });

  it('prunes a bad register read on a provably dead constants-mode branch', () => {
    const instructions = [bool(true), jif(4), bool(true), halt(), load(0)];
    const { analysis, concrete } = expectConcreteAgreement(instructions, 1);
    expect(analysis.issues).toEqual([]);
    expect(analysis.reachablePcs).toEqual([0, 1, 2, 3]);
    expect(analysis.deadPcs).toEqual([4]);
    expect(concrete.outcome).toBe('halted');

    // 默认模式不跟踪常量，同一指令按可达处理并报未赋值读取。
    const typesAnalysis = analyzeTypes(withRegisters(1, instructions));
    expect(typesAnalysis.issues.map((issue) => [issue.pc, issue.code])).toEqual([
      [4, 'register_read_unassigned'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 信封结构
// ---------------------------------------------------------------------------

describe('register envelope structure', () => {
  const sample = [bool(true), halt()];

  it('rejects invalid register counts without a partial report', () => {
    for (const badCount of [-1, 5, 1.5, 'two', null, Number.NaN]) {
      const result = validateProgram({ registers: badCount, instructions: sample });
      expect(result).toMatchObject({
        ok: false,
        kind: 'structural_error',
        issue: { code: 'invalid_register_count' },
      });
      expect('analysis' in result).toBe(false);
    }
  });

  it('accepts every count from 0 to 4', () => {
    for (let count = 0; count <= MAX_REGISTER_COUNT; count += 1) {
      const analysis = analyzeTypes(withRegisters(count, sample));
      expect(analysis.issues).toEqual([]);
      expect(analysis.registerCount).toBe(count);
      expect(analysis.pcRegisters![0]).toHaveLength(count);
    }
  });

  it('combines the registers field with the mode envelope field', () => {
    const analysis = analyzeConst({
      mode: 'constants',
      registers: 1,
      instructions: [bool(true), store(0), load(0), halt()],
    });
    expect(analysis.mode).toBe('constants');
    expect(analysis.registerCount).toBe(1);
    expect(analysis.pcRegisters![2]).toEqual([
      { kind: 'const', type: 'bool', value: true },
    ]);
  });

  it('threads registers through the JSON text entry point', () => {
    const text = JSON.stringify(
      withRegisters(1, [bool(true), store(0), load(0), halt()])
    );
    const analysis = programAnalysis(validateJsonText(text));
    expect(analysis.issues).toEqual([]);
    expect(analysis.registerCount).toBe(1);

    const invalid = validateJsonText(
      JSON.stringify({ registers: 9, instructions: sample })
    );
    expect(invalid).toMatchObject({
      ok: false,
      kind: 'structural_error',
      issue: { code: 'invalid_register_count' },
    });
  });
});

// ---------------------------------------------------------------------------
// 旧程序兼容
// ---------------------------------------------------------------------------

describe('programs without register configuration stay unchanged', () => {
  const directedPrograms: RawInstruction[][] = [
    [bool(true), store(0), load(0), halt()],
    [load(0), halt()],
    [bool(true), jif(4), int(1), store(0), load(0), halt()],
    [int(0), store(0), load(0), int(1), add(), store(0), jump(2)],
    [bool(true), jif(4), bool(true), halt(), load(0)],
  ];

  it('omits register report fields when the envelope has no registers key', () => {
    for (const instructions of directedPrograms) {
      for (const result of [
        validateProgram(program(instructions)),
        validateProgram(program(instructions), { mode: 'constants' }),
        validateProgram(instructions),
        validateJsonText(JSON.stringify(program(instructions))),
      ]) {
        const analysis = programAnalysis(result);
        expect(analysis).not.toHaveProperty('registerCount');
        expect(analysis).not.toHaveProperty('pcRegisters');
      }
    }
  });

  it('produces field-identical results for the wrapped and bare forms of old programs', () => {
    const oldPrograms: RawInstruction[][] = [
      [bool(true), halt()],
      [bool(true), jif(4), bool(false), halt(), int(7), halt()],
      [jump(0)],
      [int(2), int(3), add(), int(5), eq(), jif(8), bool(true), halt(), bool(false), halt()],
    ];
    for (const instructions of oldPrograms) {
      const wrapped = validateProgram(program(instructions));
      const bare = validateProgram(instructions);
      expect(wrapped).toEqual(bare);
      const analysis = programAnalysis(wrapped);
      expect(analysis).not.toHaveProperty('registerCount');
      expect(analysis).not.toHaveProperty('pcRegisters');
      expect(analysis).not.toHaveProperty('mode');
      expect(analysis).not.toHaveProperty('pcStates');
    }
  });
});

// ---------------------------------------------------------------------------
// 直线小程序枚举：寄存器模式与具体执行器逐项对拍
// ---------------------------------------------------------------------------

const straightLineOps: RawInstruction[] = [
  int(1),
  bool(true),
  add(),
  eq(),
  not(),
  dup(),
  pop(),
  store(0),
  store(1),
  load(0),
  load(1),
  halt(),
];

describe('straight-line enumeration vs concrete executor with registers', () => {
  const sequences: RawInstruction[][] = [];

  function enumerate(prefix: RawInstruction[], depth: number): void {
    if (depth === 3) {
      return;
    }
    for (const instruction of straightLineOps) {
      const next = [...prefix, instruction];
      sequences.push(next);
      enumerate(next, depth + 1);
    }
  }

  enumerate([], 0);

  it('matches the concrete executor and the default mode on every 1..3 instruction program', () => {
    expect(sequences).toHaveLength(12 + 12 ** 2 + 12 ** 3);

    for (const instructions of sequences) {
      const label = JSON.stringify(instructions);
      const typesAnalysis = analyzeTypes(withRegisters(2, instructions));
      const constAnalysis = analyzeConst(withRegisters(2, instructions));

      // 直线程序没有分支，两种模式必须给出同一份控制流描述；
      // 寄存器槽位的赋值状态与类型在两种模式间也必须一致。
      const { mode, pcStates, pcRegisters: constRegs, ...constRest } = constAnalysis;
      const { pcRegisters: typesRegs, ...typesRest } = typesAnalysis;
      expect(mode, label).toBe('constants');
      expect(constRest, label).toEqual(typesRest);
      expect(constRegs, label).toBeDefined();
      for (const [pc, states] of Object.entries(constRegs!)) {
        expect(registerTypes(states), label).toEqual(
          registerTypes(typesRegs![Number(pc)]!)
        );
      }

      // 具体执行器是独立参照：可达集合、最大栈深、错误必须完全一致。
      const concrete = runConcrete(instructions, 2);
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

export const MIN_PROGRAM_LENGTH = 1;
export const MAX_PROGRAM_LENGTH = 500;
export const MAX_STACK_DEPTH = 32;

export type StackType = 'int' | 'bool';

export type AnalysisMode = 'types' | 'constants';

export interface ValidateOptions {
  mode?: AnalysisMode;
}

/**
 * 常量感知模式下单个栈槽位的抽象状态：
 * 要么是可证明的常量，要么是只知道类型的未知值。
 * 类型部分在两种模式下始终精确。
 */
export type ValueState =
  | { kind: 'const'; type: 'int'; value: number }
  | { kind: 'const'; type: 'bool'; value: boolean }
  | { kind: 'unknown'; type: StackType };

export type OpCode =
  | 'PUSH_INT'
  | 'PUSH_BOOL'
  | 'ADD'
  | 'EQ'
  | 'NOT'
  | 'DUP'
  | 'POP'
  | 'JUMP'
  | 'JUMP_IF_FALSE'
  | 'HALT';

export interface PushIntInstruction {
  op: 'PUSH_INT';
  value: number;
}

export interface PushBoolInstruction {
  op: 'PUSH_BOOL';
  value: boolean;
}

export interface NoOperandInstruction {
  op: 'ADD' | 'EQ' | 'NOT' | 'DUP' | 'POP' | 'HALT';
}

export interface JumpInstruction {
  op: 'JUMP';
  target: number;
}

export interface JumpIfFalseInstruction {
  op: 'JUMP_IF_FALSE';
  target: number;
}

export type Instruction =
  | PushIntInstruction
  | PushBoolInstruction
  | NoOperandInstruction
  | JumpInstruction
  | JumpIfFalseInstruction;

export type DecodedInstruction =
  | { ok: true; pc: number; instruction: Instruction }
  | {
      ok: false;
      pc: number;
      op: string | number | null;
      reason:
        | 'instruction_not_object'
        | 'missing_op'
        | 'unsupported_op'
        | 'missing_integer_value'
        | 'missing_boolean_value'
        | 'missing_integer_target';
    };

export interface AttemptedOperation {
  type: 'operation';
  pc: number;
  op: string;
  stackAfter?: StackType[];
}

export interface AttemptedJump {
  type: 'jump';
  fromPc: number;
  op: 'JUMP' | 'JUMP_IF_FALSE';
  targetPc: number;
  programLength: number;
}

export interface AttemptedFallThrough {
  type: 'fall_through';
  fromPc: number;
  targetPc: number;
  programLength: number;
}

export type AttemptedEdge =
  | AttemptedOperation
  | AttemptedJump
  | AttemptedFallThrough;

export interface WitnessEdge {
  type: 'fall' | 'jump' | 'true_branch' | 'false_branch';
  fromPc: number;
  toPc: number;
  op: string;
  stackAfter: StackType[];
}

export interface MergeConflictWitness {
  existingStack: StackType[];
  incomingStack: StackType[];
  existingPath: WitnessEdge[];
  incomingPath: WitnessEdge[];
}

export interface Witness {
  startPc: 0;
  entryStack: StackType[];
  path: WitnessEdge[];
  attempted?: AttemptedEdge;
  conflicts?: MergeConflictWitness;
}

export interface ValidationIssue {
  pc: number;
  code: string;
  message: string;
  entryStack: StackType[];
  witness: Witness;
  details?: Record<string, unknown>;
}

export interface StructuralIssue {
  code:
    | 'input_not_object'
    | 'instructions_not_array'
    | 'instruction_count_out_of_range'
    | 'invalid_mode';
  message: string;
  details?: Record<string, unknown>;
}

interface WorkItem {
  pc: number;
  stack: ValueState[];
  path: WitnessEdge[];
}

interface AnalyzedProgram {
  valid: boolean;
  status: 'valid' | 'invalid';
  reachablePcs: number[];
  deadPcs: number[];
  pcSignatures: Record<number, StackType[]>;
  maxStackDepth: number;
  issues: ValidationIssue[];
  /** 以下两个字段只在常量感知模式下出现，默认模式输出保持不变。 */
  mode?: AnalysisMode;
  pcStates?: Record<number, ValueState[]>;
}

export type ValidationResult =
  | {
      ok: false;
      kind: 'json_parse_error';
      issue: { code: 'invalid_json'; message: string };
    }
  | {
      ok: false;
      kind: 'structural_error';
      issue: StructuralIssue;
    }
  | {
      ok: boolean;
      kind: 'program';
      instructionCount: number;
      analysis: AnalyzedProgram;
    };

const NO_OPERAND_OPS: ReadonlySet<string> = new Set([
  'ADD',
  'EQ',
  'NOT',
  'DUP',
  'POP',
  'HALT',
]);

function isIntegerLike(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

export function decodeInstruction(
  rawInstruction: unknown,
  pc: number
): DecodedInstruction {
  if (typeof rawInstruction !== 'object' || rawInstruction === null) {
    return { ok: false, pc, op: null, reason: 'instruction_not_object' };
  }

  const record = rawInstruction as Record<string, unknown>;
  if (!('op' in record)) {
    return { ok: false, pc, op: null, reason: 'missing_op' };
  }

  const op = record.op;
  const opName = typeof op === 'string' || typeof op === 'number' ? op : null;

  if (typeof op !== 'string') {
    return { ok: false, pc, op: opName, reason: 'unsupported_op' };
  }

  if (NO_OPERAND_OPS.has(op)) {
    return {
      ok: true,
      pc,
      instruction: { op: op as NoOperandInstruction['op'] },
    };
  }

  if (op === 'PUSH_INT') {
    if (!isIntegerLike(record.value)) {
      return { ok: false, pc, op, reason: 'missing_integer_value' };
    }
    return { ok: true, pc, instruction: { op, value: record.value } };
  }

  if (op === 'PUSH_BOOL') {
    if (typeof record.value !== 'boolean') {
      return { ok: false, pc, op, reason: 'missing_boolean_value' };
    }
    return { ok: true, pc, instruction: { op, value: record.value } };
  }

  if (op === 'JUMP' || op === 'JUMP_IF_FALSE') {
    if (!isIntegerLike(record.target)) {
      return { ok: false, pc, op, reason: 'missing_integer_target' };
    }
    return { ok: true, pc, instruction: { op, target: record.target } };
  }

  return { ok: false, pc, op, reason: 'unsupported_op' };
}

function decodeProgram(instructions: readonly unknown[]): DecodedInstruction[] {
  return instructions.map((instruction, pc) =>
    decodeInstruction(instruction, pc)
  );
}

function stackTypes(stack: readonly ValueState[]): StackType[] {
  return stack.map((value) => value.type);
}

function cloneValueStack(stack: readonly ValueState[]): ValueState[] {
  return stack.map((value) => ({ ...value }));
}

function unknownValue(type: StackType): ValueState {
  return { kind: 'unknown', type };
}

function sameValueState(left: ValueState, right: ValueState): boolean {
  if (left.kind === 'unknown' || right.kind === 'unknown') {
    return left.kind === right.kind && left.type === right.type;
  }
  return left.type === right.type && left.value === right.value;
}

function sameValueStack(
  left: readonly ValueState[],
  right: readonly ValueState[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => sameValueState(value, right[index]!))
  );
}

/**
 * 同型槽位合流：相同的可证明常量保持常量，其余情况拓宽为未知。
 * 类型不同（或深度不同）时无法合流，返回 null。
 */
function mergeValueStates(left: ValueState, right: ValueState): ValueState | null {
  if (left.type !== right.type) {
    return null;
  }
  if (left.kind === 'const' && right.kind === 'const' && left.value === right.value) {
    return { ...left };
  }
  return unknownValue(left.type);
}

function mergeStacks(
  existing: readonly ValueState[],
  incoming: readonly ValueState[]
): ValueState[] | null {
  if (existing.length !== incoming.length) {
    return null;
  }
  const merged: ValueState[] = [];
  for (let index = 0; index < existing.length; index += 1) {
    const value = mergeValueStates(existing[index]!, incoming[index]!);
    if (value === null) {
      return null;
    }
    merged.push(value);
  }
  return merged;
}

function cloneStack(stack: readonly StackType[]): StackType[] {
  return [...stack];
}

function malformedMessage(reason: string): string {
  const messages: Record<string, string> = {
    instruction_not_object: '指令必须是包含 op 字段的对象',
    missing_op: '指令缺少 op 字段',
    unsupported_op: '不支持的操作码',
    missing_integer_value: 'PUSH_INT 需要整数字段 value',
    missing_boolean_value: 'PUSH_BOOL 需要布尔字段 value',
    missing_integer_target: '跳转指令需要整数字段 target',
  };
  return messages[reason] ?? '指令格式错误';
}

function edge(
  type: WitnessEdge['type'],
  fromPc: number,
  toPc: number,
  op: string,
  stackAfter: readonly ValueState[]
): WitnessEdge {
  return {
    type,
    fromPc,
    toPc,
    op,
    stackAfter: stackTypes(stackAfter),
  };
}

function makeIssue(
  pc: number,
  code: string,
  message: string,
  entryStack: readonly StackType[],
  path: readonly WitnessEdge[],
  options: {
    attempted?: AttemptedEdge;
    conflicts?: MergeConflictWitness;
    details?: Record<string, unknown>;
  } = {}
): ValidationIssue {
  const witness: Witness = {
    startPc: 0,
    entryStack: cloneStack(entryStack),
    path: path.map((item) => ({ ...item, stackAfter: [...item.stackAfter] })),
  };

  if (options.attempted) {
    witness.attempted = options.attempted;
  }
  if (options.conflicts) {
    witness.conflicts = options.conflicts;
  }

  return {
    pc,
    code,
    message,
    entryStack: cloneStack(entryStack),
    witness,
    ...(options.details ? { details: options.details } : {}),
  };
}

function structuralIssue(
  code: StructuralIssue['code'],
  message: string,
  details?: Record<string, unknown>
): ValidationResult {
  return {
    ok: false,
    kind: 'structural_error',
    issue: { code, message, ...(details ? { details } : {}) },
  };
}

function isAnalysisMode(value: unknown): value is AnalysisMode {
  return value === 'types' || value === 'constants';
}

export function validateProgram(
  input: unknown,
  options: ValidateOptions = {}
): ValidationResult {
  if (typeof input !== 'object' || input === null) {
    return structuralIssue('input_not_object', '输入必须是指令数组或包含 instructions 数组的对象');
  }

  // 模式属于输入信封的一部分：非法模式必须整次拒绝，不能返回半份报告。
  let envelopeMode: AnalysisMode | undefined;
  if (!Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if ('mode' in record) {
      if (!isAnalysisMode(record.mode)) {
        return structuralIssue(
          'invalid_mode',
          '分析模式 mode 必须是 "types" 或 "constants"',
          { mode: record.mode }
        );
      }
      envelopeMode = record.mode;
    }
  }

  const rawInstructions = Array.isArray(input)
    ? input
    : (input as Record<string, unknown>).instructions;
  if (!Array.isArray(rawInstructions)) {
    return structuralIssue(
      'instructions_not_array',
      '输入必须是指令数组，或包含数组字段 instructions 的对象'
    );
  }
  if (
    rawInstructions.length < MIN_PROGRAM_LENGTH ||
    rawInstructions.length > MAX_PROGRAM_LENGTH
  ) {
    return structuralIssue(
      'instruction_count_out_of_range',
      `指令数量必须在 ${MIN_PROGRAM_LENGTH} 到 ${MAX_PROGRAM_LENGTH} 条之间`,
      {
        min: MIN_PROGRAM_LENGTH,
        max: MAX_PROGRAM_LENGTH,
        actual: rawInstructions.length,
      }
    );
  }

  // 显式传入的选项优先于信封里的 mode 字段；两者都必须合法。
  let mode: AnalysisMode = envelopeMode ?? 'types';
  if (options.mode !== undefined) {
    if (!isAnalysisMode(options.mode)) {
      return structuralIssue(
        'invalid_mode',
        '分析模式 mode 必须是 "types" 或 "constants"',
        { mode: options.mode }
      );
    }
    mode = options.mode;
  }
  const constantsMode = mode === 'constants';

  const decoded = decodeProgram(rawInstructions);
  const programLength = decoded.length;
  const arrivals = new Map<number, ValueState[]>();
  const arrivalPaths = new Map<number, WitnessEdge[]>();
  const issueByPc = new Map<number, ValidationIssue>();
  const queue: WorkItem[] = [{ pc: 0, stack: [], path: [] }];
  let maxStackDepth = 0;

  const recordDepth = (depth: number): void => {
    maxStackDepth = Math.max(maxStackDepth, depth);
  };

  const addIssue = (issue: ValidationIssue): void => {
    // A later back/branch edge can reach a PC after BFS already evaluated one
    // predecessor. The merge mismatch is the controlling error at that PC and
    // must not be hidden by an issue observed through only one predecessor.
    if (issue.code === 'stack_merge_conflict' || !issueByPc.has(issue.pc)) {
      issueByPc.set(issue.pc, issue);
    }
  };

  /**
   * 返回继续传播所用的栈状态；无需继续（重复到达或类型冲突）时返回 null。
   * 同型不同值合流时把槽位拓宽为未知并返回合流后的状态，调用方必须用
   * 合流后的状态重新传播后继，不能沿用首次到达时裁掉的后继。
   */
  const arrive = (item: WorkItem): ValueState[] | null => {
    const existing = arrivals.get(item.pc);
    if (existing === undefined) {
      arrivals.set(item.pc, cloneValueStack(item.stack));
      arrivalPaths.set(item.pc, cloneWitnessPath(item.path));
      return item.stack;
    }

    const merged = mergeStacks(existing, item.stack);
    if (merged === null) {
      const existingPath = arrivalPaths.get(item.pc) ?? [];
      const conflicts: MergeConflictWitness = {
        existingStack: stackTypes(existing),
        incomingStack: stackTypes(item.stack),
        existingPath: cloneWitnessPath(existingPath),
        incomingPath: cloneWitnessPath(item.path),
      };
      addIssue(
        makeIssue(
          item.pc,
          'stack_merge_conflict',
          `PC ${item.pc} 的不同可达入边具有不同栈类型序列，控制流不能合流`,
          stackTypes(item.stack),
          item.path,
          {
            conflicts,
            details: {
              existingStack: conflicts.existingStack,
              incomingStack: conflicts.incomingStack,
            },
          }
        )
      );
      return null;
    }

    if (sameValueStack(merged, existing)) {
      return null;
    }

    // 合流产生了更一般的状态（某些常量变成未知）：每个槽位最多只会
    // 从常量提升为未知一次，因此重新传播必然终止。
    arrivals.set(item.pc, cloneValueStack(merged));
    arrivalPaths.set(item.pc, cloneWitnessPath(item.path));
    return merged;
  };

  const enqueueSuccessor = (
    fromPc: number,
    toPc: number,
    stackAfter: ValueState[],
    pathAfter: WitnessEdge[],
    edgeType: WitnessEdge['type'],
    op: string
  ): void => {
    const nextPath = [
      ...pathAfter,
      edge(edgeType, fromPc, toPc, op, stackAfter),
    ];
    queue.push({ pc: toPc, stack: stackAfter, path: nextPath });
  };

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }

    const stack = arrive(current);
    if (stack === null) {
      continue;
    }

    const { pc, path } = current;
    recordDepth(stack.length);

    const decodedInstruction = decoded[pc];
    if (decodedInstruction === undefined) {
      continue;
    }

    if (!decodedInstruction.ok) {
      addIssue(
        makeIssue(
          pc,
          'malformed_instruction',
          malformedMessage(decodedInstruction.reason),
          stackTypes(stack),
          path,
          {
            attempted: { type: 'operation', pc, op: String(decodedInstruction.op) },
            details: {
              reason: decodedInstruction.reason,
              op: decodedInstruction.op,
            },
          }
        )
      );
      continue;
    }

    const instruction = decodedInstruction.instruction;
    const op = instruction.op;

    const operationIssue = (
      code: string,
      message: string,
      details?: Record<string, unknown>,
      stackAfter?: StackType[]
    ): void => {
      addIssue(
        makeIssue(pc, code, message, stackTypes(stack), path, {
          attempted: { type: 'operation', pc, op, ...(stackAfter ? { stackAfter } : {}) },
          ...(details ? { details } : {}),
        })
      );
    };

    const underflow = (expected: number): void => {
      operationIssue(
        'stack_underflow',
        `PC ${pc} 的 ${op} 需要至少 ${expected} 个栈值，但当前只有 ${stack.length} 个`,
        { expected, actual: stack.length }
      );
    };

    const continueAt = (
      nextPc: number,
      stackAfter: ValueState[],
      edgeType: WitnessEdge['type'] = 'fall'
    ): void => {
      recordDepth(stackAfter.length);
      if (nextPc >= programLength) {
        addIssue(
          makeIssue(
            pc,
            'fall_through',
            `PC ${pc} 执行后跌出程序末尾`,
            stackTypes(stack),
            path,
            {
              attempted: {
                type: 'fall_through',
                fromPc: pc,
                targetPc: nextPc,
                programLength,
              },
              details: { targetPc: nextPc, programLength },
            }
          )
        );
        return;
      }
      enqueueSuccessor(pc, nextPc, stackAfter, path, edgeType, op);
    };

    const jumpTo = (
      targetPc: number,
      stackAfter: ValueState[],
      edgeType: 'jump' | 'true_branch' | 'false_branch'
    ): void => {
      recordDepth(stackAfter.length);
      if (targetPc < 0 || targetPc >= programLength) {
        addIssue(
          makeIssue(
            pc,
            'jump_target_out_of_bounds',
            `PC ${pc} 的 ${op} 目标地址 ${targetPc} 越界`,
            stackTypes(stack),
            path,
            {
              attempted: {
                type: 'jump',
                fromPc: pc,
                op: op === 'JUMP' ? 'JUMP' : 'JUMP_IF_FALSE',
                targetPc,
                programLength,
              },
              details: { targetPc, programLength },
            }
          )
        );
        return;
      }
      enqueueSuccessor(pc, targetPc, stackAfter, path, edgeType, op);
    };

    switch (instruction.op) {
      case 'PUSH_INT': {
        const pushed: ValueState = constantsMode
          ? { kind: 'const', type: 'int', value: instruction.value }
          : unknownValue('int');
        if (stack.length >= MAX_STACK_DEPTH) {
          operationIssue(
            'stack_overflow',
            `PC ${pc} 入栈将超过最大栈深 ${MAX_STACK_DEPTH}`,
            {
              maxStackDepth: MAX_STACK_DEPTH,
              attemptedSize: stack.length + 1,
            },
            stackTypes([...stack, pushed])
          );
          break;
        }
        continueAt(pc + 1, [...stack, pushed]);
        break;
      }

      case 'PUSH_BOOL': {
        const pushed: ValueState = constantsMode
          ? { kind: 'const', type: 'bool', value: instruction.value }
          : unknownValue('bool');
        if (stack.length >= MAX_STACK_DEPTH) {
          operationIssue(
            'stack_overflow',
            `PC ${pc} 入栈将超过最大栈深 ${MAX_STACK_DEPTH}`,
            {
              maxStackDepth: MAX_STACK_DEPTH,
              attemptedSize: stack.length + 1,
            },
            stackTypes([...stack, pushed])
          );
          break;
        }
        continueAt(pc + 1, [...stack, pushed]);
        break;
      }

      case 'ADD': {
        if (stack.length < 2) {
          underflow(2);
          break;
        }
        const right = stack[stack.length - 1]!;
        const left = stack[stack.length - 2]!;
        if (left.type !== 'int' || right.type !== 'int') {
          operationIssue(
            'type_error',
            `PC ${pc} 的 ADD 只接受两个整数`,
            {
              expected: ['int', 'int'],
              actual: [left.type, right.type],
              leftType: left.type,
              rightType: right.type,
            }
          );
          break;
        }
        const result: ValueState =
          left.kind === 'const' && right.kind === 'const'
            ? { kind: 'const', type: 'int', value: left.value + right.value }
            : unknownValue('int');
        continueAt(pc + 1, [...stack.slice(0, -2), result]);
        break;
      }

      case 'EQ': {
        if (stack.length < 2) {
          underflow(2);
          break;
        }
        const right = stack[stack.length - 1]!;
        const left = stack[stack.length - 2]!;
        if (left.type !== right.type) {
          operationIssue(
            'type_error',
            `PC ${pc} 的 EQ 只能比较两个同类型值`,
            {
              leftType: left.type,
              rightType: right.type,
            }
          );
          break;
        }
        const result: ValueState =
          left.kind === 'const' && right.kind === 'const'
            ? { kind: 'const', type: 'bool', value: left.value === right.value }
            : unknownValue('bool');
        continueAt(pc + 1, [...stack.slice(0, -2), result]);
        break;
      }

      case 'NOT': {
        if (stack.length < 1) {
          underflow(1);
          break;
        }
        const top = stack[stack.length - 1]!;
        if (top.type !== 'bool') {
          operationIssue(
            'type_error',
            `PC ${pc} 的 NOT 只接受布尔值`,
            { expected: 'bool', actual: top.type, topType: top.type }
          );
          break;
        }
        const result: ValueState =
          top.kind === 'const' && top.type === 'bool'
            ? { kind: 'const', type: 'bool', value: !top.value }
            : unknownValue('bool');
        continueAt(pc + 1, [...stack.slice(0, -1), result]);
        break;
      }

      case 'DUP': {
        if (stack.length < 1) {
          underflow(1);
          break;
        }
        const top = stack[stack.length - 1]!;
        if (stack.length >= MAX_STACK_DEPTH) {
          operationIssue(
            'stack_overflow',
            `PC ${pc} 复制栈顶将超过最大栈深 ${MAX_STACK_DEPTH}`,
            {
              maxStackDepth: MAX_STACK_DEPTH,
              attemptedSize: stack.length + 1,
            },
            stackTypes([...stack, top])
          );
          break;
        }
        continueAt(pc + 1, [...stack, { ...top }]);
        break;
      }

      case 'POP': {
        if (stack.length < 1) {
          underflow(1);
          break;
        }
        continueAt(pc + 1, stack.slice(0, -1));
        break;
      }

      case 'JUMP': {
        jumpTo(instruction.target, cloneValueStack(stack), 'jump');
        break;
      }

      case 'JUMP_IF_FALSE': {
        if (stack.length < 1) {
          underflow(1);
          break;
        }
        const top = stack[stack.length - 1]!;
        if (top.type !== 'bool') {
          operationIssue(
            'type_error',
            `PC ${pc} 的 JUMP_IF_FALSE 只接受弹出的布尔值`,
            { expected: 'bool', actual: top.type, topType: top.type }
          );
          break;
        }
        const afterPop = stack.slice(0, -1);
        if (top.kind === 'const' && top.type === 'bool') {
          // 可证明的常量条件：只沿实际会走的边传播，另一条边证明不可达。
          if (top.value) {
            continueAt(pc + 1, afterPop, 'true_branch');
          } else {
            jumpTo(instruction.target, afterPop, 'false_branch');
          }
        } else {
          // 未知条件必须保守探索两边。
          jumpTo(instruction.target, afterPop, 'false_branch');
          continueAt(pc + 1, [...afterPop], 'true_branch');
        }
        break;
      }

      case 'HALT': {
        if (stack.length !== 1) {
          operationIssue(
            'halt_stack_size',
            `HALT 时栈必须恰有一个值，当前有 ${stack.length} 个`,
            { expectedSize: 1, actualSize: stack.length }
          );
          break;
        }
        const top = stack[0]!;
        if (top.type !== 'bool') {
          operationIssue(
            'halt_stack_not_boolean',
            'HALT 时唯一的栈值必须是布尔值',
            { expected: 'bool', actual: top.type, topType: top.type }
          );
        }
        break;
      }
    }
  }

  const reachablePcs = [...arrivals.keys()].sort((a, b) => a - b);
  const pcSignatures = Object.fromEntries(
    reachablePcs.map((pc) => [pc, stackTypes(arrivals.get(pc) ?? [])])
  );
  const deadPcs = decoded
    .map((_, pc) => pc)
    .filter((pc) => !arrivals.has(pc));

  const issues = [...issueByPc.values()].sort((left, right) => {
    if (left.pc !== right.pc) {
      return left.pc - right.pc;
    }
    return left.code.localeCompare(right.code);
  });

  const analysis: AnalyzedProgram = {
    valid: issues.length === 0,
    status: issues.length === 0 ? 'valid' : 'invalid',
    reachablePcs,
    deadPcs,
    pcSignatures,
    maxStackDepth,
    issues,
  };

  if (constantsMode) {
    // 可达清单、最大栈深、错误报告都来自上面同一次不动点传播；
    // pcStates 只是同一份到达状态的常量视角，保证四处不描述不同的控制流。
    analysis.mode = 'constants';
    analysis.pcStates = Object.fromEntries(
      reachablePcs.map((pc) => [pc, cloneValueStack(arrivals.get(pc) ?? [])])
    );
  }

  return {
    ok: issues.length === 0,
    kind: 'program',
    instructionCount: programLength,
    analysis,
  };
}

function cloneWitnessPath(path: readonly WitnessEdge[]): WitnessEdge[] {
  return path.map((item) => ({ ...item, stackAfter: [...item.stackAfter] }));
}

export function validateJsonText(
  text: string,
  options: ValidateOptions = {}
): ValidationResult {
  try {
    const parsed: unknown = JSON.parse(text);
    return validateProgram(parsed, options);
  } catch (error) {
    return {
      ok: false,
      kind: 'json_parse_error',
      issue: {
        code: 'invalid_json',
        message: error instanceof Error ? error.message : 'JSON 解析失败',
      },
    };
  }
}

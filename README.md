# vmcheck 栈机 JSON 校验器

这是一个 TypeScript/Node.js 命令行校验器，用于在执行设备控制脚本前做静态控制流检查。它会从 PC 0 的空栈出发，沿所有可达控制流边传播**完整的栈类型序列**，而不是只传播栈深度。

## 输入格式

输入可以是 `{ "instructions": [...] }` 包装对象，也可以直接是顶层指令数组；指令数量为 1～500。包装对象格式：

```json
{
  "instructions": [
    { "op": "PUSH_BOOL", "value": true },
    { "op": "HALT" }
  ]
}
```

也可以写成：

```json
[
  { "op": "PUSH_BOOL", "value": true },
  { "op": "HALT" }
]
```

支持的指令：

| 指令 | 操作数 | 栈语义 |
| --- | --- | --- |
| `PUSH_INT` | `value: integer` | 压入 `int` |
| `PUSH_BOOL` | `value: boolean` | 压入 `bool` |
| `ADD` | 无 | 弹出两个 `int`，压入一个 `int`；布尔值不能当数字相加 |
| `EQ` | 无 | 弹出两个同类型值，压入一个 `bool` |
| `NOT` | 无 | 弹出一个 `bool`，压入一个 `bool` |
| `DUP` | 无 | 复制栈顶 |
| `POP` | 无 | 弹出栈顶 |
| `JUMP` | `target: integer` | 绝对地址跳转，目标必须在程序范围内 |
| `JUMP_IF_FALSE` | `target: integer` | 弹出一个 `bool`；真分支落到下一条，假分支跳到 `target` |
| `HALT` | 无 | 停机；此时栈必须恰好有一个 `bool` |

校验规则：

- 最大允许栈深为 32。
- 每个可达 PC 只能有一个入栈类型序列；不同入边产生不同序列时报 `stack_merge_conflict`。
- 可达的下溢、类型错误、越界跳转、栈溢出、非法 HALT 栈和末尾跌出都会使程序无效。
- 不可达指令只列入 `deadPcs`，即使格式错误也不会触发校验错误。
- 分析只跟踪类型，不跟踪具体布尔值，因此 `JUMP_IF_FALSE` 的两个分支都会按可达处理。
- 固定栈状态的循环是允许的；不断改变栈类型序列的循环会在回边合流时被拒绝。

## 常量感知模式（默认关闭）

默认的类型模式行为与输出字段保持不变。需要区分"真正可能出错的分支"与"永远到不了的坏指令"时，可以启用常量感知模式：

- 输入信封加 `"mode": "constants"` 字段；
- 或命令行加 `--constants` / `--mode constants`（`--types` / `--mode types` 显式回到默认模式，命令行选项优先于信封字段）；
- 或 API 调用 `validateProgram(input, { mode: 'constants' })` / `validateJsonText(text, { mode: 'constants' })`。

信封或选项里的模式不是 `"types"` / `"constants"` 时，整次输入以 `structural_error`（`invalid_mode`）拒绝，不返回半份报告；命令行 `--mode` 收到未知值时退出码为 2。

启用后的语义：

- 栈状态除类型外还区分**可证明的常量**与**未知值**：`PUSH_INT`/`PUSH_BOOL` 产生常量，`ADD`/`EQ`/`NOT` 在常量输入上直接折叠，`DUP` 保留常量。
- `JUMP_IF_FALSE` 的条件是可证明常量时，只沿实际会走的边传播；另一条边证明不可达，其上的指令（哪怕是坏指令）只列入 `deadPcs`，也不再做越界检查。条件未知时保守探索两边。
- 同一 PC 同型不同值的入边合流后，对应槽位拓宽为未知，并用合流后的状态**重新传播**后继——不会沿用首次到达时裁掉的后继。每个槽位最多从常量提升为未知一次，分析保证终止。
- 类型冲突、栈深、HALT 与循环规则在两种模式下完全一致；只有证明确实不可达的指令才列入 `deadPcs`。
- 可达清单、最大栈深、错误见证与 `pcStates` 来自同一次不动点传播，描述同一份控制流。

常量模式的报告额外包含两个字段（默认模式的输出字段一个不多）：

- `analysis.mode: "constants"`；
- `analysis.pcStates`：每个可达 PC 的入栈槽位状态，形如 `{ "kind": "const", "type": "int", "value": 5 }` 或 `{ "kind": "unknown", "type": "bool" }`；`pcSignatures` 仍是纯类型序列。

```bash
node dist/cli.js --constants examples/const-pruned.json   # 退出码 0，坏指令证明不可达
node dist/cli.js examples/const-pruned.json               # 默认模式：退出码 1，坏指令按可达处理
node dist/cli.js examples/constant-mode.json              # 信封自带 "mode": "constants"
```

## 本地运行

```bash
npm install
npm run build
node dist/cli.js examples/valid.json
# 或从 stdin 读取
node dist/cli.js < examples/valid.json
```

退出码：

- `0`：程序有效；
- `1`：JSON、输入结构或可达控制流校验失败；
- `2`：命令行参数或文件读取错误。

成功输出包含每个可达 PC 的入栈签名和最大栈深，例如：

```json
{
  "ok": true,
  "kind": "program",
  "instructionCount": 2,
  "analysis": {
    "valid": true,
    "status": "valid",
    "reachablePcs": [0, 1],
    "deadPcs": [],
    "pcSignatures": {
      "0": [],
      "1": ["bool"]
    },
    "maxStackDepth": 1,
    "issues": []
  }
}
```

失败输出包含 `issues`。每个 issue 都带有从 PC 0 出发的实际控制流见证：

- 普通操作错误：`witness.path` 加 `witness.attempted`；
- 越界跳转：`witness.attempted.type === "jump"`；
- 末尾跌出：`witness.attempted.type === "fall_through"`；
- 合流冲突：`witness.conflicts` 同时包含两条入边的栈序列和完整路径。

## Docker Compose

`vmcheck` 服务使用同一个 CLI 入口：

```bash
docker compose build vmcheck
docker compose run --rm vmcheck /app/examples/valid.json
docker compose run --rm -T vmcheck < examples/valid.json
```

校验失败时 Compose 命令返回退出码 1；成功时返回 0。

## 测试

```bash
npm test
```

Vitest 覆盖：

- 分支合流成功与 `stack_merge_conflict`；
- 回边不断增栈的循环；
- 不可达坏指令只列入 `deadPcs`；
- 栈深 32 的边界和第 33 项溢出；
- 越界跳转、末尾跌出、下溢、类型错误和 HALT 栈约束；
- 对 8 个直线指令生成全部 1～4 长度小程序（共 4680 个），与独立参考抽象状态枚举器逐项对拍；
- 常量感知模式：常量分支剪枝、回边把循环携带值拓宽为未知、合流后重新传播并探索此前裁掉的后继、证明不可达的坏指令、非法模式整次拒绝，以及用独立的小程序具体执行器核对可达集合、最大栈深与错误报告；默认模式在各入口结果逐字段不变；
- CLI 文件输入、stdin 输入、模式参数（`--constants`/`--types`/`--mode`、信封 `mode` 字段与覆盖优先级）和退出码。

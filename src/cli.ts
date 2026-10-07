#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import type { AnalysisMode, ValidateOptions, ValidationResult } from './validator';
import { validateJsonText } from './validator';

const USAGE =
  '用法：vmcheck [--mode types|constants] [--constants] [--types] [program.json]；不传文件参数时从标准输入读取';

class UsageError extends Error {}

function parseMode(value: string): AnalysisMode {
  if (value === 'types' || value === 'constants') {
    return value;
  }
  throw new UsageError(`未知分析模式：${value}（可选 types 或 constants）`);
}

function parseArgs(args: string[]): { filePath?: string; options: ValidateOptions } {
  let filePath: string | undefined;
  let mode: AnalysisMode | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--constants') {
      mode = 'constants';
    } else if (arg === '--types') {
      mode = 'types';
    } else if (arg === '--mode') {
      const value = args[index + 1];
      if (value === undefined) {
        throw new UsageError('--mode 需要参数：types 或 constants');
      }
      index += 1;
      mode = parseMode(value);
    } else if (arg.startsWith('--mode=')) {
      mode = parseMode(arg.slice('--mode='.length));
    } else if (arg.startsWith('-')) {
      throw new UsageError(`未知参数：${arg}\n${USAGE}`);
    } else if (filePath !== undefined) {
      throw new UsageError(USAGE);
    } else {
      filePath = arg;
    }
  }

  return { filePath, options: mode === undefined ? {} : { mode } };
}

async function readInput(filePath: string | undefined): Promise<string> {
  if (filePath !== undefined) {
    return fs.readFile(filePath, 'utf8');
  }

  return readStdin();
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function printResult(result: ValidationResult): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main(): Promise<number> {
  try {
    const { filePath, options } = parseArgs(process.argv.slice(2));
    const input = await readInput(filePath);
    // 命令行显式给出的模式优先于输入信封里的 mode 字段。
    const result = validateJsonText(input, options);
    printResult(result);
    if (result.kind === 'program') {
      return result.ok ? 0 : 1;
    }
    return 1;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`读取输入失败：${message}\n`);
    return 2;
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
});

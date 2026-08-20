import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './specs.mjs';

export async function runStep(step) {
  const started = Date.now();
  return await new Promise((resolve) => {
    const shell = process.platform === 'win32'
      && (!path.isAbsolute(step.command) || /\.(?:cmd|bat)$/i.test(step.command));
    const child = spawn(step.command, step.args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell,
    });

    child.on('close', (exitCode) => {
      resolve({
        ...step,
        status: exitCode === 0 ? 'pass' : 'fail',
        exitCode,
        durationMs: Date.now() - started,
      });
    });
  });
}

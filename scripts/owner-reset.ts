import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { resetOwner } from '../lib/auth.ts';

if (!stdin.isTTY || !stdin.setRawMode) {
 console.error('Run this command from an interactive terminal.');
 process.exit(1);
}

const input = createInterface({ input: stdin, output: stdout });
const username = await input.question('Owner username: ');
input.close();

let queuedInput = '';
let wakeReader: (() => void) | undefined;
const receiveInput = (chunk: Buffer) => {
 queuedInput += chunk.toString('utf8');
 wakeReader?.();
};
stdin.on('data', receiveInput);

async function readHiddenLine(prompt: string) {
 stdin.setRawMode(true);
 stdin.resume();
 stdout.write(prompt);
 let value = '';
 try {
  while (true) {
   const newline = queuedInput.search(/[\r\n]/);
   const content = newline >= 0 ? queuedInput.slice(0, newline) : queuedInput;
   for (const char of content) {
    if (char === '\u0003') throw new Error('Cancelled.');
    if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
    else value += char;
   }
   if (newline >= 0) {
    const terminator = queuedInput[newline];
    queuedInput = queuedInput.slice(newline + 1);
    if (terminator === '\r' && queuedInput.startsWith('\n')) queuedInput = queuedInput.slice(1);
    stdout.write('\n');
    return value;
   }
   queuedInput = '';
   if (Buffer.byteLength(value) > 1024) {
    throw new Error('Password must be at most 1024 bytes.');
   }
   await new Promise<void>(resolve => { wakeReader = resolve; });
   wakeReader = undefined;
  }
 } finally {
  stdin.setRawMode(false);
 }
}

try {
 const password = await readHiddenLine('New owner password (hidden): ');
 const confirmation = await readHiddenLine('Confirm password (hidden): ');
 if (password !== confirmation) throw new Error('Passwords do not match.');
 await resetOwner(username, password);
 console.log('Owner password updated and all sessions revoked.');
} catch (error) {
 console.error(error instanceof Error ? error.message : 'Owner reset failed.');
 process.exitCode = 1;
} finally {
 stdin.removeListener('data', receiveInput);
 stdin.pause();
}

import { chmodSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateWebPushConfig } from '../lib/web-push.ts';

function parseArguments(): { output?: string; subject?: string } {
  const result: { output?: string; subject?: string } = {};
  const args = process.argv.slice(2);
  if (args.length !== 4) return result;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (typeof value !== 'string' || !value || (flag !== '--output' && flag !== '--subject') || flag.slice(2) in result) return {};
    result[flag.slice(2) as 'output' | 'subject'] = value;
  }
  return result;
}

try {
  const { output: outputArg, subject } = parseArguments();
  if (!outputArg || !subject) {
    throw new Error('Usage: node --experimental-strip-types scripts/generate-push-keys.ts --output /path/web-push.json --subject https://example.com');
  }
  const output = resolve(outputArg);
  const config = generateWebPushConfig(subject);
  writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chmodSync(output, 0o600);
  process.stdout.write(`${JSON.stringify({ output, publicKey: config.publicKey }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error && error.message.startsWith('Usage:') ? error.message : 'Could not create the VAPID key file. Check the subject and ensure the output path does not already exist.'}\n`);
  process.exitCode = 1;
}

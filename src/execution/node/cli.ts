import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { parseJob } from '../../adapters/node/input';
import { executeJob } from './index';

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string', short: 'i' },
      output: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
      'allow-js': { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    process.stdout.write('Usage: node dist/node/cli.cjs --input params.json [--output result.json] [--allow-js]\nInput: exported UI parameters, normalized {params,strategy,overrides,mode}, or an array of jobs.\nWithout --output, JSON is written to stdout. Existing output files are never overwritten.\n--allow-js executes trusted JavaScript strategies with the full permissions of this process.\n');
    return;
  }
  if (!values.input) throw new Error('--input is required. Use --help for supported formats.');
  if (values.output && resolve(values.input) === resolve(values.output)) throw new Error('Input and output paths must differ.');
  const input: unknown = JSON.parse(await readFile(values.input, 'utf8'));
  const jobs = (Array.isArray(input) ? input : [input]).map(parseJob);
  if (!values['allow-js'] && jobs.some(job => job.mode === 'js')) {
    throw new Error('JavaScript strategies require --allow-js and must be trusted; this process is not a sandbox.');
  }
  const results = jobs.map(executeJob);
  const json = JSON.stringify(Array.isArray(input) ? results : results[0], null, 2) + '\n';
  if (values.output) await writeFile(values.output, json, { flag: 'wx' });
  else process.stdout.write(json);
}

main().catch(error => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});

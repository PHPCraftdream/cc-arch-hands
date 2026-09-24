import { appendFileSync } from 'node:fs';

if (process.env.CLI_RUN_TEST_QUEUE_FAIL === '1') process.exit(9);
const [action, , thread, , message] = process.argv.slice(2);
appendFileSync(process.env.CLI_RUN_TEST_QUEUE_LOG, `${action}|${thread}|${message}\n`);

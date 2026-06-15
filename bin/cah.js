#!/usr/bin/env node
import { run } from '../lib/cli.js';

process.exit(run(process.argv.slice(2)));

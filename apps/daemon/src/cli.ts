#!/usr/bin/env node

import { runDaemonCliStartup } from './daemon-startup.js';

await runDaemonCliStartup(process.argv.slice(2));

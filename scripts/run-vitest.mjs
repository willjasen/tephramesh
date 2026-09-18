#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function normalizeVitestArgs(argv = process.argv.slice(2)) {
  const normalized = [...argv];
  const filtered = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const arg = normalized[index];

    if (arg === '--runInBand' || arg === '--watchAll' || arg === '--watchAll=false') {
      continue;
    }

    if (arg === '--ci') {
      filtered.push('--run');
      continue;
    }

    if (arg === '--watch' || arg === '--watch=false') {
      filtered.push(arg);
      continue;
    }

    filtered.push(arg);
  }

  if (filtered.length === 0) {
    return ['run'];
  }

  const hasRunFlag = filtered.some((entry) => entry === 'run' || entry === 'watch');
  if (!hasRunFlag && filtered.length > 0 && filtered.every((entry) => !entry.startsWith('-'))) {
    return ['run', ...filtered];
  }

  return filtered;
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }

  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const args = normalizeVitestArgs();
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', ...args], {
    stdio: 'inherit',
    shell: false,
    cwd: process.cwd(),
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}

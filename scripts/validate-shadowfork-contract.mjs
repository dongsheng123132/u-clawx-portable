#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(root, '.shadowfork', 'upstream.yaml');
const contract = YAML.parse(readFileSync(contractPath, 'utf8'));
const errors = [];

if (contract?.apiVersion !== 'shadowfork.io/v1alpha1') errors.push('invalid apiVersion');
if (contract?.kind !== 'DerivationContract') errors.push('invalid kind');

for (const item of contract?.identity ?? []) {
  const filename = path.join(root, item.file);
  if (!existsSync(filename)) {
    errors.push(`identity file missing: ${item.file}`);
    continue;
  }
  if (!item.path?.startsWith('$.')) {
    errors.push(`identity path missing: ${item.file}`);
    continue;
  }
  const raw = readFileSync(filename, 'utf8');
  const value = /\.ya?ml$/i.test(filename) ? YAML.parse(raw) : JSON.parse(raw);
  let current = value;
  for (const token of item.path.slice(2).split('.')) {
    if (!current || !Object.prototype.hasOwnProperty.call(current, token)) {
      errors.push(`identity path missing: ${item.file} ${item.path}`);
      break;
    }
    current = current[token];
  }
}

for (const item of contract?.protected ?? []) {
  if (item.file && !existsSync(path.join(root, item.file))) {
    errors.push(`protected file missing: ${item.file}`);
  }
}

for (const item of contract?.extensionPoints ?? []) {
  const target = item.file ?? item.dir;
  if (!target || !existsSync(path.join(root, target))) {
    errors.push(`extension point missing: ${target ?? '(empty)'}`);
  }
}

if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, contract: '.shadowfork/upstream.yaml' }));

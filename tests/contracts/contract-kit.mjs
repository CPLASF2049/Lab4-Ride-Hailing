import { readFileSync } from 'node:fs';

export function loadContract(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const typeOf = value => Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;

/** Validates one response against a Pact interaction's status/headers/body and its matchingRules. */
export function validateInteraction(interaction, response) {
  const failures = [];
  if (response.status !== interaction.response.status) {
    failures.push(`status: expected ${interaction.response.status}, got ${response.status}`);
  }
  const contentType = response.headers?.['content-type'] || '';
  const expectedType = interaction.response.headers?.['Content-Type'] || 'application/json';
  if (!contentType.includes(expectedType.split(';')[0])) {
    failures.push(`content-type: expected ${expectedType}, got ${contentType || '(missing)'}`);
  }
  const rules = interaction.response.matchingRules || {};
  const walk = (expected, actual, path) => {
    const rule = rules[path];
    if (rule?.match === 'type') {
      if (typeOf(actual) !== typeOf(expected)) failures.push(`${path}: type ${typeOf(expected)} expected, got ${typeOf(actual)}`);
      return;
    }
    if (rule?.match === 'like') {
      if (typeOf(actual) !== typeOf(expected)) failures.push(`${path}: like ${typeOf(expected)} expected, got ${typeOf(actual)}`);
      return;
    }
    if (expected === null) {
      if (actual !== null) failures.push(`${path}: expected null, got ${JSON.stringify(actual)}`);
      return;
    }
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) return failures.push(`${path}: expected array`);
      expected.forEach((item, index) => walk(item, actual[index], `${path}[${index}]`));
      return;
    }
    if (typeof expected === 'object') {
      if (!actual || typeof actual !== 'object') return failures.push(`${path}: expected object`);
      for (const [key, value] of Object.entries(expected)) walk(value, actual[key], `${path}.${key}`);
      return;
    }
    if (actual !== expected) failures.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  walk(interaction.response.body, response.body, '$.body');
  return failures;
}

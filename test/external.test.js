import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractorEndpoint } from '../src/scrapers/external.js';

test('external extractor ignores the commented placeholder from example env files', () => {
  assert.equal(extractorEndpoint('# optional external resolver (see docs/MOCKUP.md §3)'), null);
  assert.equal(extractorEndpoint('   '), null);
  assert.equal(extractorEndpoint('file:///tmp/extractor'), null);
  assert.equal(extractorEndpoint('http://extractor:7000/extract'), 'http://extractor:7000/extract');
});

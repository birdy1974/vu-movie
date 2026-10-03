import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNetworkNavigationError } from '../src/scrapers/browser.js';

test('browser navigation reachability errors are recognized as terminal', () => {
  assert.equal(isNetworkNavigationError('page.goto: net::ERR_CONNECTION_REFUSED at https://overlook.cx/movies/123'), true);
  assert.equal(isNetworkNavigationError('net::ERR_NAME_NOT_RESOLVED'), true);
  assert.equal(isNetworkNavigationError('net::ERR_CONNECTION_TIMED_OUT'), true);
});

test('ordinary page and Playwright timeouts are not classified as connection errors', () => {
  assert.equal(isNetworkNavigationError('Timeout 30000ms exceeded.'), false);
  assert.equal(isNetworkNavigationError('HTTP 403: Forbidden'), false);
});

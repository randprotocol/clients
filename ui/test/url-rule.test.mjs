import test from 'node:test';
import assert from 'node:assert/strict';
import { urlRule } from '../lib/url-rule.js';

test('https is accepted anywhere, trimmed, without trailing slashes', () => {
  assert.deepEqual(urlRule('https://rpc.randprotocol.org'), { url: 'https://rpc.randprotocol.org' });
  assert.deepEqual(urlRule('  https://rpc.example.com:8443/api//  '), { url: 'https://rpc.example.com:8443/api' });
});

test('plain http is accepted only for this machine', () => {
  assert.deepEqual(urlRule('http://localhost:8545'), { url: 'http://localhost:8545' });
  assert.deepEqual(urlRule('http://127.0.0.1:8545/'), { url: 'http://127.0.0.1:8545' });
  assert.deepEqual(urlRule('http://[::1]:8545'), { url: 'http://[::1]:8545' });
  assert.deepEqual(urlRule('http://rpc.example.com'), { problem: 'plain-http' });
  assert.deepEqual(urlRule('http://192.168.100.60:8545'), { problem: 'plain-http' });
  // a lookalike host is not this machine
  assert.deepEqual(urlRule('http://localhost.evil.example'), { problem: 'plain-http' });
});

test('empty, blank and null are "empty", not a problem', () => {
  for (const v of ['', '   ', '///', null, undefined]) assert.deepEqual(urlRule(v), { empty: true }, String(v));
});

test('text that is not a URL, and other schemes, are named', () => {
  assert.deepEqual(urlRule('not a url'), { problem: 'not-url' });
  assert.deepEqual(urlRule('rpc.randprotocol.org'), { problem: 'not-url' });
  // `localhost:` parses as a scheme, which is not one this wallet speaks
  assert.deepEqual(urlRule('localhost:8545'), { problem: 'scheme' });
  assert.deepEqual(urlRule('ftp://example.com'), { problem: 'scheme' });
  assert.deepEqual(urlRule('javascript:alert(1)'), { problem: 'scheme' });
  assert.deepEqual(urlRule('ws://localhost:1'), { problem: 'scheme' });
});

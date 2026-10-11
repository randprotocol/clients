import test from 'node:test';
import assert from 'node:assert/strict';
import { markInvalid, markValid } from '../lib/forms.js';

// Just enough of an element for the two helpers: a class set and an attribute map.
function el() {
  const classes = new Set();
  const attrs = new Map();
  return {
    classes, attrs,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
  };
}

test('markInvalid flags the wrap and points the input at its error', () => {
  const wrap = el(), input = el();
  markInvalid(wrap, input, 'err-1');
  assert.ok(wrap.classes.has('invalid'));
  assert.equal(input.attrs.get('aria-invalid'), 'true');
  assert.equal(input.attrs.get('aria-describedby'), 'err-1');
});

test('markValid points back at the hint, never leaving the error referenced', () => {
  const wrap = el(), input = el();
  markInvalid(wrap, input, 'err-1');
  markValid(wrap, input, 'hint-1');
  assert.ok(!wrap.classes.has('invalid'));
  assert.ok(!input.attrs.has('aria-invalid'));
  assert.equal(input.attrs.get('aria-describedby'), 'hint-1');
});

test('markValid on a field with no hint clears aria-describedby', () => {
  const wrap = el(), input = el();
  markInvalid(wrap, input, 'err-1');
  markValid(wrap, input);
  assert.ok(!input.attrs.has('aria-describedby'));
  assert.ok(!input.attrs.has('aria-invalid'));
});

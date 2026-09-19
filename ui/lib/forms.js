// Shared inline-validation helpers for `.field`-wrapped inputs, used by every onboarding/lock
// screen (create, import, backup, lock). One place for the aria wiring so it can't drift between
// screens: an invalid field points `aria-describedby` at its `.error` span and sets
// `aria-invalid="true"`; a valid field points `aria-describedby` back at its `.hint` span (or
// clears it, if the field has no hint) and drops `aria-invalid` — never leaves it pointed at an
// error message that no longer applies.
//
// Importable under plain Node: no `document`/`window` access at module scope.

/** Marks `wrap` (a `.field` label) invalid, describing `input` by the `.error` span at `errorId`. */
export function markInvalid(wrap, input, errorId) {
  wrap.classList.add('invalid');
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', errorId);
}

/** Marks `wrap` valid again, restoring `aria-describedby` to `hintId` (the field's `.hint` span),
 *  or removing it entirely if the field has no hint. */
export function markValid(wrap, input, hintId) {
  wrap.classList.remove('invalid');
  input.removeAttribute('aria-invalid');
  if (hintId) input.setAttribute('aria-describedby', hintId);
  else input.removeAttribute('aria-describedby');
}

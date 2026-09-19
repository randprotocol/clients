// Moved to ui/engine/crypto.js in task 1.6 (it was already storage- and platform-agnostic, and
// the web wallet needs the same vault format). Re-export shim for the old extension UI, deleted
// with that UI in task 2.1.
export * from '../../../ui/engine/crypto.js';

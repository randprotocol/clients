// The one rule for where this wallet may send requests — a node (Settings' RPC field) or a paired
// prover (delegated proving): https anywhere; plain http only to this machine, because a plaintext
// answer is something a network can rewrite. Each caller words the refusal for its own field.
//
//   urlRule(text) → {url} (trimmed, no trailing slash) | {empty: true} | {problem}
//   `problem` is 'not-url' | 'plain-http' | 'scheme'.
export function urlRule(text) {
  const value = String(text || '').trim().replace(/\/+$/, '');
  if (!value) return { empty: true };
  let parsed;
  try { parsed = new URL(value); } catch { return { problem: 'not-url' }; }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol === 'https:') return { url: value };
  if (parsed.protocol === 'http:' && local) return { url: value };
  if (parsed.protocol === 'http:') return { problem: 'plain-http' };
  return { problem: 'scheme' };
}

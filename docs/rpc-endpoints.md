# Standing up an RPC endpoint

What a node operator has to run for `https://rpc1.randprotocol.org` (or `rpc2`, or `rpc3`) to be
something the wallets can use. This page is written to be followed once per host, with nothing
shared between them but the DNS zone.

The DNS records and the machines themselves are infrastructure and live outside this repository:
the fleet is on DigitalOcean, and `randprotocol.org`'s DNS is on Cloudflare. **One public
endpoint exists today: `https://rpc.randprotocol.org`** (live since 2026-09-21 — CORS-open,
chain 14), and it is the clients' default. `rpc1`/`rpc2`/`rpc3` do not resolve yet; the wallet
skips whatever does not answer, and its default set grows to include them in a release once they
are up — see "Why three" below.

## What is behind the proxy

`rand-node` binds JSON-RPC to `127.0.0.1:8545` and has no TLS, no CORS and no rate limiting of its
own. It is not a public server and must never be bound to a public interface; everything below is
about the reverse proxy that makes one safe to expose.

**Front a full node or an observer, never a validator.** A validator that is busy answering
`rand_getCommitments` for a few thousand wallets is a validator that is late with a block, and a
validator's RPC port is a denial-of-service surface aimed at consensus. Run the public endpoint on
a separate machine that follows the chain, and let the validators peer with it rather than with the
internet.

Each of the three endpoints should be a **different machine in a different failure domain** —
different droplet, ideally a different region. Three proxies in front of one node is not failover;
it is one node with three names.

## The Caddy recipe

```
rpc1.randprotocol.org {
	# --- what may be asked at all -------------------------------------------------
	# JSON-RPC is POST. Anything else is a crawler, a browser guessing, or a probe.
	@rpc {
		method POST
		path /
	}
	@preflight method OPTIONS

	# --- CORS ---------------------------------------------------------------------
	# The wallets are a browser extension, a Tauri webview and a web page, so their
	# origins are `chrome-extension://…`, `tauri://localhost` and a real https origin.
	# There is no useful allow-list across those, and nothing here is authenticated by
	# a cookie or a header, so `*` is honest rather than lax: the endpoint serves
	# public chain data to anyone who asks.
	header {
		Access-Control-Allow-Origin *
		Access-Control-Allow-Headers content-type
		Access-Control-Allow-Methods "POST, OPTIONS"
		Access-Control-Max-Age 86400
		-Server
	}
	respond @preflight 204

	# --- limits -------------------------------------------------------------------
	# A JSON-RPC request from a wallet is at most a few kB; the largest is a submitted
	# transaction. 256 kB is generous and still refuses a body designed to make the
	# node allocate.
	request_body {
		max_size 256KB
	}

	reverse_proxy @rpc 127.0.0.1:8545 {
		# A scan pages the tree; a submit waits for nothing. Neither is slow.
		transport http {
			read_timeout 30s
			write_timeout 30s
		}
	}

	# Everything that is not a POST to / gets nothing, including a body.
	respond 404
}
```

`request_body max_size` is a hard refusal, not a truncation: an oversized body gets a 413 and the
node never sees it. `-Server` drops the header that names the proxy; it is not a security control,
it just does not volunteer the version of the thing an attacker would be writing an exploit for.

### Rate limits

Caddy's rate limiter is a plugin — build the binary with it:

```bash
xcaddy build --with github.com/mholt/caddy-ratelimit
```

and then, inside the site block, two separate buckets:

```
	rate_limit {
		# Reads: a wallet scanning from scratch pages the tree hard for a few seconds,
		# so this has to be loose enough not to break a first sync on a fast link.
		zone reads {
			key {remote_host}
			events 600
			window 1m
		}
	}

	# The faucet is the one method that costs the CHAIN something, so it gets its own,
	# much tighter bucket — see below.
	@mint {
		method POST
		header Content-Type application/json
		expression {http.request.body}.contains("rand_mint")
	}
	rate_limit @mint {
		zone mint {
			key {remote_host}
			events 3
			window 1h
		}
	}
```

`{remote_host}` is the proxy's view of the client. Behind Cloudflare that is Cloudflare, not the
user, so set `trusted_proxies` for Cloudflare's ranges and key on the forwarded address instead —
otherwise every wallet in the world shares one bucket and the first busy minute locks everyone out.

## `rand_mint` through the public proxy

**Owner's decision, 2026-09-20: the faucet stays reachable through the public endpoints for now.**
A testnet wallet that cannot get its first RAND is a wallet nobody can try, and the alternative
(a separate faucet host, or a captcha) is work that has not been done.

So the recipe above allows `rand_mint`, with the much tighter per-IP bucket shown: a handful an
hour, against several hundred reads a minute. That limit is on top of, not instead of, the node's
own faucet cap (`FAUCET_MAX_UNITS`, and whatever per-address rule the node enforces) — the proxy
limit exists to stop one IP from spending the node's time, not to decide who gets tokens.

**To block it later**, when the faucet moves behind something else, it is one matcher. Replace the
`rate_limit @mint` block with:

```
	respond @mint 403 {
		body "the faucet has moved; see https://randprotocol.org/clients"
		close
	}
```

and the wallets' Faucet button starts reporting the node's refusal verbatim, which is what it does
with every other JSON-RPC error. Nothing in the clients has to change, and nothing has to be
re-released.

Note the matcher reads the request body to find the method name, because JSON-RPC puts the method
in the body rather than in the path. That is cheap here only because the body is already capped at
256 kB — do not remove `request_body max_size` and leave this matcher in place.

## Checking it

```bash
# It answers, and says which chain it is.
curl -sS https://rpc1.randprotocol.org \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"rand_chainId","params":[]}'

# CORS, as a browser would ask.
curl -sSi -X OPTIONS https://rpc1.randprotocol.org \
  -H 'Origin: https://randprotocol.org' \
  -H 'Access-Control-Request-Method: POST'

# GET is not JSON-RPC.
curl -sSo /dev/null -w '%{http_code}\n' https://rpc1.randprotocol.org
```

The wallets ask two more questions of an endpoint before they use it — `rand_chainId` and
`rand_getGenesisHash` — and refuse one that will not answer both, or that answers with a chain
other than the one the wallet was built for. An endpoint proxying a node that is still syncing from
genesis will answer both correctly and simply be behind; the wallets say so ("this node's tip is
below what this wallet has read") rather than treating it as a wrong chain.

## Why three

`ui/engine/rpc.js` takes a list of endpoints. It tries them in order from the last one that worked,
and moves to the next on a transport failure — unreachable, timed out, HTTP 5xx, a body that is not
JSON-RPC. Two things it deliberately does **not** do:

* **A JSON-RPC error reply is an answer.** It is never repeated on another endpoint. A wallet that
  asked a second node whatever the first one had just refused would be shopping for the reply it
  liked.
* **A submission is never repeated after a timeout.** `rand_sendTransaction` and `rand_mint` move
  to another endpoint only when the failure proves nothing was sent (connection refused, DNS, TLS).
  A timed-out submit may have landed on the node that received it, and resending it elsewhere is
  how a wallet sends the same transfer twice.

Failover happens **between** operations, never inside one: a scan or a send is pinned to the one
endpoint its chain check passed, and an endpoint that dies mid-operation makes that operation fail
rather than silently continue somewhere unverified. The next operation picks a different endpoint —
and that endpoint has to name the expected chain before it is used for anything at all.

The practical consequence for an operator: **taking one endpoint down is uneventful, and taking one
down badly is not.** A host that refuses connections, or returns 502, is skipped in milliseconds. A
host that accepts connections and then hangs costs every wallet its request timeout (20 s) before it
moves on. When retiring an endpoint, stop the proxy or return 502 — do not blackhole the port.

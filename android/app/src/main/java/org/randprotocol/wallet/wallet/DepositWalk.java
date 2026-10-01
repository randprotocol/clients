package org.randprotocol.wallet.wallet;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.randprotocol.wallet.core.CoreException;
import org.randprotocol.wallet.rpc.RpcException;

/**
 * The search for bridge deposits in blocks not read yet, by header.
 *
 * A deposit is rebuilt from the {@code bridge_attest} action that created it, and the only way to
 * find one is to look in the blocks. One {@code rand_getBlockByHeight} per height did that for a
 * short chain; at a block a second it is a hundred thousand calls for a first scan, and the public
 * endpoint refuses after about a hundred. {@code rand_getBlocks(from, to)} answers up to 1024
 * headers a call, each with a {@code tx_count}, and only a block that carries a transaction can
 * carry an attestation: on the chain this was measured on (2026-09-30: 100 352 blocks, 534 with a
 * transaction) that is 98 + 534 requests instead of 100 352.
 *
 * The rules are {@code ui/engine/wallet.js}'s {@code depositsByHeader}, to the letter:
 * <ul>
 *   <li>{@link Result#through} is the last height this wallet asked for, was answered about and
 *       checked — a header that says "empty", or a block that was opened. It never moves over a
 *       header page that is not the answer to its request (one that starts late, skips a height or
 *       runs past the range), nor past a busy block that was not opened.</li>
 *   <li>What the node will not serve stops the walk where it stopped and is reported as
 *       {@link Result#unknown}; it does not fail the scan. The notes and the spends are most of a
 *       wallet, and one refused block read used to cost all of them.</li>
 *   <li>One scan spends at most {@link #MAX_REQUESTS} requests here, header pages and opened
 *       blocks together; a longer gap is closed over several scans.</li>
 *   <li>A node with no {@code rand_getBlocks} is read one block at a time, at most
 *       {@link #MAX_HEIGHTS_WITHOUT_HEADERS} a scan.</li>
 * </ul>
 * The core refusing an action it was handed is this wallet's own failure and is thrown, not
 * reported as unknown.
 */
final class DepositWalk {
    /** Headers asked of one {@code rand_getBlocks} call: the node's own cap. */
    static final int HEADER_PAGE = 1024;
    /** Requests one scan may spend looking for deposits. */
    static final int MAX_REQUESTS = 96;
    /** Blocks one scan may open on a node that has no {@code rand_getBlocks}. */
    static final int MAX_HEIGHTS_WITHOUT_HEADERS = 512;

    /** The two reads the walk makes. */
    interface Node {
        JSONArray headers(long from, long to) throws RpcException;

        /** The block at {@code height}, or null where the node has none. */
        JSONObject block(long height) throws RpcException;
    }

    /** Where each {@code bridge_attest} action found goes. */
    interface Sink {
        void offer(JSONObject action) throws CoreException, JSONException;
    }

    static final class Result {
        /** The last height examined; {@code start - 1} when nothing was. */
        final long through;
        /** The node could not, or would not, answer for everything up to the tip. */
        final boolean unknown;

        Result(long through, boolean unknown) {
            this.through = through;
            this.unknown = unknown;
        }
    }

    private DepositWalk() {
    }

    static Result run(Node node, long start, long head, Sink sink) throws CoreException, JSONException {
        long examined = start - 1;
        int budget = MAX_REQUESTS;
        while (examined < head && budget > 0) {
            long from = examined + 1;
            long to = Math.min(head, from + HEADER_PAGE - 1);
            long[] counts;
            try {
                counts = checkedHeaders(node.headers(from, to), from, to);
            } catch (RpcException e) {
                // "No such method" as the very first answer is a node that predates it.
                if (e.code == -32601 && budget == MAX_REQUESTS) return oneByOne(node, start, head, sink);
                return new Result(examined, true);
            }
            budget--;
            // The node named a tip at or above `from` and then had no header for it.
            if (counts.length == 0) return new Result(examined, true);
            for (int i = 0; i < counts.length; i++) {
                long height = from + i;
                if (counts[i] > 0) {
                    if (budget <= 0) return new Result(examined, false); // enough for one scan
                    budget--;
                    JSONObject block;
                    try {
                        block = node.block(height);
                    } catch (RpcException e) {
                        return new Result(examined, true);
                    }
                    offerAttests(block, sink);
                }
                examined = height;
            }
            if (counts.length < to - from + 1) break; // the node's own tip is below the one it named
        }
        return new Result(examined, false);
    }

    /** One call per height, for a node without {@code rand_getBlocks}; a failure here is the scan's. */
    private static Result oneByOne(Node node, long start, long head, Sink sink) throws CoreException, JSONException {
        long last = Math.min(head, start + MAX_HEIGHTS_WITHOUT_HEADERS - 1);
        long examined = start - 1;
        for (long h = start; h <= last; h++) {
            JSONObject block;
            try {
                block = node.block(h);
            } catch (RpcException e) {
                return new Result(examined, true);
            }
            offerAttests(block, sink);
            examined = h;
        }
        return new Result(examined, false);
    }

    /**
     * A header page as {@code tx_count}s, index {@code i} being block {@code from + i} — or an
     * {@link RpcException} when the reply is not the answer to this request: an honest one is a
     * contiguous run from exactly {@code from} that never passes {@code to} (it may be shorter; the
     * node's tip is its own).
     */
    static long[] checkedHeaders(JSONArray rows, long from, long to) throws RpcException {
        if (rows == null) throw new RpcException(0, "rand_getBlocks: the reply is not a list");
        if (rows.length() > to - from + 1) {
            throw new RpcException(0, "rand_getBlocks: " + rows.length() + " headers for a range of " + (to - from + 1));
        }
        long[] counts = new long[rows.length()];
        for (int i = 0; i < counts.length; i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) throw new RpcException(0, "rand_getBlocks: header " + i + " is not an object");
            long height = wholeNumber(row, "height", i);
            if (height != from + i) {
                throw new RpcException(0, "rand_getBlocks: header " + i + " is block " + height + ", not the " + (from + i) + " the range calls for");
            }
            counts[i] = wholeNumber(row, "tx_count", i);
        }
        return counts;
    }

    /** A non-negative integer field, accepted as a JSON integer only. */
    private static long wholeNumber(JSONObject row, String name, int i) throws RpcException {
        Object v = row.opt(name);
        if (v instanceof Integer || v instanceof Long) {
            long n = ((Number) v).longValue();
            if (n >= 0) return n;
        }
        throw new RpcException(0, "rand_getBlocks: header " + i + " " + name + " is not a non-negative integer");
    }

    private static void offerAttests(JSONObject block, Sink sink) throws CoreException, JSONException {
        if (block == null) return;
        JSONArray txs = block.optJSONArray("transactions");
        if (txs == null) return;
        for (int i = 0; i < txs.length(); i++) {
            JSONObject tx = txs.optJSONObject(i);
            JSONObject action = tx == null ? null : tx.optJSONObject("action");
            // A deposit, and (for a chain's bridge fee recipient, which the sink decides) a burn,
            // whose fee note carries no envelope and is found only by rebuilding it.
            String kind = action == null ? "" : action.optString("kind");
            if (!"bridge_attest".equals(kind) && !"bridge_burn".equals(kind)) continue;
            sink.offer(action);
        }
    }
}

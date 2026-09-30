package org.randprotocol.wallet.wallet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import org.randprotocol.wallet.rpc.RpcException;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The search for bridge deposits, by header ({@code ui/engine/wallet.js}'s {@code depositsByHeader},
 * and its tests in {@code ui/test/engine-wallet.test.mjs}, are the same rules in JavaScript).
 *
 * One {@code rand_getBlockByHeight} per height from zero was a hundred thousand calls for a first
 * scan on a chain that makes a block a second, and the public endpoint refuses after about a
 * hundred: a new wallet never finished its first scan.
 */
public class DepositWalkTest {

    /** A node of {@code head} blocks; {@code busy} are the heights with a transaction in them. */
    private static class Node implements DepositWalk.Node {
        final long head;
        final Set<Long> busy;
        final List<long[]> pages = new ArrayList<>();
        final List<Long> opened = new ArrayList<>();

        Node(long head, Long... busy) {
            this.head = head;
            this.busy = new HashSet<>(Arrays.asList(busy));
        }

        @Override
        public JSONArray headers(long from, long to) throws RpcException {
            pages.add(new long[] {from, to});
            JSONArray rows = new JSONArray();
            try {
                for (long h = from; h <= Math.min(to, head); h++) {
                    rows.put(new JSONObject().put("height", h).put("tx_count", busy.contains(h) ? 1 : 0));
                }
            } catch (JSONException e) {
                throw new AssertionError(e);
            }
            return rows;
        }

        @Override
        public JSONObject block(long height) throws RpcException {
            opened.add(height);
            try {
                JSONObject action = new JSONObject().put("kind", "bridge_attest").put("at", height);
                return new JSONObject().put("height", height)
                        .put("transactions", new JSONArray().put(new JSONObject().put("action", action)));
            } catch (JSONException e) {
                throw new AssertionError(e);
            }
        }
    }

    private static List<Long> offered(DepositWalk.Node node, long start, long head, DepositWalk.Result[] out) throws Exception {
        List<Long> seen = new ArrayList<>();
        out[0] = DepositWalk.run(node, start, head, action -> seen.add(action.getLong("at")));
        return seen;
    }

    @Test
    public void itWalksTheHeadersAndOpensOnlyTheBlocksThatCarryATransaction() throws Exception {
        Node node = new Node(5000, 7L, 2000L);
        DepositWalk.Result[] r = new DepositWalk.Result[1];
        List<Long> seen = offered(node, 0, 5000, r);

        assertEquals(Arrays.asList(7L, 2000L), node.opened);
        assertEquals(Arrays.asList(7L, 2000L), seen);
        assertEquals(5, node.pages.size());
        assertEquals(0, node.pages.get(0)[0]);
        assertEquals(1023, node.pages.get(0)[1]);
        assertEquals(4096, node.pages.get(4)[0]);
        assertEquals(5000, node.pages.get(4)[1]);
        assertEquals(5000, r[0].through);
        assertFalse(r[0].unknown);
    }

    @Test
    public void nothingToReadIsNothingAsked() throws Exception {
        Node node = new Node(100);
        DepositWalk.Result r = DepositWalk.run(node, 101, 100, action -> { });
        assertEquals(100, r.through);
        assertTrue(node.pages.isEmpty());
    }

    @Test
    public void theWalkIsBudgetedInRequestsAndTheNextOneResumesWhereItStopped() throws Exception {
        long head = 400_000;
        Node node = new Node(head, 5L, 6L);
        DepositWalk.Result r = DepositWalk.run(node, 0, head, action -> { });
        int spent = node.pages.size() + node.opened.size();
        assertTrue(spent + " requests in one scan", spent <= DepositWalk.MAX_REQUESTS);
        assertTrue(spent >= 64);
        assertEquals(node.pages.get(node.pages.size() - 1)[1], r.through);
        assertTrue(r.through < head);
        assertFalse("a spent budget is not an unknown bridge", r.unknown);

        Node again = new Node(head, 5L, 6L);
        DepositWalk.run(again, r.through + 1, head, action -> { });
        assertEquals(r.through + 1, again.pages.get(0)[0]);
    }

    @Test
    public void aBudgetSpentMidPageStopsAtTheLastBlockOpenedNotThePageEnd() throws Exception {
        Long[] busy = new Long[300];
        for (int i = 0; i < 300; i++) busy[i] = 100L + i;
        Node node = new Node(3000, busy);
        DepositWalk.Result r = DepositWalk.run(node, 0, 3000, action -> { });
        long last = node.opened.get(node.opened.size() - 1);
        assertEquals("the cursor moved over a busy block that was never opened", last, r.through);
        assertTrue(last < 399);
    }

    /** A node that answers the header page with whatever {@code forge} makes of the honest one. */
    private interface Forge {
        Object of(JSONArray honest) throws JSONException;
    }

    private static DepositWalk.Result forged(Forge forge) throws Exception {
        Node honest = new Node(50);
        DepositWalk.Node node = new DepositWalk.Node() {
            @Override
            public JSONArray headers(long from, long to) throws RpcException {
                try {
                    Object made = forge.of(honest.headers(from, to));
                    if (!(made instanceof JSONArray)) throw new RpcException(0, "rand_getBlocks: not a list");
                    return (JSONArray) made;
                } catch (JSONException e) {
                    throw new AssertionError(e);
                }
            }

            @Override
            public JSONObject block(long height) {
                throw new AssertionError("no block should be opened");
            }
        };
        return DepositWalk.run(node, 0, 50, action -> { });
    }

    @Test
    public void aHeaderPageThatIsNotTheAnswerToTheRequestMovesNothing() throws Exception {
        Forge[] forges = {
            rows -> { rows.remove(0); return rows; },                                   // starts late
            rows -> { rows.remove(10); return rows; },                                  // has a gap
            rows -> rows.put(new JSONObject().put("height", 51).put("tx_count", 0)),    // runs past the range
            rows -> { for (int i = 0; i < rows.length(); i++) rows.getJSONObject(i).remove("tx_count"); return rows; },
            rows -> { rows.getJSONObject(3).put("tx_count", -1); return rows; },
            rows -> { rows.put(3, "header"); return rows; },
            rows -> new JSONArray(),                                                    // a tip with no header
        };
        for (int i = 0; i < forges.length; i++) {
            DepositWalk.Result r = forged(forges[i]);
            assertEquals("forgery " + i + " moved the cursor", -1, r.through);
            assertTrue("forgery " + i + " was not reported", r.unknown);
        }
    }

    @Test
    public void aBlockTheNodeWillNotOpenStopsTheWalkThereAndKeepsWhatWasFound() throws Exception {
        Node honest = new Node(3000, 7L, 2000L);
        DepositWalk.Node node = new DepositWalk.Node() {
            @Override
            public JSONArray headers(long from, long to) throws RpcException {
                return honest.headers(from, to);
            }

            @Override
            public JSONObject block(long height) throws RpcException {
                if (height == 2000) throw new RpcException(0, "HTTP 429 from the node");
                return honest.block(height);
            }
        };
        DepositWalk.Result[] r = new DepositWalk.Result[1];
        List<Long> seen = offered(node, 0, 3000, r);
        assertEquals(Arrays.asList(7L), seen);
        assertEquals(1999, r[0].through);
        assertTrue(r[0].unknown);
    }

    @Test
    public void aNodeWithNoGetBlocksIsReadOneBlockAtATimeAndCapped() throws Exception {
        Node honest = new Node(5000);
        DepositWalk.Node node = new DepositWalk.Node() {
            @Override
            public JSONArray headers(long from, long to) throws RpcException {
                throw new RpcException(-32601, "unknown method rand_getBlocks");
            }

            @Override
            public JSONObject block(long height) throws RpcException {
                return honest.block(height);
            }
        };
        DepositWalk.Result r = DepositWalk.run(node, 0, 5000, action -> { });
        assertEquals(DepositWalk.MAX_HEIGHTS_WITHOUT_HEADERS, honest.opened.size());
        assertEquals(DepositWalk.MAX_HEIGHTS_WITHOUT_HEADERS - 1, r.through);
        assertFalse(r.unknown);
    }

    @Test
    public void anActionThatIsNotABridgeAttestIsNotOffered() throws Exception {
        DepositWalk.Node node = new DepositWalk.Node() {
            @Override
            public JSONArray headers(long from, long to) throws RpcException {
                return new Node(3, 2L).headers(from, to);
            }

            @Override
            public JSONObject block(long height) throws RpcException {
                try {
                    return new JSONObject().put("transactions", new JSONArray()
                            .put(new JSONObject().put("action", new JSONObject().put("kind", "bundle")))
                            .put(new JSONObject())
                            .put(new JSONObject().put("action", new JSONObject().put("kind", "bridge_attest").put("at", 2))));
                } catch (JSONException e) {
                    throw new AssertionError(e);
                }
            }
        };
        DepositWalk.Result[] r = new DepositWalk.Result[1];
        assertEquals(Arrays.asList(2L), offered(node, 0, 3, r));
        assertEquals(3, r[0].through);
    }
}

package org.randprotocol.wallet.rpc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;

/**
 * HTTP 429 is "ask again later" ({@code ui/engine/rpc.js}'s {@code THROTTLE_WAITS_MS} is the same
 * rule): a read is repeated after a wait, a submission never is, and the waiting is bounded.
 */
public class RpcClientThrottleTest {

    /** A client whose wire is a script of replies and whose waits are recorded, not slept. */
    private static class Scripted extends RpcClient {
        final Deque<Reply> replies = new ArrayDeque<>();
        final List<Long> waits = new ArrayList<>();
        int sent = 0;
        Reply last;

        Scripted(Reply... script) {
            super("https://node.example");
            replies.addAll(Arrays.asList(script));
        }

        @Override
        protected Reply transport(String json) {
            sent++;
            if (!replies.isEmpty()) last = replies.poll();
            return last;
        }

        @Override
        protected void pause(long ms) {
            waits.add(ms);
        }
    }

    private static RpcClient.Reply ok(String result) {
        return new RpcClient.Reply(200, "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":" + result + "}", null);
    }

    private static RpcClient.Reply busy() {
        return new RpcClient.Reply(429, "<html>429 Too Many Requests</html>", null);
    }

    @Test
    public void aThrottledReadIsRepeatedAfterAWait() throws Exception {
        Scripted rpc = new Scripted(busy(), busy(), ok("{\"height\":7}"));
        assertEquals(7, rpc.headHeight());
        assertEquals(3, rpc.sent);
        assertEquals(Arrays.asList(1000L, 2000L), rpc.waits);
    }

    @Test
    public void aNodesOwnJsonRefusalWith429IsWaitedOutToo() throws Exception {
        RpcClient.Reply slowDown = new RpcClient.Reply(429, "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32005,\"message\":\"rate limit: slow down\"}}", null);
        Scripted rpc = new Scripted(slowDown, ok("{\"height\":9}"));
        assertEquals(9, rpc.headHeight());
        assertEquals(Arrays.asList(1000L), rpc.waits);
    }

    @Test
    public void theWaitingIsBounded() {
        Scripted rpc = new Scripted(busy());
        try {
            rpc.headHeight();
            fail("an endpoint that only says 429 was waited on for ever");
        } catch (RpcException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("HTTP 429"));
            assertEquals(429, e.httpStatus);
        }
        assertEquals(rpc.waits.size() + 1, rpc.sent);
        long total = 0;
        long longest = 0;
        for (long w : rpc.waits) {
            total += w;
            longest = Math.max(longest, w);
        }
        assertTrue(total + " ms", total >= 30_000 && total <= 90_000);
        assertTrue(longest <= 8000);
    }

    @Test
    public void aSubmissionIsNeverRepeated() {
        for (String method : new String[] {"rand_sendTransaction", "rand_mint"}) {
            Scripted rpc = new Scripted(busy());
            try {
                rpc.call(method, null);
                fail(method + " was retried");
            } catch (RpcException e) {
                assertEquals(429, e.httpStatus);
            }
            assertEquals(method, 1, rpc.sent);
            assertTrue(rpc.waits.isEmpty());
        }
    }

    @Test
    public void aFaucetRefusalKeepsTheNodesOwnWords() {
        RpcClient.Reply slowDown = new RpcClient.Reply(429, "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32005,\"message\":\"rate limit: slow down\"}}", null);
        Scripted rpc = new Scripted(slowDown);
        try {
            rpc.mint("rand1abc");
            fail();
        } catch (RpcException e) {
            assertEquals("rate limit: slow down", e.getMessage());
            assertEquals(-32005, e.code);
        }
    }

    @Test
    public void retryAfterIsTakenAtItsWordUpToTheLongestWait() throws Exception {
        Scripted rpc = new Scripted(
                new RpcClient.Reply(429, "", "3"),
                new RpcClient.Reply(429, "", "3600"),
                new RpcClient.Reply(429, "", "soon"),
                ok("{\"height\":1}"));
        assertEquals(1, rpc.headHeight());
        assertEquals(Arrays.asList(3000L, 8000L, 4000L), rpc.waits);
    }

    @Test
    public void anyOtherStatusIsReportedAtOnce() {
        Scripted rpc = new Scripted(new RpcClient.Reply(503, "<html>bad gateway</html>", null));
        try {
            rpc.headHeight();
            fail();
        } catch (RpcException e) {
            assertEquals(503, e.httpStatus);
        }
        assertEquals(1, rpc.sent);
    }
}

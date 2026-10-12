package org.randprotocol.wallet.wallet;

import org.json.JSONArray;
import org.json.JSONObject;
import org.randprotocol.wallet.R;
import org.randprotocol.wallet.rpc.RpcClient;
import org.randprotocol.wallet.security.SignerProfiles;
import org.randprotocol.wallet.util.L10n;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CancellationException;

/**
 * Private multisig signing (spec docs/superpowers/specs/2026-10-11-msauth-signing-design.md §3, §4):
 * the rules every app shares ({@link #judge}, the same decisions in the same order as
 * ui/engine/signers.js {@code verdict} and iOS {@code MsauthRules.verdict}, iOS's where it is the
 * stricter) and the order a signature is made in ({@link #sign}, iOS {@code MsauthSigning}).
 *
 * <p>The rules are pure and JVM-tested. A field the rule reads that is missing or of the wrong JSON
 * type refuses ({@link Verdict#MALFORMED_SUMMARY}): nothing here is a reason to sign.
 */
public final class SignFlow {
    /** Blocks a proposal needs before its window closes: the CLI's {@code EXPIRY_MARGIN} (fullnode d5b2e652). */
    public static final long EXPIRY_MARGIN = 16;
    /** JavaScript's {@code Number.MAX_SAFE_INTEGER}, the bound the web's rule applies to every number it reads. */
    public static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;

    public enum Verdict { SIGNABLE, MALFORMED_SUMMARY, UNCHECKED_RECIPIENT, NO_NODE, WRONG_CHAIN, WRONG_GENESIS, EXPIRED }

    /** A verdict and what its sentence names. */
    public static final class Judgement {
        public final Verdict verdict;
        /** The node's head, null when no node answered. */
        public final Long head;
        public final long expiresAt;
        public final long proposalChain;
        public final long walletChain;
        /** The node asked ({@code ""} when none is configured). */
        public final String url;
        /** {@code expires_at - head} when signable, else 0. */
        public final long blocksLeft;

        private Judgement(Verdict verdict, Long head, long expiresAt, long proposalChain, long walletChain, String url) {
            this.verdict = verdict;
            this.head = head;
            this.expiresAt = expiresAt;
            this.proposalChain = proposalChain;
            this.walletChain = walletChain;
            this.url = url == null ? "" : url;
            this.blocksLeft = verdict == Verdict.SIGNABLE ? expiresAt - head : 0;
        }

        static Judgement of(Verdict v, String url) {
            return new Judgement(v, null, 0, 0, 0, url);
        }

        public boolean signable() {
            return verdict == Verdict.SIGNABLE;
        }

        /** The refusal in the user's language (the web's English); null when signable. */
        public String message() {
            switch (verdict) {
                case MALFORMED_SUMMARY:
                    return L10n.t(R.string.msauth_refuse_malformed, "The proposal check returned an incomplete answer, so this proposal is not signed.");
                case UNCHECKED_RECIPIENT:
                    return L10n.t(R.string.msauth_refuse_unchecked, "Enter the address of every payee: an output that does not match the address you entered, or whose address is empty, cannot be signed.");
                case NO_NODE:
                    return L10n.t(R.string.msauth_refuse_no_node, "No node answered at %1$s, so the expiry cannot be checked and this proposal is not signed. Retry when the node is reachable.",
                            url.isEmpty() ? "—" : url);
                case WRONG_CHAIN:
                    return L10n.t(R.string.msauth_refuse_wrong_chain, "This proposal is for chain %1$s; this wallet is on chain %2$s.",
                            String.valueOf(proposalChain), String.valueOf(walletChain));
                case WRONG_GENESIS:
                    return L10n.t(R.string.msauth_refuse_wrong_genesis, "This proposal is bound to another genesis than the one this wallet's node serves.");
                case EXPIRED:
                    return L10n.t(R.string.msauth_refuse_expired, "This proposal expires at height %1$s and the chain is at %2$s: too late to sign. Ask for a new proposal.",
                            String.valueOf(expiresAt), String.valueOf(head));
                default:
                    return null;
            }
        }
    }

    /** A proposal that may not be signed: the judgement that refused it. */
    public static final class Refusal extends Exception {
        public final Judgement judgement;

        Refusal(Judgement judgement) {
            super(judgement.message());
            this.judgement = judgement;
        }
    }

    // ------------------------------------------------------------------ the rule

    /** {@link #judge}'s verdict alone. */
    public static Verdict verdict(Object summary, Long head, long chainId, String genesis, List<String> recipients) {
        return judge(summary, head, chainId, genesis, "", recipients).verdict;
    }

    /**
     * Whether a checked proposal may be signed now, on this wallet's chain. {@code summary} is
     * {@code msauth_check}'s reply, {@code recipients} the list the check was given ({@link
     * #payees}), {@code head} null when no node answered, {@code url} the node asked.
     */
    public static Judgement judge(Object summary, Long head, long chainId, String genesis, String url, List<String> recipients) {
        if (!(summary instanceof JSONObject)) return Judgement.of(Verdict.MALFORMED_SUMMARY, url);
        JSONObject s = (JSONObject) summary;
        Judgement unchecked = Judgement.of(Verdict.UNCHECKED_RECIPIENT, url);
        Judgement malformed = Judgement.of(Verdict.MALFORMED_SUMMARY, url);
        // Never sign on an unchecked payee (a coordinator could pay its own key).
        if (!Boolean.TRUE.equals(strictBool(s.opt("recipients_checked")))) return unchecked;
        List<String> rec = recipients == null ? Collections.emptyList() : recipients;
        for (String r : rec) if (isBlank(r)) return unchecked;
        Object outsV = s.opt("outputs");
        if (!(outsV instanceof JSONArray)) return malformed;
        JSONArray outs = (JSONArray) outsV;
        List<JSONObject> paying = new ArrayList<>();
        for (int i = 0; i < outs.length(); i++) {
            Object item = outs.opt(i);
            if (!(item instanceof JSONObject)) return malformed;
            JSONObject o = (JSONObject) item;
            Boolean toAccount = strictBool(o.opt("to_account"));
            Object amount = o.opt("amount");
            if (toAccount == null || !amountOk(amount)) return malformed;
            if (!toAccount && !isZeroAmount(amount)) paying.add(o);
        }
        // No intended payment named at all while something pays out: unchecked, whatever the core said.
        if (rec.isEmpty() && !paying.isEmpty()) return unchecked;
        // An amount is pinned on every entry, except an entry whose own owner fingerprint owns a
        // paying non-RAND output (the core refuses a pin there). Per row: one small non-RAND output
        // cannot unpin the RAND rows.
        List<String> amountless = new ArrayList<>();
        for (String r : rec) if (isAmountless(r)) amountless.add(r);
        if (!amountless.isEmpty()) {
            Object expV = s.opt("expected");
            if (!(expV instanceof JSONArray)) return unchecked;
            JSONArray exp = (JSONArray) expV;
            Set<String> tokenOwners = new HashSet<>();
            for (JSONObject o : paying) {
                Long asset = assetId(o.opt("asset"));
                Object fp = o.opt("owner_fingerprint");
                if (asset != null && asset != 0 && fp instanceof String && !((String) fp).isEmpty()) tokenOwners.add((String) fp);
            }
            for (String entry : amountless) {
                boolean allowed = false;
                for (int i = 0; i < exp.length() && !allowed; i++) {
                    Object item = exp.opt(i);
                    if (!(item instanceof JSONObject)) continue;
                    JSONObject x = (JSONObject) item;
                    Object e = x.opt("entry");
                    Object fp = x.opt("fingerprint");
                    allowed = e instanceof String && e.equals(entry) && fp instanceof String && !((String) fp).isEmpty() && tokenOwners.contains(fp);
                }
                if (!allowed) return unchecked;
            }
        }
        for (JSONObject o : paying) {
            Object m = o.opt("matches");
            if (!(m instanceof String) || jsTrim((String) m).isEmpty()) return unchecked;
        }
        Long expiresAt = uint(s.opt("expires_at"));
        Long proposalChain = uint(s.opt("chain_id"));
        Long domain = uint(s.opt("binding_domain"));
        Object g = s.opt("genesis");
        if (expiresAt == null || proposalChain == null || domain == null || !(g instanceof String) || !isHex((String) g)) return malformed;
        if (head == null || head < 0 || head > MAX_SAFE_INTEGER) return Judgement.of(Verdict.NO_NODE, url);
        if (proposalChain != chainId) return new Judgement(Verdict.WRONG_CHAIN, head, expiresAt, proposalChain, chainId, url);
        String ours = genesis == null ? "" : genesis.toLowerCase(Locale.ROOT);
        if (domain >= 1 && !((String) g).toLowerCase(Locale.ROOT).equals(ours)) {
            return new Judgement(Verdict.WRONG_GENESIS, head, expiresAt, proposalChain, chainId, url);
        }
        // head + 16 >= expires_at, written so it cannot overflow.
        if (head >= expiresAt || expiresAt - head <= EXPIRY_MARGIN) {
            return new Judgement(Verdict.EXPIRED, head, expiresAt, proposalChain, chainId, url);
        }
        return new Judgement(Verdict.SIGNABLE, head, expiresAt, proposalChain, chainId, url);
    }

    /** The fingerprint's last four characters, typed: case, dashes and surrounding spaces ignored. */
    public static boolean confirms(String fingerprint, String typed) {
        String fp = fingerprint == null ? "" : fingerprint.replace("-", "");
        if (fp.length() < 4 || typed == null) return false;
        String want = fp.substring(fp.length() - 4).toLowerCase(Locale.ROOT);
        return jsTrim(typed.replace("-", "")).toLowerCase(Locale.ROOT).equals(want);
    }

    /** A pasted or opened file: a leading byte-order mark dropped, whitespace trimmed. */
    public static String clean(String s) {
        String t = s == null ? "" : s;
        if (t.startsWith("\uFEFF")) t = t.substring(1);
        return jsTrim(t);
    }

    /** The intended payments as the core is given them: each entry cleaned, none dropped. */
    public static List<String> payees(List<String> list) {
        List<String> out = new ArrayList<>();
        if (list != null) for (String e : list) out.add(clean(e));
        return out;
    }

    /** An entry that is empty or has no address before its amount. */
    public static boolean isBlank(String entry) {
        String t = clean(entry);
        return t.isEmpty() || t.startsWith(":");
    }

    /** An entry without an amount: no {@code :}, or nothing after the first one. */
    public static boolean isAmountless(String entry) {
        int i = entry.indexOf(':');
        return i < 0 || jsTrim(entry.substring(i + 1)).isEmpty();
    }

    /** fullnode's lines, verbatim — never translated. */
    public static List<String> lines(JSONObject s) {
        List<String> out = new ArrayList<>();
        JSONArray a = s == null ? null : s.optJSONArray("lines");
        for (int i = 0; a != null && i < a.length(); i++) {
            Object l = a.opt(i);
            if (l instanceof String) out.add((String) l);
        }
        return out;
    }

    // ---- reading the core's JSON strictly: a Boolean is a Boolean, a number a number

    private static Boolean strictBool(Object v) {
        return v instanceof Boolean ? (Boolean) v : null;
    }

    /** A non-negative safe integer: a JSON number (not a Boolean, not text), integral, 0..2^53-1. */
    static Long uint(Object v) {
        if (!(v instanceof Number)) return null;
        BigInteger b;
        if (v instanceof Integer || v instanceof Long || v instanceof Short || v instanceof Byte) {
            b = BigInteger.valueOf(((Number) v).longValue());
        } else if (v instanceof BigInteger) {
            b = (BigInteger) v;
        } else if (v instanceof BigDecimal) {
            try {
                b = ((BigDecimal) v).toBigIntegerExact();
            } catch (ArithmeticException e) {
                return null;
            }
        } else if (v instanceof Double || v instanceof Float) {
            double d = ((Number) v).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d) || d != Math.rint(d) || d < 0 || d > MAX_SAFE_INTEGER) return null;
            return (long) d;
        } else {
            return null;
        }
        if (b.signum() < 0 || b.compareTo(BigInteger.valueOf(MAX_SAFE_INTEGER)) > 0) return null;
        return b.longValue();
    }

    private static boolean digits(String t) {
        if (t.isEmpty()) return false;
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (c < '0' || c > '9') return false;
        }
        return true;
    }

    /** An amount: ASCII digits (whitespace around allowed), or a non-negative safe integer. */
    static boolean amountOk(Object v) {
        if (v instanceof String) return digits(jsTrim((String) v));
        return uint(v) != null;
    }

    /** Zero: {@code /^0+$/} after trimming, or the number 0. */
    public static boolean isZeroAmount(Object v) {
        if (v instanceof String) {
            String t = jsTrim((String) v);
            return digits(t) && t.chars().allMatch(c -> c == '0');
        }
        Long u = uint(v);
        return u != null && u == 0;
    }

    /** An asset id as the web reads it ({@code Number(o.asset)}): a number or a digit string; null otherwise. */
    public static Long assetId(Object v) {
        if (v instanceof String) {
            String t = jsTrim((String) v);
            if (!digits(t)) return null;
            BigInteger b = new BigInteger(t);
            return b.compareTo(BigInteger.valueOf(MAX_SAFE_INTEGER)) > 0 ? null : b.longValue();
        }
        return uint(v);
    }

    static boolean isHex(String s) {
        if (s.isEmpty()) return false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
        }
        return true;
    }

    /** JavaScript's {@code String.prototype.trim}: white space and line terminators, the BOM included. */
    public static String jsTrim(String s) {
        int a = 0, b = s.length();
        while (a < b && jsSpace(s.charAt(a))) a++;
        while (b > a && jsSpace(s.charAt(b - 1))) b--;
        return s.substring(a, b);
    }

    private static boolean jsSpace(char c) {
        if (c >= '\u001C' && c <= '\u001F') return false; // Java's whitespace, not JavaScript's
        return Character.isWhitespace(c) || Character.isSpaceChar(c) || c == '\uFEFF';
    }

    // ------------------------------------------------------------------ the order a signature is made in

    /** What signing asks of the node this wallet uses ({@link #node(RpcClient)}). */
    public interface Node {
        String url();

        long chainId() throws Exception;

        long headHeight() throws Exception;

        String genesisHash() throws Exception;
    }

    /**
     * {@code rand_getHead}'s height, read strictly: a non-negative integer ≤ 2^53-1, never a default.
     * Anything else (missing, null, text, a fraction) throws, which the flow judges as no node — a
     * height read as 0 would pass both the node check and the expiry margin.
     */
    public static long headHeightOf(Object head) {
        Long h = head instanceof JSONObject ? uint(((JSONObject) head).opt("height")) : null;
        if (h == null) throw new IllegalStateException("the node's head has no height");
        return h;
    }

    /** {@code rand_chainId}'s reply, read strictly as {@link #headHeightOf} reads a height. */
    public static long chainIdOf(Object reply) {
        Long c = uint(reply);
        if (c == null) throw new IllegalStateException("the node's chain id is not a chain id");
        return c;
    }

    public static Node node(RpcClient rpc) {
        return new Node() {
            @Override public String url() {
                return rpc.url();
            }

            // Not rpc.chainId() / rpc.headHeight(): those truncate a fraction and read a missing height as 0.
            @Override public long chainId() throws Exception {
                return chainIdOf(rpc.call("rand_chainId", null));
            }

            @Override public long headHeight() throws Exception {
                return headHeightOf(rpc.call("rand_getHead", null));
            }

            @Override public String genesisHash() throws Exception {
                return rpc.genesisHash();
            }
        };
    }

    /**
     * One authenticated read of a profile's seed (the system's prompt, then the decrypt:
     * {@link org.randprotocol.wallet.security.KeystoreSeedSource}). Returns a fresh buffer the flow
     * zeroes; blocks while the prompt is up, so call {@link #sign} off the main thread.
     */
    public interface SeedSource {
        byte[] seed(String id) throws Exception;
    }

    /** Whether the person left the screen: signing stops before the prompt and before the core signs. */
    public interface Cancel {
        boolean cancelled();
    }

    public static final class Check {
        /** null when the entries were refused before the core was asked. */
        public final JSONObject summary;
        public final Judgement judgement;

        Check(JSONObject summary, Judgement judgement) {
            this.summary = summary;
            this.judgement = judgement;
        }
    }

    public static final class Share {
        public final String share;
        public final int index;

        Share(String share, int index) {
            this.share = share;
            this.index = index;
        }
    }

    private final SignerProfiles profiles;
    private final MsauthCore core;
    private final Node node;
    private final long chainId;
    private final SeedSource seeds;

    /** {@code node} null is "no node": a proposal is checked and shown, never signed. {@code chainId} is this wallet's (Settings). */
    public SignFlow(SignerProfiles profiles, MsauthCore core, Node node, long chainId, SeedSource seeds) {
        this.profiles = profiles;
        this.core = core;
        this.node = node;
        this.chainId = chainId;
        this.seeds = seeds;
    }

    private String policy(String id) {
        String p = profiles.policy(id);
        if (p == null) throw new IllegalArgumentException(L10n.t(R.string.msauth_no_profile, "No such signer profile."));
        return p;
    }

    /** The head from a node on this wallet's chain; any failure, or a height past 2^53-1, is no node. */
    private Judgement judgeNow(JSONObject summary, List<String> payees) {
        if (node == null) return judge(summary, null, chainId, null, "", payees);
        String url = "";
        try {
            url = node.url();
            if (node.chainId() != chainId) return judge(summary, null, chainId, null, url, payees);
            long head = node.headHeight();
            if (head < 0 || head > MAX_SAFE_INTEGER) return judge(summary, null, chainId, null, url, payees);
            return judge(summary, head, chainId, node.genesisHash(), url, payees);
        } catch (Exception e) {
            return judge(summary, null, chainId, null, url, payees);
        }
    }

    private static void checkCancel(Cancel cancel) {
        if ((cancel != null && cancel.cancelled()) || Thread.currentThread().isInterrupted()) throw new CancellationException();
    }

    private static boolean anyBlank(List<String> payees) {
        for (String p : payees) if (isBlank(p)) return true;
        return false;
    }

    /** The core's check with the intended payments, and the verdict on it now. A blank entry is refused before the core is asked. */
    public Check check(String id, String proposal, List<String> expectedRecipients) throws Exception {
        String policy = policy(id);
        List<String> payees = Collections.unmodifiableList(payees(expectedRecipients));
        if (anyBlank(payees)) return new Check(null, Judgement.of(Verdict.UNCHECKED_RECIPIENT, ""));
        JSONObject summary = core.msauthCheck(clean(proposal), policy, payees);
        return new Check(summary, judgeNow(summary, payees));
    }

    /**
     * The share, or the refusal ({@link Refusal}, the core's error, or {@link CancellationException}).
     * The order: check and judge; stop if cancelled; read the seed (the system asks for the
     * fingerprint, face or screen lock); re-read the head and judge again, since the prompt can take
     * as long as the person likes; stop if cancelled; sign with the same list the check used, so the
     * core re-runs the payee check on exactly what was judged. The seed buffer is zeroed on every
     * exit; its hex copy for the core is a String, which cannot be wiped (it is unreachable after the
     * call, and the core holds its own copy in a wiped buffer).
     */
    public Share sign(String id, String proposal, List<String> expectedRecipients, Cancel cancel) throws Exception {
        String policy = policy(id);
        String text = clean(proposal);
        List<String> payees = Collections.unmodifiableList(payees(expectedRecipients));
        if (anyBlank(payees)) throw new Refusal(Judgement.of(Verdict.UNCHECKED_RECIPIENT, ""));
        JSONObject summary = core.msauthCheck(text, policy, payees);
        Judgement first = judgeNow(summary, payees);
        if (!first.signable()) throw new Refusal(first);
        checkCancel(cancel);
        byte[] seed = seeds.seed(id);
        try {
            Judgement again = judgeNow(summary, payees);
            if (!again.signable()) throw new Refusal(again);
            checkCancel(cancel);
            String share = core.msauthSign(text, policy, hex(seed), payees);
            return new Share(share, shareIndex(share));
        } finally {
            if (seed != null) Arrays.fill(seed, (byte) 0);
        }
    }

    /** Another signer's share checked over this proposal (throws the core's refusal); its position. */
    public int verifyShare(String id, String proposal, String share) throws Exception {
        String s = clean(share);
        core.msauthVerifyShare(clean(proposal), policy(id), s);
        return shareIndex(s);
    }

    private static int shareIndex(String share) {
        int colon = share == null ? -1 : share.indexOf(':');
        if (colon > 0) {
            String head = share.substring(0, colon).trim();
            if (digits(head) && head.length() <= 3) return Integer.parseInt(head);
        }
        throw new IllegalStateException("msauth_sign returned no share");
    }

    private static String hex(byte[] b) {
        char[] out = new char[b.length * 2];
        final char[] digits = "0123456789abcdef".toCharArray();
        for (int i = 0; i < b.length; i++) {
            out[2 * i] = digits[(b[i] >> 4) & 0xf];
            out[2 * i + 1] = digits[b[i] & 0xf];
        }
        String s = new String(out);
        Arrays.fill(out, '\0');
        return s;
    }
}

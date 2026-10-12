package org.randprotocol.wallet.wallet;

import org.json.JSONObject;

import java.util.List;

/**
 * The core methods private-multisig signing uses (wallet-core msauth.rs, documented on {@code
 * wallet_core::dispatch}): {@link org.randprotocol.wallet.core.Core}'s five {@code msauth*}
 * wrappers. An interface so the JVM unit tests, which cannot load the native core, can stand in for
 * it ({@link ProverCore} does the same); {@link NativeMsauthCore#INSTANCE} is the real one.
 */
public interface MsauthCore {
    /** {@code msauth_check}: fullnode's summary plus what wallet-core adds; {@link SignFlow} judges it. */
    JSONObject msauthCheck(String proposal, String policy, List<String> expectedRecipients) throws Exception;

    /** {@code msauth_sign}: the share {@code "i:hex"}, with the same list the check was given. */
    String msauthSign(String proposal, String policy, String seedHex, List<String> expectedRecipients) throws Exception;

    /** {@code msauth_verify_share}: throws the core's refusal when the share does not verify. */
    void msauthVerifyShare(String proposal, String policy, String share) throws Exception;

    /** {@code msauth_signer_import}: {@code {seed, public_key, address, index}}. */
    JSONObject msauthSignerImport(String input, String policy) throws Exception;

    /** {@code msauth_policy_info}: {@code {fingerprint, threshold, signers, address, policy_hash}}. */
    JSONObject msauthPolicyInfo(String policy) throws Exception;
}

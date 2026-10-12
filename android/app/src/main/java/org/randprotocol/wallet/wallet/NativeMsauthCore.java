package org.randprotocol.wallet.wallet;

import org.json.JSONObject;
import org.randprotocol.wallet.core.Core;
import org.randprotocol.wallet.core.CoreException;

import java.util.List;

/** {@link MsauthCore} over the native core: each method is {@link Core}'s wrapper of the same name. */
public final class NativeMsauthCore implements MsauthCore {
    public static final NativeMsauthCore INSTANCE = new NativeMsauthCore();

    private NativeMsauthCore() {}

    @Override
    public JSONObject msauthCheck(String proposal, String policy, List<String> expectedRecipients) throws CoreException {
        return Core.msauthCheck(proposal, policy, expectedRecipients);
    }

    @Override
    public String msauthSign(String proposal, String policy, String seedHex, List<String> expectedRecipients) throws CoreException {
        return Core.msauthSign(proposal, policy, seedHex, expectedRecipients);
    }

    @Override
    public void msauthVerifyShare(String proposal, String policy, String share) throws CoreException {
        Core.msauthVerifyShare(proposal, policy, share);
    }

    @Override
    public JSONObject msauthSignerImport(String input, String policy) throws CoreException {
        return Core.msauthSignerImport(input, policy);
    }

    @Override
    public JSONObject msauthPolicyInfo(String policy) throws CoreException {
        return Core.msauthPolicyInfo(policy);
    }
}

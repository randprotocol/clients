package org.randprotocol.wallet.ui;

import org.randprotocol.wallet.core.Core;
import org.randprotocol.wallet.core.CoreException;

import org.json.JSONObject;

/** {@link SendDraft.CoreApi} over the real core: {@code parse_address}, {@code address_fingerprint}, {@code uri_parse}. */
final class NativeCoreApi implements SendDraft.CoreApi {
    static final NativeCoreApi INSTANCE = new NativeCoreApi();

    private NativeCoreApi() {}

    @Override
    public String addressError(String address) {
        try {
            JSONObject info = Core.parseAddress(address);
            if (info.optBoolean("valid", false)) return null;
            String e = info.optString("error", "");
            return e.isEmpty() ? "That is not a rand1 address." : e;
        } catch (CoreException e) {
            return e.getMessage();
        }
    }

    @Override
    public String fingerprint(String address) throws Exception {
        String fp = Core.addressFingerprint(address);
        if (fp == null || fp.isEmpty()) throw new CoreException("the core returned no fingerprint");
        return fp;
    }

    @Override
    public SendDraft.PaymentLink uriParse(String uri) throws Exception {
        return SendDraft.PaymentLink.fromJson(Core.uriParse(uri));
    }
}

package org.randprotocol.wallet.ui;

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.core.Core;
import org.randprotocol.wallet.core.CoreException;

import org.json.JSONObject;
import org.randprotocol.wallet.util.L10n;

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
            return e.isEmpty() ? L10n.t(R.string.send_not_an_address, "That is not a rand1 address.") : CoreErrors.translate(e);
        } catch (CoreException e) {
            return e.getLocalizedMessage();
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

package org.randprotocol.wallet.ui;

import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Bundle;
import android.text.method.ScrollingMovementMethod;
import android.view.View;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.WriterException;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel;

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.core.Core;
import org.randprotocol.wallet.core.CoreException;
import org.randprotocol.wallet.databinding.ActivityReceiveBinding;
import org.randprotocol.wallet.util.Amounts;

import java.nio.charset.StandardCharsets;
import java.util.EnumMap;
import java.util.Map;

/**
 * The address, its fingerprint, and a QR of its {@code randpay:} link (spec 2026-09-26 §3.3). The
 * QR encodes the link, never the bare address (a bare address is the link with no parameters), at
 * error-correction level M. The optional amount and memo rebuild the link; the core formats it
 * and parses it back, so this screen cannot hand out a link another wallet would refuse.
 */
public class ReceiveActivity extends BaseActivity {
    private ActivityReceiveBinding b;
    private String address = "";
    private String link = "";
    /** The connected chain's {@code envelope_bytes}; null (unknown, or no memos) hides the memo field. */
    private Integer envelopeBytes;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        b = ActivityReceiveBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());
        address = wallet().address();
        b.address.setText(address);
        b.address.setMovementMethod(new ScrollingMovementMethod());
        try {
            b.fingerprint.setText(Core.addressFingerprint(address));
        } catch (CoreException e) {
            b.fingerprint.setText(R.string.contacts_fingerprint_unavailable);
        }
        b.copy.setOnClickListener(v -> copy(getString(R.string.clip_address), address, getString(R.string.home_copied)));
        b.copyLink.setOnClickListener(v -> copy(getString(R.string.clip_payment_link), link, getString(R.string.receive_link_copied)));
        b.share.setOnClickListener(v -> {
            if (link.isEmpty()) return;
            Intent i = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link);
            startActivity(Intent.createChooser(i, getString(R.string.receive_share)));
        });
        b.amount.addTextChangedListener(new Watcher(this::rebuild));
        b.memo.addTextChangedListener(new Watcher(this::rebuild));
        applyMemoGate();
        rebuild();

        new Thread(() -> {
            Integer bytes;
            try {
                bytes = wallet().envelopeBytes();
            } catch (Exception e) {
                bytes = null;
            }
            Integer got = bytes;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                envelopeBytes = got;
                applyMemoGate();
                rebuild();
            });
        }, "limits").start();
    }

    private void applyMemoGate() {
        boolean shows = ReceiveLinkRules.showsMemo(envelopeBytes);
        b.memoGroup.setVisibility(shows ? View.VISIBLE : View.GONE);
        b.linkBody.setText(shows ? R.string.receive_link_body_memo : R.string.receive_link_body);
    }

    /** A field the user is still getting wrong leaves the link — and the QR — at the last good form. */
    private void rebuild() {
        if (address.isEmpty()) return;
        String memo = String.valueOf(b.memo.getText());
        b.memoCounter.setText(Memo.counter(memo));
        b.memoCounter.setTextColor(getColor(Memo.tooLong(memo) == null ? R.color.text_mute : R.color.negative));
        String linkMemo = ReceiveLinkRules.linkMemo(memo, envelopeBytes);
        if (linkMemo != null && Memo.tooLong(linkMemo) != null) {
            b.linkError.setText(Memo.tooLong(linkMemo));
            return;
        }
        String amount = String.valueOf(b.amount.getText()).trim();
        if (!amount.isEmpty() && Amounts.parse(amount) == null) {
            b.linkError.setText(R.string.receive_bad_amount);
            return;
        }
        try {
            setLink(Core.uriFormat(address, amount, null, linkMemo));
            b.linkError.setText("");
        } catch (CoreException e) {
            if (link.isEmpty()) setLink("randpay:" + address);
            b.linkError.setText(e.getLocalizedMessage());

        }
    }

    private void setLink(String l) {
        if (l == null || l.equals(link)) return;
        link = l;
        Bitmap qr = qr(link);
        b.qr.setImageBitmap(qr);
        b.qr.setVisibility(qr == null ? View.GONE : View.VISIBLE);
        b.qrTooLong.setVisibility(qr == null ? View.VISIBLE : View.GONE);
    }

    /**
     * A {@code randpay:} link to a ~1.7 KB shielded address fits a byte-mode QR at level M
     * (version 40 holds 2 331 bytes); null for a link too long for any version (a long memo).
     * Level M, per spec 2026-09-26 §3.3, so it survives a scuffed screen.
     */
    static Bitmap qr(String text) {
        try {
            Map<EncodeHintType, Object> hints = new EnumMap<>(EncodeHintType.class);
            hints.put(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.M);
            hints.put(EncodeHintType.MARGIN, 0);
            boolean ascii = StandardCharsets.US_ASCII.newEncoder().canEncode(text);
            hints.put(EncodeHintType.CHARACTER_SET, ascii ? "ISO-8859-1" : "UTF-8");
            // One module per matrix cell, then scaled here: sharp edges at any version.
            BitMatrix m = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints);
            int n = m.getWidth();
            int scale = Math.max(1, 900 / n);
            int size = n * scale;
            int[] px = new int[size * size];
            for (int y = 0; y < size; y++) {
                int row = y * size, my = y / scale;
                for (int x = 0; x < size; x++) px[row + x] = m.get(x / scale, my) ? Color.BLACK : Color.WHITE;
            }
            return Bitmap.createBitmap(px, size, size, Bitmap.Config.RGB_565);
        } catch (WriterException | IllegalArgumentException e) {
            return null;
        }
    }
}

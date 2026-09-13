package org.randprotocol.wallet.ui;

import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Bundle;
import android.text.method.ScrollingMovementMethod;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.WriterException;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel;

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.databinding.ActivityReceiveBinding;

import java.util.EnumMap;
import java.util.Map;

/** The address as a QR (1668 characters: byte mode, error correction L, version 33 or so) and as text. */
public class ReceiveActivity extends BaseActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ActivityReceiveBinding b = ActivityReceiveBinding.inflate(getLayoutInflater());
        setContentView(b.getRoot());
        String address = wallet().address();
        b.address.setText(address);
        b.address.setMovementMethod(new ScrollingMovementMethod());
        Bitmap qr = qr(address, 900);
        if (qr != null) b.qr.setImageBitmap(qr);
        b.copy.setOnClickListener(v -> copy("address", address, getString(R.string.home_copied)));
        b.share.setOnClickListener(v -> {
            Intent i = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, address);
            startActivity(Intent.createChooser(i, getString(R.string.receive_share)));
        });
    }

    static Bitmap qr(String text, int size) {
        try {
            Map<EncodeHintType, Object> hints = new EnumMap<>(EncodeHintType.class);
            hints.put(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.L);
            hints.put(EncodeHintType.MARGIN, 0);
            hints.put(EncodeHintType.CHARACTER_SET, "ISO-8859-1");
            BitMatrix m = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, hints);
            Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565);
            for (int y = 0; y < size; y++) {
                for (int x = 0; x < size; x++) bmp.setPixel(x, y, m.get(x, y) ? Color.BLACK : Color.WHITE);
            }
            return bmp;
        } catch (WriterException | IllegalArgumentException e) {
            return null;
        }
    }
}

package org.randprotocol.wallet.wallet;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import org.randprotocol.wallet.App;
import org.randprotocol.wallet.R;
import org.randprotocol.wallet.ui.SendActivity;
import org.randprotocol.wallet.ui.SwapActivity;

import java.math.BigInteger;

/**
 * A bundle proof takes minutes of CPU; a foreground service with a visible notification is what
 * keeps the OS from killing it when the user switches away. The whole send (scan, prove, submit,
 * wait) runs here and reports through {@link SendMonitor}. Where this device cannot fit the
 * proof and the paired prover answers, the bundle proof is made there instead ({@link RemoteSend},
 * the same order: the auth proof here, seal, submit, poll, {@code finish_proof}, then the same
 * submission — the prover gets the viewing key and a salt on a split-authorisation chain, never
 * the spend key), and this service keeps the process alive while it polls. There is no resume:
 * a process the system kills loses the job, and nothing is sent. A swap (an RPL-2 invoke,
 * {@link #EXTRA_KIND}) runs here the same way and reports through {@link SwapMonitor}.
 */
public class ProvingService extends Service {
    public static final String EXTRA_TO = "to";
    public static final String EXTRA_AMOUNT = "amount";
    public static final String EXTRA_FEE = "fee";
    public static final String EXTRA_MEMO = "memo";
    /** {@code "invoke"} for a swap ({@link WalletService#invoke}); absent for a transfer. */
    public static final String EXTRA_KIND = "kind";
    public static final String KIND_INVOKE = "invoke";
    /** A swap's request JSON ({@link Amm.Swap#request}). */
    public static final String EXTRA_REQUEST = "request";
    private static final String CHANNEL = "proving";
    private static final int NOTIFICATION_ID = 1;

    private Thread worker;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        boolean invoke = KIND_INVOKE.equals(intent.getStringExtra(EXTRA_KIND));
        if (worker != null) {
            // One proof at a time; a swap asked for meanwhile is told so, not dropped in silence.
            if (invoke) SwapMonitor.post(SendState.idle().failed(null, App.text(R.string.proving_busy)));
            return START_NOT_STICKY;
        }
        if (invoke) return startInvoke(intent);
        String to = intent.getStringExtra(EXTRA_TO);
        BigInteger amount = new BigInteger(intent.getStringExtra(EXTRA_AMOUNT));
        BigInteger fee = new BigInteger(intent.getStringExtra(EXTRA_FEE));
        String memo = intent.getStringExtra(EXTRA_MEMO);

        startInForeground(App.text(R.string.proving_notification_title), App.text(R.string.proving_notification_text));
        worker = new Thread(() -> {
            try {
                WalletService.get(this).send(to, amount, fee, memo == null ? "" : memo);
            } finally {
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelf();
            }
        }, "proving");
        worker.start();
        return START_NOT_STICKY;
    }

    private int startInvoke(Intent intent) {
        String request = intent.getStringExtra(EXTRA_REQUEST);
        String amount = intent.getStringExtra(EXTRA_AMOUNT);
        startInForeground(App.text(R.string.swap_notification_title), App.text(R.string.proving_notification_text), SwapActivity.class);
        worker = new Thread(() -> {
            try {
                WalletService.get(this).invoke(new org.json.JSONObject(request), amount);
            } catch (org.json.JSONException e) {
                SwapMonitor.post(SendState.idle().failed(Invoke.BAD_REQUEST, App.text(R.string.swap_unreadable)));
            } finally {
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelf();
            }
        }, "proving");
        worker.start();
        return START_NOT_STICKY;
    }

    private void startInForeground(String title, String text) {
        startInForeground(title, text, SendActivity.class);
    }

    private void startInForeground(String title, String text, Class<?> screen) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL, App.text(R.string.proving_channel), NotificationManager.IMPORTANCE_LOW);

        nm.createNotificationChannel(ch);
        Intent open = new Intent(this, screen).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_proving)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(pi)
                .setProgress(0, 0, true)
                .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

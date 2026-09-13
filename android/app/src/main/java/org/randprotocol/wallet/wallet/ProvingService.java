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

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.ui.SendActivity;

import java.math.BigInteger;

/**
 * A bundle proof takes minutes of CPU; a foreground service with a visible notification is what
 * keeps the OS from killing it when the user switches away. The whole send (scan, prove, submit,
 * wait) runs here and reports through {@link SendMonitor}.
 */
public class ProvingService extends Service {
    public static final String EXTRA_TO = "to";
    public static final String EXTRA_AMOUNT = "amount";
    public static final String EXTRA_FEE = "fee";
    private static final String CHANNEL = "proving";
    private static final int NOTIFICATION_ID = 1;

    private Thread worker;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || worker != null) return START_NOT_STICKY;
        String to = intent.getStringExtra(EXTRA_TO);
        BigInteger amount = new BigInteger(intent.getStringExtra(EXTRA_AMOUNT));
        BigInteger fee = new BigInteger(intent.getStringExtra(EXTRA_FEE));

        startInForeground(getString(R.string.proving_notification_title), getString(R.string.proving_notification_text));
        worker = new Thread(() -> {
            try {
                WalletService.get(this).send(to, amount, fee);
            } finally {
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelf();
            }
        }, "proving");
        worker.start();
        return START_NOT_STICKY;
    }

    private void startInForeground(String title, String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.proving_channel), NotificationManager.IMPORTANCE_LOW);
        nm.createNotificationChannel(ch);
        Intent open = new Intent(this, SendActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
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

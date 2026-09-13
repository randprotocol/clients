package org.randprotocol.wallet.ui;

import android.content.Context;
import android.view.LayoutInflater;
import android.view.ViewGroup;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.recyclerview.widget.RecyclerView;

import org.randprotocol.wallet.R;
import org.randprotocol.wallet.databinding.ItemActivityBinding;
import org.randprotocol.wallet.util.Amounts;

import java.util.ArrayList;
import java.util.List;

public class ActivityAdapter extends RecyclerView.Adapter<ActivityAdapter.Holder> {
    public interface OnClick {
        void onClick(ActivityItem item);
    }

    private final List<ActivityItem> items = new ArrayList<>();
    private final OnClick onClick;

    public ActivityAdapter(OnClick onClick) {
        this.onClick = onClick;
    }

    public void submit(List<ActivityItem> list) {
        items.clear();
        items.addAll(list);
        notifyDataSetChanged();
    }

    @NonNull
    @Override
    public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        return new Holder(ItemActivityBinding.inflate(LayoutInflater.from(parent.getContext()), parent, false));
    }

    @Override
    public void onBindViewHolder(@NonNull Holder h, int position) {
        ActivityItem it = items.get(position);
        Context c = h.b.getRoot().getContext();
        boolean in = it.kind == ActivityItem.Kind.RECEIVED;
        h.b.icon.setImageResource(in ? R.drawable.ic_arrow_down : R.drawable.ic_arrow_up);
        String title = in ? c.getString(R.string.detail_received) : c.getString(R.string.detail_sent);
        if (it.pending) title = c.getString(R.string.detail_pending);
        h.b.title.setText(title);
        String sub = it.height > 0 ? c.getString(R.string.detail_height) + " " + it.height : c.getString(R.string.status_pending);
        if (in && it.spent) sub += " · " + c.getString(R.string.detail_spent);
        h.b.subtitle.setText(sub);
        h.b.amount.setText((in ? "+" : "−") + Amounts.format(it.amount));
        h.b.amount.setTextColor(ContextCompat.getColor(c, in ? R.color.positive : R.color.text));
        h.b.getRoot().setOnClickListener(v -> onClick.onClick(it));
    }

    @Override
    public int getItemCount() {
        return items.size();
    }

    static class Holder extends RecyclerView.ViewHolder {
        final ItemActivityBinding b;

        Holder(ItemActivityBinding b) {
            super(b.getRoot());
            this.b = b;
        }
    }
}

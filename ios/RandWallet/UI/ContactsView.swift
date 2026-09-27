import SwiftUI
import UIKit

/// Names for the addresses this wallet pays often (spec 2026-09-26 §3.3). The list lives in the
/// Keychain on this device only; the rules are the CLI's (`ContactBook`).
struct ContactsView: View {
    @EnvironmentObject var contacts: ContactsStore
    @Environment(\.dismiss) private var dismiss
    @State private var showAdd = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if contacts.book.sorted.isEmpty {
                    Text("No contacts yet. A contact's name can be typed in Send's To field instead of the address.")
                        .font(.system(size: 14)).foregroundColor(Theme.textMute)
                }
                ForEach(contacts.book.sorted) { c in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(c.name).font(.system(size: 16, weight: .semibold)).foregroundColor(Theme.text)
                        Text("fingerprint \((try? RandCore.addressFingerprint(c.address)) ?? "unavailable")")
                            .font(.monoSmall).foregroundColor(Theme.textSoft)
                        Text(c.address.shortened(head: 14, tail: 8)).font(.monoSmall).foregroundColor(Theme.textMute)
                    }
                    .contextMenu {
                        Button("Copy address") { UIPasteboard.general.string = c.address }
                    }
                }
                .onDelete { idx in
                    let names = idx.map { contacts.book.sorted[$0].name }
                    for n in names {
                        do { try contacts.remove(name: n) } catch { self.error = error.localizedDescription }
                    }
                }
                if let e = error { ErrorText(message: e) }
            }
            .navigationTitle("Contacts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { showAdd = true } label: { Image(systemName: "plus") }.accessibilityLabel("Add contact")
                }
            }
            .sheet(isPresented: $showAdd) { AddContactView() }
        }
    }
}

struct AddContactView: View {
    @EnvironmentObject var contacts: ContactsStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var address = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    SectionLabel(text: "Name")
                    Field(placeholder: "alice", text: $name)
                    SectionLabel(text: "Address")
                    HStack(spacing: 8) {
                        Field(placeholder: "rand1… or randpay: link", text: $address, mono: true)
                        Button {
                            if let s = UIPasteboard.general.string { address = s.trimmingCharacters(in: .whitespacesAndNewlines) }
                        } label: { Text("Paste").font(.system(size: 14, weight: .semibold)).foregroundColor(Theme.accent) }
                    }
                    if let fp = fingerprint { Text("fingerprint \(fp)").font(.mono).foregroundColor(Theme.textSoft) }
                    ErrorText(message: error)
                    PrimaryButton(title: "Save contact", enabled: !name.isEmpty && !address.isEmpty) { save() }
                }
                .padding(20)
            }
            .screenBackground()
            .navigationTitle("New contact")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { Button("Cancel") { dismiss() } } }
        }
    }

    /// A pasted `randpay:` link saves the address it carries.
    private var resolvedAddress: String? {
        let s = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if RecipientKind(s) == .link { return try? RandCore.uriParse(s).address }
        return (try? RandCore.parseAddress(s))?.valid == true ? s : nil
    }

    private var fingerprint: String? { resolvedAddress.flatMap { try? RandCore.addressFingerprint($0) } }

    private func save() {
        guard let addr = resolvedAddress else {
            error = "That is not a shielded address or a randpay: link."
            return
        }
        do {
            try contacts.add(name: name, address: addr)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

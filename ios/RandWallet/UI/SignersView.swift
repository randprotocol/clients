import SwiftUI
import UniformTypeIdentifiers

/// Settings → Multisig signers: the saved signer profiles and a form that adds one. The policy and
/// the key come from files or a paste; the key is stored behind the device passcode
/// (`SignerStore.add`), and every signature asks for Face ID / Touch ID / the passcode again.
struct SignersView: View {
    @EnvironmentObject var store: SignerStore
    @State private var adding = false
    @State private var removeError: String?
    @State private var pendingRemove: SignerProfile?

    var body: some View {
        List {
            if store.profiles.isEmpty {
                Section {
                    Text("No signer profiles yet").font(.headline)
                    Text("Add the policy file and your signer key to sign for a private multisig account.").foregroundColor(.secondary)
                }
            } else {
                Section {
                    ForEach(store.profiles) { p in
                        NavigationLink { SignProposalView(profile: p) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: p.label)
                                Text(verbatim: p.fingerprint).font(.mono)
                                Text(String(localized: "\(String(p.threshold)) of \(String(p.signers)) · signer \(String(p.index))"))
                                    .font(.footnote).foregroundColor(.secondary)
                            }
                        }
                        .swipeActions(allowsFullSwipe: false) {
                            Button("Remove this signer", role: .destructive) { pendingRemove = p }
                        }
                    }
                }
            }
            if let removeError { Section { Text(verbatim: removeError).foregroundColor(.red) } }
            Section {
                Button("Add a signer") { adding = true }
            } footer: {
                Text("A signer profile is kept in this phone's Keychain. Every signature asks for Face ID, Touch ID or your passcode again.")
            }
        }
        .navigationTitle("Multisig signers")
        .confirmationDialog(String(localized: "Remove \(pendingRemove?.label ?? "")?"), isPresented: Binding(get: { pendingRemove != nil }, set: { if !$0 { pendingRemove = nil } }),
                            titleVisibility: .visible, presenting: pendingRemove) { p in
            Button("Remove this signer", role: .destructive) { Task { await remove(p) } }
        } message: { _ in
            Text("You need the signer's key file to add this signer back.")
        }
        .sheet(isPresented: $adding) { NavigationStack { AddSignerView() } }
    }

    private func remove(_ p: SignerProfile) async {
        removeError = nil
        guard await Keychain.authenticate(reason: String(localized: "Remove a multisig signer")) else { return }
        store.remove(p.id)
    }
}

/// What the add form shows once the core has read the policy and the key.
struct SignerPreview: Equatable {
    let fingerprint: String
    let address: String
    let threshold: Int
    let signers: Int
    let index: Int?
}

/// Reads the policy and the key through the core; throws the core's refusal. The seed in the
/// core's reply is not kept.
func previewSigner(policy: String, key: String) throws -> SignerPreview {
    let pol = MsauthRules.clean(policy)
    let info = try RandCore.msauthPolicyInfo(pol)
    let signer = try RandCore.msauthSignerImport(MsauthRules.clean(key), policy: pol)
    return SignerPreview(fingerprint: info.fingerprint, address: info.address, threshold: info.threshold,
                         signers: info.signers, index: signer.index)
}

struct AddSignerView: View {
    @EnvironmentObject var store: SignerStore
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var policy = ""
    @State private var key = ""
    @State private var preview: SignerPreview?
    @State private var error: String?
    @State private var target: Target?
    enum Target { case policy, key }

    var body: some View {
        Form {
            Section {
                TextField("Label", text: $label).onChange(of: label) { _ in preview = nil }
            }
            fileSection("Policy file", text: $policy, target: .policy)
            fileSection("Signer key file, or its 64-hex seed", text: $key, target: .key)
            Section {
                if let error { Text(verbatim: error).foregroundColor(.red) }
                Button("Check") { check() }.disabled(policy.isEmpty || key.isEmpty)
            }
            if let p = preview {
                Section("Account fingerprint — compare it with every other signer before you save") {
                    Text(verbatim: p.fingerprint).font(.mono.weight(.semibold))
                    Text(verbatim: p.address).font(.mono).foregroundColor(.secondary)
                    if let i = p.index {
                        Text(String(localized: "\(String(p.threshold)) of \(String(p.signers)) · this key is signer \(String(i))"))
                    }
                    Button("Save signer") { save() }
                }
            }
        }
        .navigationTitle("Add a signer")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        .fileImporter(isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }),
                      allowedContentTypes: [.json, .plainText]) { result in
            let t = target; target = nil
            guard case .success(let url) = result else { return }
            do {
                let text = try readPickedFile(url)
                if t == .policy { policy = text } else { key = text }
                preview = nil; error = nil
            } catch { self.error = error.localizedDescription }
        }
    }

    private func fileSection(_ title: LocalizedStringKey, text: Binding<String>, target t: Target) -> some View {
        Section(title) {
            TextEditor(text: text).font(.mono).frame(minHeight: 70).autocorrectionDisabled().textInputAutocapitalization(.never)
                .onChange(of: text.wrappedValue) { _ in preview = nil }
            Button("Open file") { target = t }
        }
    }

    private func check() {
        error = nil; preview = nil
        do { preview = try previewSigner(policy: policy, key: key) } catch { self.error = error.localizedDescription }
    }

    private func save() {
        do {
            _ = try store.add(label: label, policy: policy, key: key)
            label = ""; policy = ""; key = ""; preview = nil
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

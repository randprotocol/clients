import Foundation
import Network

/// This phone's connectivity as the system reports it (`NWPathMonitor`): `online` is true while the
/// current path is `.satisfied`, false while it is not, and nil until the monitor's first update.
/// Read only to tell "this phone is offline" from "the RandProtocol provers are away"
/// (`ProverPairingService.poolUnavailable`).
final class Connectivity {
    static let shared = Connectivity()

    private let monitor = NWPathMonitor()
    private let lock = NSLock()
    private var status: NWPath.Status?

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            self.lock.lock(); self.status = path.status; self.lock.unlock()
        }
        monitor.start(queue: DispatchQueue(label: "org.randprotocol.wallet.connectivity"))
    }

    var online: Bool? {
        lock.lock(); defer { lock.unlock() }
        guard let status else { return nil }
        return status == .satisfied
    }
}

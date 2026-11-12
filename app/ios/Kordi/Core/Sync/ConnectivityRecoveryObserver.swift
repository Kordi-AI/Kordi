import Foundation
import Network
import UIKit

/// Calls `onRecovery` when the network path becomes satisfied again and when
/// the app returns to the foreground. Both mean a waiting retry can run now.
@MainActor
final class ConnectivityRecoveryObserver: NSObject {
    private let monitor = NWPathMonitor()
    private let onRecovery: @MainActor () -> Void
    private var lastStatus: NWPath.Status?

    init(onRecovery: @escaping @MainActor () -> Void) {
        self.onRecovery = onRecovery
        super.init()
        monitor.pathUpdateHandler = { [weak self] path in
            let status = path.status
            Task { @MainActor [weak self] in self?.pathChanged(to: status) }
        }
        monitor.start(queue: DispatchQueue(label: "ai.kordi.connectivity-recovery"))
        // Selector observers are removed automatically when the observer is released.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(applicationWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
    }

    deinit {
        monitor.cancel()
    }

    private func pathChanged(to status: NWPath.Status) {
        defer { lastStatus = status }
        guard status == .satisfied, let lastStatus, lastStatus != .satisfied else { return }
        onRecovery()
    }

    @objc private func applicationWillEnterForeground() {
        onRecovery()
    }
}

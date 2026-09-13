import SwiftUI
import AVFoundation
import UIKit

/// Scans a recipient address QR with the camera. Falls back to a message on the simulator.
struct QRScannerView: View {
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                ScannerRepresentable(onCode: onCode).ignoresSafeArea()
                VStack {
                    Spacer()
                    Text("Point the camera at a Rand Wallet address").font(.system(size: 14, weight: .medium))
                        .foregroundColor(.white).padding(10).background(Color.black.opacity(0.5)).clipShape(Capsule()).padding(.bottom, 32)
                }
            }
            .navigationTitle("Scan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { Button("Cancel") { dismiss() } } }
        }
    }
}

private struct ScannerRepresentable: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    func makeUIViewController(context: Context) -> ScannerController { ScannerController(onCode: onCode) }
    func updateUIViewController(_ uiViewController: ScannerController, context: Context) {}
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let onCode: (String) -> Void
    private let session = AVCaptureSession()
    private var delivered = false

    init(onCode: @escaping (String) -> Void) {
        self.onCode = onCode
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device) else {
            let label = UILabel()
            label.text = "No camera available"
            label.textColor = .white
            label.textAlignment = .center
            label.frame = view.bounds
            label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(label)
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.frame = view.bounds
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning { session.stopRunning() }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !delivered, let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject, let s = obj.stringValue else { return }
        delivered = true
        session.stopRunning()
        onCode(s)
    }
}

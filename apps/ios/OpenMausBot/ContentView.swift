import SwiftUI
import WebKit

struct ContentView: View {
    @AppStorage("openmausbot_server_url") private var savedUrlString = ""
    @State private var draftUrlString = ""
    @State private var showingSettings = false
    @State private var reloadToken = UUID()
    @State private var loadError: String?

    private var activeURL: URL? {
        normalizedURL(from: savedUrlString)
    }

    var body: some View {
        NavigationStack {
            Group {
                if let url = activeURL {
                    ZStack(alignment: .top) {
                        OpenMausWebView(
                            url: url,
                            reloadToken: reloadToken,
                            onError: { message in
                                loadError = message
                            },
                            onStartLoad: {
                                loadError = nil
                            }
                        )
                        .ignoresSafeArea(.container, edges: .bottom)

                        if let loadError {
                            VStack(spacing: 12) {
                                Text("Could not connect to OpenMausBot")
                                    .font(.headline)
                                Text(loadError)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .multilineTextAlignment(.center)
                                HStack(spacing: 12) {
                                    Button("Retry") {
                                        reloadToken = UUID()
                                    }
                                    .buttonStyle(.borderedProminent)
                                    Button("Change URL") {
                                        draftUrlString = savedUrlString
                                        showingSettings = true
                                    }
                                    .buttonStyle(.bordered)
                                }
                            }
                            .padding()
                            .background(.ultraThickMaterial, in: RoundedRectangle(cornerRadius: 16))
                            .padding()
                        }
                    }
                } else {
                    serverSetupPrompt
                }
            }
            .navigationTitle("OpenMausBot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        reloadToken = UUID()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(activeURL == nil)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        draftUrlString = savedUrlString
                        showingSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
        }
        .sheet(isPresented: $showingSettings) {
            NavigationStack {
                Form {
                    Section("Server URL") {
                        TextField("https://your-url.trycloudflare.com", text: $draftUrlString)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    Section {
                        Text("Enter the HTTPS tunnel URL (or local Wi-Fi URL) of your running OpenMausBot server, then pair using Settings → Phone & devices on your computer.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .navigationTitle("Server Connection")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            showingSettings = false
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            savedUrlString = draftUrlString.trimmingCharacters(in: .whitespacesAndNewlines)
                            loadError = nil
                            reloadToken = UUID()
                            showingSettings = false
                        }
                        .disabled(normalizedURL(from: draftUrlString) == nil)
                    }
                }
            }
        }
    }

    private var serverSetupPrompt: some View {
        VStack(spacing: 16) {
            Image(systemName: "desktopcomputer.and.iphone")
                .font(.system(size: 48))
                .foregroundStyle(.tint)
            Text("Connect to OpenMausBot")
                .font(.title2.bold())
            Text("Enter your OpenMausBot HTTPS tunnel URL to pair this iPhone 14 with your computer.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            Button("Set Server URL") {
                draftUrlString = savedUrlString
                showingSettings = true
            }
            .buttonStyle(.borderedProminent)
        }
        .padding()
    }

    private func normalizedURL(from raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let url = URL(string: withScheme),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              url.host != nil else {
            return nil
        }
        return url
    }
}

private struct OpenMausWebView: UIViewRepresentable {
    let url: URL
    let reloadToken: UUID
    let onError: (String) -> Void
    let onStartLoad: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onError: onError, onStartLoad: onStartLoad)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        context.coordinator.lastLoadedURL = url
        context.coordinator.lastReloadToken = reloadToken
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if context.coordinator.lastLoadedURL != url || context.coordinator.lastReloadToken != reloadToken {
            context.coordinator.lastLoadedURL = url
            context.coordinator.lastReloadToken = reloadToken
            webView.load(URLRequest(url: url))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var lastLoadedURL: URL?
        var lastReloadToken: UUID?
        private let onError: (String) -> Void
        private let onStartLoad: () -> Void

        init(onError: @escaping (String) -> Void, onStartLoad: @escaping () -> Void) {
            self.onError = onError
            self.onStartLoad = onStartLoad
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            onStartLoad()
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            onError(error.localizedDescription)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            onError(error.localizedDescription)
        }

        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            decisionHandler(.grant)
        }
    }
}

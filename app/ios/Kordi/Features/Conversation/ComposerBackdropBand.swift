import SwiftUI

/// One full-width frosted band behind the composer strip. It starts a little above the
/// strip, reaches the home indicator (or stops at the keyboard), and fades in over its
/// top edge instead of drawing a line, so bubbles under it read as soft blurred shapes.
struct ComposerBackdropBand: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    /// How far the band reaches above the strip's own top edge.
    static let topOverhang: CGFloat = 3
    /// Height of the clear-to-full fade at the band's top edge.
    static let softEdgeHeight: CGFloat = 22
    /// A light wallpaper tint keeps the floating glass controls distinct while
    /// preserving enough contrast for messages behind the composer.
    static let lightWallpaperOpacity = 0.08
    static let darkWallpaperOpacity = 0.20

    var body: some View {
        surface
            .mask {
                VStack(spacing: 0) {
                    LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                        .frame(height: Self.softEdgeHeight)
                    Rectangle()
                }
            }
            .padding(.top, -Self.topOverhang)
            .ignoresSafeArea(.container, edges: .bottom)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var surface: some View {
        if reduceTransparency {
            Rectangle().fill(Color(uiColor: .secondarySystemBackground))
        } else {
            Rectangle()
                .fill(.ultraThinMaterial)
                .overlay(chatTheme.canvas.opacity(
                    colorScheme == .dark ? Self.darkWallpaperOpacity : Self.lightWallpaperOpacity
                ))
        }
    }
}

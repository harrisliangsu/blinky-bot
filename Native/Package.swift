// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "BlinkyNative",
    platforms: [.macOS(.v26)],
    products: [.executable(name: "BlinkyNative", targets: ["BlinkyNative"])],
    targets: [
        .executableTarget(name: "BlinkyNative"),
        .testTarget(name: "BlinkyNativeTests", dependencies: ["BlinkyNative"])
    ]
)

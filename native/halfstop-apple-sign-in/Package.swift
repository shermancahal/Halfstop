// swift-tools-version: 5.9
import PackageDescription

// The package and product name are what Capacitor's CLI derives from the npm
// name (halfstop-apple-sign-in -> HalfstopAppleSignIn) when it writes
// CapApp-SPM/Package.swift, so they have to be exactly this.
let package = Package(
    name: "HalfstopAppleSignIn",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "HalfstopAppleSignIn",
            targets: ["SignInWithApplePlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "SignInWithApplePlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/SignInWithApplePlugin")
    ]
)

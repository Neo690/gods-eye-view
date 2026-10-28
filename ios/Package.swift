// swift-tools-version: 5.9
//
// The iOS shell as a Swift package, so it can be built without Xcode.
//
// `ios/project.yml` (XcodeGen) stays the spec for Xcode users and for CI's
// macOS runner; this file is the same shell for `xtool`, which turns a SwiftPM
// package into an `.app`, signs it and installs it. Both read the SAME
// `GodsEyeView/` sources — there is no second copy to keep in step, and no
// Swift file changes between the two paths.
//
// The product is a LIBRARY, not an executable, and that is deliberate: xtool's
// planner selects `products.filter { $0.type == .autoLibrary }` and refuses a
// package with none (`No library products were found in the package`), which is
// what a first `xtool dev build` reported here. xcodebuild needed
// `.executable`; xtool builds the library and links it into the app binary
// itself, so `@main` in `AppDelegate.swift` stays the entry point either way.
//
// Swift 5 language mode is deliberate: XcodeGen compiles this target with
// `SWIFT_STRICT_CONCURRENCY: minimal`, because the URLSession bridge in
// `ApiForwarder` is called from a socket task. A `swift-tools-version` of 5.9
// keeps SwiftPM in Swift 5 mode, which is the same bargain.

import PackageDescription

let package = Package(
    name: "GodsEyeView",
    platforms: [
        // Read by xtool for the app's MinimumOSVersion; the project spec
        // declares the same 16.0.
        .iOS(.v16)
    ],
    products: [
        // Named by `xtool.yml`'s `product:`; xtool links this library into
        // `GodsEyeView.app/GodsEyeView` and names CFBundleExecutable after it.
        // A library product is what xtool requires — see the note above.
        .library(name: "GodsEyeView", targets: ["GodsEyeView"])
    ],
    targets: [
        .target(
            name: "GodsEyeView",
            path: "GodsEyeView",
            exclude: [
                // Staged by `npm run ios:payload`. It ships through `xtool.yml`'s
                // `resources:`, which copies the folder to the app root the way
                // the XcodeGen spec's folder reference does, so `BundleAssets`
                // finds `www/` unchanged. SwiftPM must not also see it as an
                // unhandled file.
                "www",
                // The Xcode target's plist. Its `$(EXECUTABLE_NAME)`-style
                // values are expanded by Xcode's build pipeline only; xtool
                // would copy them literally. `Info.xtool.plist` is the one
                // xtool reads, and `xtool.yml` points at it.
                "Info.plist"
            ]
        )
    ]
)

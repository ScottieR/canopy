import AppKit
import CoreGraphics
import Foundation
import ImageIO

struct IconGenerator {
    let projectRoot: URL
    let outputSide: Int = 1024

    func run() throws {
        let sourceIconURL = projectRoot.appendingPathComponent("app-icon-source.png")
        let rootIconURL = projectRoot.appendingPathComponent("app-icon.png")
        let publicIconURL = projectRoot.appendingPathComponent("public/app-icon.png")

        let sourceImage = try loadImage(at: sourceIconURL)
        let resizedIcon = try resize(image: sourceImage, side: outputSide)

        try writePNG(resizedIcon, to: rootIconURL)
        try writePNG(resizedIcon, to: publicIconURL)

        print("Wrote rounded macOS app icon to \(rootIconURL.path)")
        print("Wrote rounded UI icon to \(publicIconURL.path)")
    }

    private func loadImage(at url: URL) throws -> CGImage {
        guard
            let source = CGImageSourceCreateWithURL(url as CFURL, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            throw NSError(
                domain: "CanopyIconGenerator",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Unable to load source icon at \(url.path)"]
            )
        }

        return image
    }

    private func resize(image: CGImage, side: Int) throws -> CGImage {
        guard
            let context = CGContext(
                data: nil,
                width: side,
                height: side,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else {
            throw NSError(
                domain: "CanopyIconGenerator",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Unable to allocate bitmap context"]
            )
        }

        context.interpolationQuality = .high
        context.clear(CGRect(x: 0, y: 0, width: side, height: side))
        context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))

        guard let output = context.makeImage() else {
            throw NSError(
                domain: "CanopyIconGenerator",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Unable to resize icon artwork"]
            )
        }

        return output
    }

    private func writePNG(_ image: CGImage, to url: URL) throws {
        let bitmapRep = NSBitmapImageRep(cgImage: image)
        guard let data = bitmapRep.representation(using: .png, properties: [:]) else {
            throw NSError(
                domain: "CanopyIconGenerator",
                code: 4,
                userInfo: [NSLocalizedDescriptionKey: "Unable to encode PNG for \(url.path)"]
            )
        }

        try data.write(to: url, options: .atomic)
    }
}

let workingDirectory = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)

do {
    try IconGenerator(projectRoot: workingDirectory).run()
} catch {
    fputs("Icon generation failed: \(error.localizedDescription)\n", stderr)
    exit(1)
}

import AppKit
import CoreGraphics
import Foundation
import ImageIO

struct IconGenerator {
    let projectRoot: URL
    let masterSide: Int = 1024
    let sourceBackground = (r: 250, g: 249, b: 246)
    let backgroundColor = NSColor(
        calibratedRed: 250.0 / 255.0,
        green: 249.0 / 255.0,
        blue: 246.0 / 255.0,
        alpha: 1.0
    )
    let cornerRadiusRatio: CGFloat = 0.225

    func run() throws {
        let sourceIconURL = projectRoot.appendingPathComponent("app-icon-source.png")
        let rootIconURL = projectRoot.appendingPathComponent("app-icon.png")
        let publicIconURL = projectRoot.appendingPathComponent("public/app-icon.png")
        let sourceImage = try loadImage(at: sourceIconURL)
        let isolatedSubject = try isolateSubject(from: sourceImage)

        let squareMaster = try renderSquareMaster(from: isolatedSubject)
        try writePNG(squareMaster, to: rootIconURL)

        let roundedPublicIcon = try renderRoundedPublicIcon(from: squareMaster)
        try writePNG(roundedPublicIcon, to: publicIconURL)

        print("Wrote square master to \(rootIconURL.path)")
        print("Wrote rounded UI icon to \(publicIconURL.path)")
    }

    private func isolateSubject(from image: CGImage) throws -> CGImage {
        let width = image.width
        let height = image.height
        let bytesPerPixel = 4
        let bytesPerRow = width * bytesPerPixel
        var pixels = [UInt8](repeating: 0, count: height * bytesPerRow)

        guard
            let context = CGContext(
                data: &pixels,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else {
            throw NSError(
                domain: "CanopyIconGenerator",
                code: 6,
                userInfo: [NSLocalizedDescriptionKey: "Unable to allocate source isolation context"]
            )
        }

        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

        let lowerThreshold = 38
        let upperThreshold = 96

        for index in stride(from: 0, to: pixels.count, by: bytesPerPixel) {
            let red = Int(pixels[index])
            let green = Int(pixels[index + 1])
            let blue = Int(pixels[index + 2])
            let alpha = Int(pixels[index + 3])

            let colorDistance = max(
                abs(red - sourceBackground.r),
                abs(green - sourceBackground.g),
                abs(blue - sourceBackground.b)
            )

            let newAlpha: Int
            if alpha == 0 || colorDistance <= lowerThreshold {
                newAlpha = 0
            } else if colorDistance >= upperThreshold {
                newAlpha = alpha
            } else {
                newAlpha = alpha * (colorDistance - lowerThreshold) / (upperThreshold - lowerThreshold)
            }

            pixels[index + 3] = UInt8(max(0, min(255, newAlpha)))
        }

        guard
            let provider = CGDataProvider(data: NSData(bytes: &pixels, length: pixels.count)),
            let isolated = CGImage(
                width: width,
                height: height,
                bitsPerComponent: 8,
                bitsPerPixel: 32,
                bytesPerRow: bytesPerRow,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                provider: provider,
                decode: nil,
                shouldInterpolate: true,
                intent: .defaultIntent
            )
        else {
            throw NSError(
                domain: "CanopyIconGenerator",
                code: 7,
                userInfo: [NSLocalizedDescriptionKey: "Unable to build isolated subject image"]
            )
        }

        return isolated
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

    private func renderSquareMaster(from image: CGImage) throws -> CGImage {
        let size = CGSize(width: masterSide, height: masterSide)
        let context = try makeContext(width: masterSide, height: masterSide)
        guard let subjectBounds = image.alphaBounds else {
            throw NSError(
                domain: "CanopyIconGenerator",
                code: 8,
                userInfo: [NSLocalizedDescriptionKey: "Isolated icon subject has no visible bounds"]
            )
        }

        context.interpolationQuality = .high
        context.setFillColor(backgroundColor.cgColor)
        context.fill(CGRect(origin: .zero, size: size))

        guard let croppedSubject = image.cropping(to: subjectBounds) else {
            throw NSError(
                domain: "CanopyIconGenerator",
                code: 9,
                userInfo: [NSLocalizedDescriptionKey: "Unable to crop icon subject"]
            )
        }

        let targetSubjectSize = CGFloat(masterSide) * 0.74
        let croppedWidth = CGFloat(croppedSubject.width)
        let croppedHeight = CGFloat(croppedSubject.height)
        let aspectRatio = croppedWidth / croppedHeight

        let drawSize: CGSize
        if aspectRatio > 1 {
            drawSize = CGSize(width: targetSubjectSize, height: targetSubjectSize / aspectRatio)
        } else {
            drawSize = CGSize(width: targetSubjectSize * aspectRatio, height: targetSubjectSize)
        }

        let drawRect = CGRect(
            x: (CGFloat(masterSide) - drawSize.width) / 2.0,
            y: (CGFloat(masterSide) - drawSize.height) / 2.0,
            width: drawSize.width,
            height: drawSize.height
        )

        context.draw(croppedSubject, in: drawRect)

        guard let output = context.makeImage() else {
            throw NSError(
                domain: "CanopyIconGenerator",
                code: 10,
                userInfo: [NSLocalizedDescriptionKey: "Unable to render square master icon"]
            )
        }

        return output
    }

    private func renderRoundedPublicIcon(from image: CGImage) throws -> CGImage {
        let size = CGSize(width: masterSide, height: masterSide)
        let context = try makeContext(width: masterSide, height: masterSide)
        let rect = CGRect(origin: .zero, size: size)
        let radius = CGFloat(masterSide) * cornerRadiusRatio

        context.interpolationQuality = .high
        context.setFillColor(backgroundColor.cgColor)
        context.fill(rect)

        let path = CGPath(
            roundedRect: rect,
            cornerWidth: radius,
            cornerHeight: radius,
            transform: nil
        )

        context.addPath(path)
        context.clip()
        context.draw(image, in: rect)

        guard let output = context.makeImage() else {
            throw NSError(
                domain: "CanopyIconGenerator",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Unable to render rounded public icon"]
            )
        }

        return output
    }

    private func makeContext(width: Int, height: Int) throws -> CGContext {
        guard
            let context = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else {
            throw NSError(
                domain: "CanopyIconGenerator",
                code: 11,
                userInfo: [NSLocalizedDescriptionKey: "Unable to allocate bitmap context"]
            )
        }

        return context
    }

    private func writePNG(_ image: CGImage, to url: URL) throws {
        let bitmapRep = NSBitmapImageRep(cgImage: image)
        guard let data = bitmapRep.representation(using: .png, properties: [:]) else {
            throw NSError(
                domain: "CanopyIconGenerator",
                code: 5,
                userInfo: [NSLocalizedDescriptionKey: "Unable to encode PNG for \(url.path)"]
            )
        }

        try data.write(to: url, options: .atomic)
    }
}

private extension CGImage {
    var alphaBounds: CGRect? {
        let width = self.width
        let height = self.height
        let bytesPerPixel = 4
        let bytesPerRow = width * bytesPerPixel
        var pixels = [UInt8](repeating: 0, count: height * bytesPerRow)

        guard
            let context = CGContext(
                data: &pixels,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else {
            return nil
        }

        context.draw(self, in: CGRect(x: 0, y: 0, width: width, height: height))

        var minX = width
        var minY = height
        var maxX = -1
        var maxY = -1

        for y in 0..<height {
            for x in 0..<width {
                let offset = y * bytesPerRow + x * bytesPerPixel + 3
                if pixels[offset] > 0 {
                    minX = min(minX, x)
                    minY = min(minY, y)
                    maxX = max(maxX, x)
                    maxY = max(maxY, y)
                }
            }
        }

        guard maxX >= minX, maxY >= minY else {
            return nil
        }

        return CGRect(
            x: minX,
            y: minY,
            width: maxX - minX + 1,
            height: maxY - minY + 1
        )
    }
}

let workingDirectory = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)

do {
    try IconGenerator(projectRoot: workingDirectory).run()
} catch {
    fputs("Icon generation failed: \(error.localizedDescription)\n", stderr)
    exit(1)
}

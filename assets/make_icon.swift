// Renders a clean, watermark-free flat app icon (1024x1024, transparent corners)
// using AppKit vector drawing. Output path is argv[1].
import AppKit

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.png"
let S = 1024
let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: S, pixelsHigh: S,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

func rgb(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> NSColor {
    NSColor(srgbRed: r/255, green: g/255, blue: b/255, alpha: a)
}

// ---- Tile (rounded square, transparent outside) ----
let inset: CGFloat = 96
let tileRect = NSRect(x: inset, y: inset, width: CGFloat(S) - inset*2, height: CGFloat(S) - inset*2)
let radius: CGFloat = 176
NSGraphicsContext.current!.cgContext.saveGState()
NSBezierPath(roundedRect: tileRect, xRadius: radius, yRadius: radius).addClip()

let grad = NSGradient(colors: [rgb(13,86,96), rgb(27,44,74)])!
grad.draw(in: tileRect, angle: 90)
let glow = NSGradient(colors: [rgb(60,220,225,0.20), rgb(60,220,225,0.0)])!
glow.draw(in: tileRect, relativeCenterPosition: NSPoint(x: 0, y: 0.28))

let cx: CGFloat = 512

// ---- Android head (dome with flat bottom) ----
let cy: CGFloat = 392            // flat-bottom y
let hr: CGFloat = 180            // head radius
let green = rgb(61,220,132)

let dome = NSBezierPath()
dome.move(to: NSPoint(x: cx - hr, y: cy))
dome.appendArc(withCenter: NSPoint(x: cx, y: cy), radius: hr, startAngle: 180, endAngle: 0, clockwise: true)
dome.line(to: NSPoint(x: cx + hr, y: cy))
dome.close()
green.setFill()
dome.fill()

// eyes
for ex in [cx - 80, cx + 80] {
    NSColor.white.setFill()
    NSBezierPath(ovalIn: NSRect(x: ex - 24, y: cy + 66, width: 48, height: 48)).fill()
}

// short antennae (tips well below the wifi fan)
let ant = NSBezierPath()
ant.lineWidth = 18
ant.lineCapStyle = .round
green.setStroke()
for (x0, y0, x1, y1) in [(cx-96, cy+hr-18, cx-126.0, cy+hr+40.0),
                         (cx+96, cy+hr-18, cx+126.0, cy+hr+40.0)] {
    ant.move(to: NSPoint(x: x0, y: y0))
    ant.line(to: NSPoint(x: x1, y: y1))
}
ant.stroke()

// ---- Compact, centered WiFi fan floating above the head ----
let dotY: CGFloat = 724
let cyan = rgb(52,225,232)
cyan.setFill()
NSBezierPath(ovalIn: NSRect(x: cx - 20, y: dotY - 20, width: 40, height: 40)).fill()

for rr in [60.0, 104.0, 148.0] {
    let arc = NSBezierPath()
    arc.lineWidth = 24
    arc.lineCapStyle = .round
    cyan.setStroke()
    arc.appendArc(withCenter: NSPoint(x: cx, y: dotY), radius: CGFloat(rr),
                  startAngle: 45, endAngle: 135, clockwise: false)
    arc.stroke()
}

NSGraphicsContext.current!.cgContext.restoreGState()
NSGraphicsContext.restoreGraphicsState()
let png = rep.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: outPath))
print("wrote \(outPath)")

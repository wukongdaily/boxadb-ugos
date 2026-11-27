// TV-themed app icon generator for BoxADB, following fnOS icon spec:
//   body = rounded rect ~95% of canvas, corner radius ~19%, transparent outside,
//   mid-high brightness, no drop shadow, glyph centered, readable at 64px.
// Usage: swiftc make_icon_tv.swift -o make_icon_tv
//        ./make_icon_tv <variant A|B> <output.png>
import AppKit

let variant = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "A"
let outPath = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "AppIcon_tv\(variant).png"

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

// ---- fnOS-spec body tile ----
let inset: CGFloat = 26                          // 2.5% padding per edge
let bodySide = CGFloat(S) - inset*2              // ~972 ≈ 95% of canvas
let tileRect = NSRect(x: inset, y: inset, width: bodySide, height: bodySide)
let bodyRadius = bodySide * 0.19                 // ~19% corner radius (fnOS system look)

let ctx = NSGraphicsContext.current!.cgContext
ctx.saveGState()
NSBezierPath(roundedRect: tileRect, xRadius: bodyRadius, yRadius: bodyRadius).addClip()

// Brighter gradient body (mid-high brightness, TV-friendly)
let bg = NSGradient(colors: [rgb(20,196,126), rgb(14,122,116)])!  // emerald → teal
bg.draw(in: tileRect, angle: 90)
// Subtle top highlight for depth (no drop shadow, per spec)
let topGlow = NSGradient(colors: [rgb(255,255,255,0.16), rgb(255,255,255,0.0)])!
topGlow.draw(in: tileRect, relativeCenterPosition: NSPoint(x: 0, y: 0.42))

let cx: CGFloat = 512

// ===========================================================================
// VARIANT A: 复古电视机 + 兔耳天线，屏幕内画小 WiFi 弧（TV 主导，无线作次要）
// ===========================================================================
func drawVariantA() {
    // TV outer body (light bezel)
    let tvW: CGFloat = 640, tvH: CGFloat = 490
    let tvBottom: CGFloat = 300
    let tvRect = NSRect(x: cx - tvW/2, y: tvBottom, width: tvW, height: tvH)
    let tvBezel = NSBezierPath(roundedRect: tvRect, xRadius: 54, yRadius: 54)
    rgb(243,248,246).setFill(); tvBezel.fill()

    // Screen (dark inset)
    let scrRect = NSRect(x: tvRect.minX + 46, y: tvRect.minY + 70,
                         width: tvW - 92, height: tvH - 70 - 46)
    let screen = NSBezierPath(roundedRect: scrRect, xRadius: 28, yRadius: 28)
    rgb(12,50,60).setFill(); screen.fill()

    // WiFi fan inside screen (subtle, secondary to TV shape)
    let scy = scrRect.midY
    let cyan = rgb(52,225,232)
    cyan.setFill()
    NSBezierPath(ovalIn: NSRect(x: cx - 16, y: scy - 40, width: 32, height: 32)).fill()
    for rr in [52.0, 92.0, 132.0] {
        let arc = NSBezierPath()
        arc.lineWidth = 22; arc.lineCapStyle = .round; cyan.setStroke()
        arc.appendArc(withCenter: NSPoint(x: cx, y: scy - 40), radius: CGFloat(rr),
                      startAngle: 45, endAngle: 135, clockwise: false)
        arc.stroke()
    }

    // Rabbit-ear antennas from TV top-center
    let ant = NSBezierPath()
    ant.lineWidth = 24; ant.lineCapStyle = .round; rgb(243,248,246).setStroke()
    let apexY = tvRect.maxY
    ant.move(to: NSPoint(x: cx, y: apexY)); ant.line(to: NSPoint(x: cx - 150, y: apexY + 160))
    ant.move(to: NSPoint(x: cx, y: apexY)); ant.line(to: NSPoint(x: cx + 150, y: apexY + 160))
    ant.stroke()
    for tx in [cx - 150, cx + 150] {
        NSBezierPath(ovalIn: NSRect(x: tx - 18, y: apexY + 142, width: 36, height: 36))
            .fill()
    }

    // Feet
    rgb(243,248,246).setFill()
    for fx in [cx - 170, cx + 170] {
        NSBezierPath(roundedRect: NSRect(x: fx - 26, y: tvBottom - 46, width: 52, height: 46),
                     xRadius: 12, yRadius: 12).fill()
    }
}

// ===========================================================================
// VARIANT B: 现代平板电视 + 中央底座，屏幕内画安卓机器人头（Android TV 语义）
// ===========================================================================
func drawVariantB() {
    // Flat TV bezel
    let tvW: CGFloat = 700, tvH: CGFloat = 440
    let tvBottom: CGFloat = 340
    let tvRect = NSRect(x: cx - tvW/2, y: tvBottom, width: tvW, height: tvH)
    let tvBezel = NSBezierPath(roundedRect: tvRect, xRadius: 34, yRadius: 34)
    rgb(243,248,246).setFill(); tvBezel.fill()

    let scrRect = NSRect(x: tvRect.minX + 34, y: tvRect.minY + 34,
                         width: tvW - 68, height: tvH - 68)
    let screen = NSBezierPath(roundedRect: scrRect, xRadius: 18, yRadius: 18)
    rgb(12,50,60).setFill(); screen.fill()

    // Android head inside screen
    let green = rgb(61,220,132)
    let hr: CGFloat = 120
    let hc = NSPoint(x: cx, y: scrRect.midY - hr*0.42)  // 视觉居中（机器人头向上生长，底边下移）
    let dome = NSBezierPath()
    dome.move(to: NSPoint(x: hc.x - hr, y: hc.y))
    dome.appendArc(withCenter: hc, radius: hr, startAngle: 180, endAngle: 0, clockwise: true)
    dome.line(to: NSPoint(x: hc.x + hr, y: hc.y)); dome.close()
    green.setFill(); dome.fill()
    for ex in [hc.x - 46, hc.x + 46] {
        NSColor.white.setFill()
        NSBezierPath(ovalIn: NSRect(x: ex - 12, y: hc.y + 38, width: 24, height: 24)).fill()
    }
    let aAnt = NSBezierPath()
    aAnt.lineWidth = 12; aAnt.lineCapStyle = .round; green.setStroke()
    for (x0,y0,x1,y1) in [(hc.x-58, hc.y+hr-8, hc.x-80, hc.y+hr+34),
                          (hc.x+58, hc.y+hr-8, hc.x+80, hc.y+hr+34)] {
        aAnt.move(to: NSPoint(x: x0, y: y0)); aAnt.line(to: NSPoint(x: x1, y: y1))
    }
    aAnt.stroke()

    // Stand: neck + base
    rgb(243,248,246).setFill()
    NSBezierPath(rect: NSRect(x: cx - 24, y: tvBottom - 60, width: 48, height: 60)).fill()
    NSBezierPath(roundedRect: NSRect(x: cx - 130, y: tvBottom - 84, width: 260, height: 30),
                 xRadius: 12, yRadius: 12).fill()
}

switch variant {
case "B": drawVariantB()
default:  drawVariantA()
}

ctx.restoreGState()
NSGraphicsContext.restoreGraphicsState()
let png = rep.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: outPath))
print("wrote \(outPath) (variant \(variant))")

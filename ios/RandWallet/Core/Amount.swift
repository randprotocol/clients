import Foundation

/// RAND amounts: 1 RAND = 10^9 units. Mirrors `randprotocol_core::{format_amount, parse_amount}`
/// so a UI row never needs a core call.
enum Amount {
    static let unitsPerRand: UInt64 = 1_000_000_000
    static let decimals = 9

    static func format(_ units: UInt64) -> String { format(units, decimals: decimals) }

    static func format(_ units: String) -> String { format(UInt64(units) ?? 0) }

    /// Units of an asset with `decimals` places (a token's own, from `rand_getTokens`: DUR has 6),
    /// trailing zeros dropped; at most `maxFraction` places shown, cut rather than rounded up.
    static func format(_ units: UInt64, decimals d: Int, maxFraction: Int? = nil) -> String {
        guard d > 0 else { return String(units) }
        var scale: UInt64 = 1
        for _ in 0..<min(d, 19) { scale *= 10 }
        let whole = units / scale
        let frac = units % scale
        var s = String(frac)
        s = String(repeating: "0", count: max(d - s.count, 0)) + s
        if let m = maxFraction, s.count > m { s = String(s.prefix(m)) }
        while s.hasSuffix("0") { s.removeLast() }
        return s.isEmpty ? String(whole) : "\(whole).\(s)"
    }

    /// "1.5" / ".25" / "3" → units. `nil` when it is not a RAND amount.
    static func parse(_ text: String) -> UInt64? { parse(text, decimals: decimals) }

    /// The same for an asset with `decimals` places.
    static func parse(_ text: String, decimals: Int) -> UInt64? {
        var unitsPerRand: UInt64 = 1
        for _ in 0..<min(max(decimals, 0), 19) { unitsPerRand *= 10 }
        let s = text.trimmingCharacters(in: .whitespaces)
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count <= 2 else { return nil }
        let wholeStr = parts.count > 0 ? String(parts[0]) : ""
        let fracStr = parts.count == 2 ? String(parts[1]) : ""
        if wholeStr.isEmpty && fracStr.isEmpty { return nil }
        if fracStr.count > decimals { return nil }
        let whole: UInt64
        if wholeStr.isEmpty { whole = 0 } else {
            guard let w = UInt64(wholeStr) else { return nil }
            whole = w
        }
        var frac: UInt64 = 0
        if !fracStr.isEmpty {
            guard let f = UInt64(fracStr + String(repeating: "0", count: decimals - fracStr.count)) else { return nil }
            frac = f
        }
        let (mul, o1) = whole.multipliedReportingOverflow(by: unitsPerRand)
        if o1 { return nil }
        let (sum, o2) = mul.addingReportingOverflow(frac)
        return o2 ? nil : sum
    }
}

extension String {
    /// `rand1abcd…wxyz` for addresses, `4f2c…e7` for hashes.
    func shortened(head: Int = 10, tail: Int = 6) -> String {
        guard count > head + tail + 1 else { return self }
        return "\(prefix(head))…\(suffix(tail))"
    }
}

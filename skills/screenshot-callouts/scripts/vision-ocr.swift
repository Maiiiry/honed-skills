// SPDX-License-Identifier: Apache-2.0
// The copyright holder is named in the LICENSE file of this skill.
// Purpose: word boxes from macOS Vision, for screenshot-callouts's text targets.
// Usage: vision-ocr IMG.png [lang1,lang2]   (compiled by `annotate.mjs setup`)
// Prints one TSV row per whitespace-separated token: line, confidence, x, y, w, h, text.
// Coordinates are image pixels with a TOP-LEFT origin: Vision's boxes are normalised with a
// bottom-left origin, so y is flipped here, once, against the image's pixel height.
import Foundation
import ImageIO
import Vision

let args = CommandLine.arguments
guard args.count > 1 else { FileHandle.standardError.write("usage: vision-ocr IMG.png [langs]\n".data(using: .utf8)!); exit(2) }
let url = URL(fileURLWithPath: args[1])
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { exit(3) }
let W = CGFloat(image.width)
let H = CGFloat(image.height)

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false // UI strings are not prose; correction rewrites them
if args.count > 2 { request.recognitionLanguages = args[2].split(separator: ",").map(String.init) }
do {
  try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
  exit(4)
}

var line = 0
for observation in request.results ?? [] {
  guard let candidate = observation.topCandidates(1).first else { continue }
  line += 1
  let s = candidate.string
  var i = s.startIndex
  while i < s.endIndex {
    while i < s.endIndex && s[i].isWhitespace { i = s.index(after: i) }
    var j = i
    while j < s.endIndex && !s[j].isWhitespace { j = s.index(after: j) }
    if i < j, let box = try? candidate.boundingBox(for: i..<j) {
      let r = box.boundingBox
      let x = r.minX * W
      let y = (1 - r.maxY) * H
      let token = String(s[i..<j]).replacingOccurrences(of: "\t", with: " ")
      print("\(line)\t\(candidate.confidence)\t\(x)\t\(y)\t\(r.width * W)\t\(r.height * H)\t\(token)")
    }
    i = j
  }
}

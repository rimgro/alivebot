"""Compile public Fortress noise loops in a small harness; never edit the source tree.

This checks the additional patch, not a complete Chromium build or release binary.
"""
import argparse
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--fortress-source", required=True, type=Path)
parser.add_argument("--compiler", default="clang++")
args = parser.parse_args()


def additions(name):
    return "\n".join(line[1:] for line in (args.fortress_source / "patches" / name).read_text().splitlines()
                     if line.startswith("+") and not line.startswith("+++"))


read_loop = additions("0020-third_party-blink-renderer-modules-canvas-canvas2d-base_rendering_context_2d-cc.patch")
read_loop = read_loop[read_loop.index("  // FORTRESS: seeded per-session canvas noise"):]
encode_loop = additions("0031-third_party-blink-renderer-platform-graphics-image_data_buffer-cc.patch")
encode_loop = encode_loop[encode_loop.index("namespace {"):]
encode_loop = encode_loop[:encode_loop.index("}  // namespace") + len("}  // namespace")]
common = r"""
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
#define UNSAFE_BUFFERS(value) value
enum SkColorType { kRGBA_8888_SkColorType, kBGRA_8888_SkColorType };
struct SkPixmap {
  uint8_t* bytes; SkColorType ct;
  int width() const { return 8; }
  int height() const { return 8; }
  size_t rowBytes() const { return 40; }
  SkColorType colorType() const { return ct; }
  void* writable_addr() const { return bytes; }
};
struct ImageData { SkPixmap pm; SkPixmap GetSkPixmap() { return pm; } };
namespace base {
uint32_t seed = 1;
bool StringToUint(const std::string& text, uint32_t* result) {
  *result = static_cast<uint32_t>(std::stoul(text)); return true;
}
struct UxrConfig {
  static UxrConfig& GetInstance() { static UxrConfig config; return config; }
  std::string Get(const char*) { return std::to_string(seed); }
};
}
"""
main = r"""
int main(int argc, char**) {
  uint64_t opaque_hash = 0;
  for (uint32_t seed = 1; seed <= 50; ++seed) {
    base::seed = seed;
    for (auto ct : {kRGBA_8888_SkColorType, kBGRA_8888_SkColorType}) {
      std::vector<uint8_t> source(8 * 40, 0xee);
      for (int y = 0; y < 8; ++y) for (int x = 0; x < 8; ++x) {
        const int offset = y * 40 + x * 4;
        source[offset] = 100; source[offset + 1] = 120;
        source[offset + 2] = 140; source[offset + 3] = 255;
      }
      auto read = source, encoded = source;
      NoiseRead({read.data(), ct}); UxrNoiseEncodeBuffer({encoded.data(), ct});
      if (read != encoded) { std::cerr << "Opaque read/encode mismatch\n"; return 2; }
      for (auto value : read) opaque_hash = opaque_hash * 31 + value;
      if (argc > 1) continue;
      for (int y = 0; y < 8; ++y) for (int x = 0; x < 8; ++x) {
        const int offset = y * 40 + x * 4;
        std::fill(source.begin() + offset, source.begin() + offset + 4, 0);
      }
      read = source; encoded = source;
      NoiseRead({read.data(), ct}); UxrNoiseEncodeBuffer({encoded.data(), ct});
      if (read != source || encoded != source) {
        std::cerr << "Transparent pixels modified (seed " << seed << ")\n"; return 1;
      }
      // Mixed transparent, semitransparent and opaque pixels, with row padding.
      for (int y = 0; y < 8; ++y) for (int x = 1; x < 8; x += 2) {
        const int offset = y * 40 + x * 4;
        source[offset] = 90; source[offset + 1] = 110;
        source[offset + 2] = 130; source[offset + 3] = x == 1 ? 128 : 255;
      }
      read = source; encoded = source;
      NoiseRead({read.data(), ct}); UxrNoiseEncodeBuffer({encoded.data(), ct});
      if (read != encoded) { std::cerr << "Mixed read/encode mismatch\n"; return 3; }
      for (int y = 0; y < 8; ++y) for (int x = 0; x < 8; ++x) {
        const int offset = y * 40 + x * 4;
        if (read[offset + 3] != source[offset + 3]) return 4;
        if (!source[offset + 3] && !std::equal(source.begin() + offset, source.begin() + offset + 4, read.begin() + offset)) return 5;
      }
      for (int y = 0; y < 8; ++y) for (int x = 32; x < 40; ++x)
        if (read[y * 40 + x] != 0xee) return 6;
    }
  }
  std::cout << opaque_hash << '\n';
}
"""

with tempfile.TemporaryDirectory(prefix="alive-fortress-patch-") as directory:
    root = Path(directory)
    read_path = root / "third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc"
    encode_path = root / "third_party/blink/renderer/platform/graphics/image_data_buffer.cc"
    for file in (read_path, encode_path):
        file.parent.mkdir(parents=True, exist_ok=True)
    read_path.write_text("void NoiseRead(SkPixmap pm) {\nImageData data{pm}; ImageData* image_data = &data; int sx = 0, sy = 0;\n" + read_loop + "\n}\n")
    encode_path.write_text(encode_loop + "\n")
    program = root / "test.cc"
    program.write_text(common + f'\n#include "{read_path}"\n#include "{encode_path}"\n' + main)
    binary = root / "test"

    def compile_harness():
        subprocess.run([args.compiler, "-std=c++17", "-O2", str(program), "-o", str(binary)], check=True)

    compile_harness()
    opaque_before = subprocess.check_output([str(binary), "opaque-only"])
    before = subprocess.run([str(binary)], capture_output=True, text=True)
    if before.returncode != 1 or "Transparent pixels modified" not in before.stderr:
        raise SystemExit("Expected transparent-pixel regression was not reproduced; inspect this Fortress version before applying the patch.")
    patch = Path(__file__).with_name("transparent-pixel.patch").resolve()
    subprocess.run(["git", "apply", "--check", str(patch)], cwd=root, check=True)
    subprocess.run(["git", "apply", str(patch)], cwd=root, check=True)
    compile_harness()
    subprocess.run([str(binary)], check=True, capture_output=True)
    if subprocess.check_output([str(binary), "opaque-only"]) != opaque_before:
        raise SystemExit("Patch changed the opaque-pixel algorithm")
    print("Canvas patch verified: original regression reproduced; RGBA/BGRA transparency, row padding, mixed alpha and read/encode coherence pass for 50 seeds; opaque output unchanged.")

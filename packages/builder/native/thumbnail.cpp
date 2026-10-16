// Optional build-time codec. No browser viewer code is linked into this tool.
#include <avif/avif.h>
#include <ultrahdr_api.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
struct Unsupported : std::runtime_error {
  using std::runtime_error::runtime_error;
};
struct NoGainMap {};
struct Image {
  uint32_t width, height;
  avifColorPrimaries primaries;
  std::vector<float> pixels; // RGB, linear light, SDR white = 1 (203 nits).
};

void check(avifResult result) {
  if (result != AVIF_RESULT_OK)
    throw std::runtime_error(avifResultToString(result));
}
void check(uhdr_error_info_t result) {
  if (result.error_code != UHDR_CODEC_OK)
    throw std::runtime_error(result.has_detail ? result.detail : "Ultra HDR codec failed");
}
float fromHalf(uint16_t h) {
  const int exponent = (h >> 10) & 31;
  const float fraction = h & 1023;
  float value = exponent == 0    ? std::ldexp(fraction, -24)
                : exponent == 31 ? INFINITY
                                 : std::ldexp(1024 + fraction, exponent - 25);
  return (h & 0x8000) ? -value : value;
}
uint16_t toHalf(float f) {
  if (!std::isfinite(f) || f < 0 || f > 65504)
    throw std::runtime_error("Invalid linear pixel");
  if (f < std::ldexp(1.0f, -14))
    return static_cast<uint16_t>(std::lround(std::ldexp(f, 24)));
  int exponent;
  float fraction = std::frexp(f, &exponent);
  return static_cast<uint16_t>(((exponent + 14) << 10) + std::lround((fraction * 2 - 1) * 1024));
}
float linear(float v) { return v <= 0.04045f ? v / 12.92f : std::pow((v + 0.055f) / 1.055f, 2.4f); }
float srgb(float v) {
  return v <= 0.0031308f ? v * 12.92f : 1.055f * std::pow(v, 1 / 2.4f) - 0.055f;
}
float pqDecode(float v) {
  const double p = std::pow(v, 32.0 / 2523);
  return float(std::pow(std::max(p - 3424.0 / 4096, 0.0) / (2413.0 / 128 - 2392.0 / 128 * p),
                        16384.0 / 2610) *
               (10000.0 / 203));
}
float pqEncode(float v) {
  const double p = std::pow(std::max(double(v), 0.0) * 203 / 10000, 2610.0 / 16384);
  return float(std::pow((3424.0 / 4096 + 2413.0 / 128 * p) / (1 + 2392.0 / 128 * p), 2523.0 / 32));
}
void dimensions(uint32_t w, uint32_t h, uint64_t limit) {
  if (!w || !h || uint64_t(w) * h > limit)
    throw std::runtime_error("Input pixel limit exceeded");
}
avifColorPrimaries primaries(uhdr_color_gamut_t cg) {
  switch (cg) {
  case UHDR_CG_BT_709:
    return AVIF_COLOR_PRIMARIES_BT709;
  case UHDR_CG_DISPLAY_P3:
    return AVIF_COLOR_PRIMARIES_SMPTE432;
  case UHDR_CG_BT_2100:
    return AVIF_COLOR_PRIMARIES_BT2020;
  default:
    throw Unsupported("Unknown JPEG colour gamut");
  }
}
uhdr_color_gamut_t gamut(avifColorPrimaries cp) {
  switch (cp) {
  case AVIF_COLOR_PRIMARIES_BT709:
    return UHDR_CG_BT_709;
  case AVIF_COLOR_PRIMARIES_SMPTE432:
    return UHDR_CG_DISPLAY_P3;
  case AVIF_COLOR_PRIMARIES_BT2020:
    return UHDR_CG_BT_2100;
  default:
    throw Unsupported("Only BT.709, Display P3 and BT.2020 are supported");
  }
}

// Apply the same geometry to the fully reconstructed SDR and HDR renditions.
Image orient(const Image &src, int orientation) {
  const bool swap = orientation >= 5;
  Image dst{swap ? src.height : src.width, swap ? src.width : src.height, src.primaries, {}};
  dst.pixels.resize(src.pixels.size());
  for (uint32_t y = 0; y < src.height; ++y)
    for (uint32_t x = 0; x < src.width; ++x) {
      uint32_t dx = x, dy = y;
      switch (orientation) {
      case 2:
        dx = src.width - 1 - x;
        break;
      case 3:
        dx = src.width - 1 - x;
        dy = src.height - 1 - y;
        break;
      case 4:
        dy = src.height - 1 - y;
        break;
      case 5:
        dx = y;
        dy = x;
        break;
      case 6:
        dx = src.height - 1 - y;
        dy = x;
        break;
      case 7:
        dx = src.height - 1 - y;
        dy = src.width - 1 - x;
        break;
      case 8:
        dx = y;
        dy = src.width - 1 - x;
        break;
      }
      std::copy_n(&src.pixels[(size_t(y) * src.width + x) * 3], 3,
                  &dst.pixels[(size_t(dy) * dst.width + dx) * 3]);
    }
  return dst;
}
Image transform(Image src, const avifImage *metadata) {
  if (metadata->transformFlags & AVIF_TRANSFORM_CLAP) {
    avifCropRect rect;
    avifDiagnostics diag{};
    if (!avifCropRectConvertCleanApertureBox(&rect, &metadata->clap, src.width, src.height,
                                             metadata->yuvFormat, &diag))
      throw Unsupported("Unsupported clean aperture");
    Image cropped{rect.width, rect.height, src.primaries, {}};
    cropped.pixels.resize(size_t(rect.width) * rect.height * 3);
    for (uint32_t y = 0; y < rect.height; ++y)
      std::copy_n(&src.pixels[(size_t(y + rect.y) * src.width + rect.x) * 3],
                  size_t(rect.width) * 3, &cropped.pixels[size_t(y) * rect.width * 3]);
    src = std::move(cropped);
  }
  if (metadata->transformFlags & AVIF_TRANSFORM_IROT) {
    const int orientations[] = {1, 8, 3, 6};
    src = orient(src, orientations[metadata->irot.angle]);
  }
  if (metadata->transformFlags & AVIF_TRANSFORM_IMIR)
    src = orient(src, metadata->imir.axis == 0 ? 4 : 2);
  return src;
}

Image avifRendition(const avifImage *src, float headroom,
                    avifColorPrimaries outputPrimaries = AVIF_COLOR_PRIMARIES_UNSPECIFIED) {
  if (outputPrimaries == AVIF_COLOR_PRIMARIES_UNSPECIFIED)
    outputPrimaries = src->colorPrimaries;
  avifRGBImage rgb;
  avifRGBImageSetDefaults(&rgb, src);
  rgb.format = AVIF_RGB_FORMAT_RGB;
  rgb.depth = 16;
  rgb.isFloat = AVIF_FALSE;
  std::vector<uint16_t> pixels(size_t(src->width) * src->height * 3);
  rgb.pixels = reinterpret_cast<uint8_t *>(pixels.data());
  rgb.rowBytes = src->width * 6;
  avifDiagnostics diag{};
  // libavif applies the gain map in its signalled working space, then converts.
  // Thumbnails retain the base gamut; analysis requests BT.2020 for HDR luminance.
  check(avifImageApplyGainMap(src, src->gainMap, headroom, outputPrimaries,
                              headroom > 0 ? AVIF_TRANSFER_CHARACTERISTICS_PQ
                                           : AVIF_TRANSFER_CHARACTERISTICS_SRGB,
                              &rgb, nullptr, &diag));
  Image result{src->width, src->height, outputPrimaries, {}};
  result.pixels.reserve(pixels.size());
  for (uint16_t v : pixels) {
    float f = headroom > 0 ? pqDecode(v / 65535.0f) : linear(v / 65535.0f);
    if (!std::isfinite(f))
      throw std::runtime_error("Non-finite AVIF rendition");
    result.pixels.push_back(std::max(0.0f, f));
  }
  return transform(std::move(result), src);
}
std::pair<Image, Image>
decodeAvif(const std::vector<uint8_t> &input, uint64_t limit, bool &allowSdrFallback,
           avifColorPrimaries hdrPrimaries = AVIF_COLOR_PRIMARIES_UNSPECIFIED) {
  auto decoder = std::unique_ptr<avifDecoder, decltype(&avifDecoderDestroy)>(avifDecoderCreate(),
                                                                             avifDecoderDestroy);
  if (!decoder)
    throw std::bad_alloc();
  decoder->maxThreads = 1;
  decoder->imageSizeLimit = static_cast<uint32_t>(std::min<uint64_t>(limit, UINT32_MAX));
  decoder->imageContentToDecode = AVIF_IMAGE_CONTENT_ALL;
  check(avifDecoderSetIOMemory(decoder.get(), input.data(), input.size()));
  check(avifDecoderParse(decoder.get()));
  const avifImage *src = decoder->image;
  // Sharp fallback is safe only when the primary image has a known SDR transfer.
  // An unsupported HDR primary must not silently become the SDR thumbnail.
  allowSdrFallback = src->transferCharacteristics == AVIF_TRANSFER_CHARACTERISTICS_SRGB ||
                     src->transferCharacteristics == AVIF_TRANSFER_CHARACTERISTICS_BT709;
  dimensions(src->width, src->height, limit);
  if (decoder->imageCount != 1)
    throw Unsupported("Animated AVIF is not supported");
  if (!src->gainMap) {
    if (src->transferCharacteristics == AVIF_TRANSFER_CHARACTERISTICS_PQ ||
        src->transferCharacteristics == AVIF_TRANSFER_CHARACTERISTICS_HLG)
      throw std::runtime_error("HDR AVIF without a gain map has no authored SDR fallback");
    throw NoGainMap{};
  }
  if (src->icc.size || src->gainMap->altICC.size) {
    if (src->gainMap->baseHdrHeadroom.n != 0)
      throw std::runtime_error("Cannot safely recover SDR from an ICC HDR-base AVIF");
    throw Unsupported("ICC AVIF gain maps require colour-managed decoding");
  }
  if (decoder->alphaPresent)
    throw Unsupported("AVIF gain maps with alpha are not supported");
  if ((src->transformFlags & AVIF_TRANSFORM_PASP) && src->pasp.hSpacing != src->pasp.vSpacing)
    throw Unsupported("Non-square AVIF pixels are not supported");
  gamut(src->colorPrimaries);
  const auto capacity = src->gainMap->alternateHdrHeadroom;
  const auto baseCapacity = src->gainMap->baseHdrHeadroom;
  if (!capacity.d || !baseCapacity.d)
    throw std::runtime_error("Invalid AVIF headroom");
  check(avifDecoderNextImage(decoder.get()));
  return {avifRendition(src, 0),
          avifRendition(
              src, std::max(float(capacity.n) / capacity.d, float(baseCapacity.n) / baseCapacity.d),
              hdrPrimaries)};
}
Image decodeJpeg(std::vector<uint8_t> &input, bool hdr, uint64_t limit, int orientation) {
  auto decoder = std::unique_ptr<uhdr_codec_private_t, decltype(&uhdr_release_decoder)>(
      uhdr_create_decoder(), uhdr_release_decoder);
  if (!decoder)
    throw std::bad_alloc();
  uhdr_compressed_image_t compressed{input.data(),        input.size(),        input.size(),
                                     UHDR_CG_UNSPECIFIED, UHDR_CT_UNSPECIFIED, UHDR_CR_UNSPECIFIED};
  check(uhdr_dec_set_image(decoder.get(), &compressed));
  check(uhdr_dec_set_out_img_format(decoder.get(), hdr ? UHDR_IMG_FMT_64bppRGBAHalfFloat
                                                       : UHDR_IMG_FMT_32bppRGBA8888));
  check(uhdr_dec_set_out_color_transfer(decoder.get(), hdr ? UHDR_CT_LINEAR : UHDR_CT_SRGB));
  check(uhdr_dec_probe(decoder.get()));
  dimensions(uhdr_dec_get_image_width(decoder.get()), uhdr_dec_get_image_height(decoder.get()),
             limit);
  check(uhdr_decode(decoder.get()));
  const auto *raw = uhdr_get_decoded_image(decoder.get());
  if (!raw)
    throw std::runtime_error("Missing JPEG rendition");
  Image result{raw->w, raw->h, primaries(raw->cg), {}};
  result.pixels.resize(size_t(raw->w) * raw->h * 3);
  for (uint32_t y = 0; y < raw->h; ++y)
    for (uint32_t x = 0; x < raw->w; ++x)
      for (int c = 0; c < 3; ++c) {
        const size_t index = (size_t(y) * raw->stride[0] + x) * 4 + c;
        float value = hdr ? fromHalf(static_cast<uint16_t *>(raw->planes[0])[index])
                          : linear(static_cast<uint8_t *>(raw->planes[0])[index] / 255.0f);
        if (!std::isfinite(value))
          throw std::runtime_error("Non-finite JPEG rendition");
        result.pixels[(size_t(y) * raw->w + x) * 3 + c] = std::max(0.0f, value);
      }
  return orient(result, orientation);
}

// Exact area integration in linear light. Resizing the encoded gain map alone
// does not preserve the relationship between the two resized renditions.
Image resize(const Image &src, uint32_t width, uint32_t height) {
  Image dst{width, height, src.primaries, std::vector<float>(size_t(width) * height * 3)};
  for (uint32_t y = 0; y < height; ++y)
    for (uint32_t x = 0; x < width; ++x) {
      const double x0 = double(x) * src.width / width, x1 = double(x + 1) * src.width / width;
      const double y0 = double(y) * src.height / height, y1 = double(y + 1) * src.height / height;
      double sums[3] = {};
      for (uint32_t sy = uint32_t(y0); sy < std::ceil(y1) && sy < src.height; ++sy)
        for (uint32_t sx = uint32_t(x0); sx < std::ceil(x1) && sx < src.width; ++sx) {
          const double weight = (std::min(x1, double(sx + 1)) - std::max(x0, double(sx))) *
                                (std::min(y1, double(sy + 1)) - std::max(y0, double(sy)));
          for (int c = 0; c < 3; ++c)
            sums[c] += src.pixels[(size_t(sy) * src.width + sx) * 3 + c] * weight;
        }
      for (int c = 0; c < 3; ++c)
        dst.pixels[(size_t(y) * width + x) * 3 + c] = float(sums[c] / ((x1 - x0) * (y1 - y0)));
    }
  return dst;
}
std::vector<uint16_t> encodedPixels(const Image &image, bool encodeSrgb) {
  std::vector<uint16_t> out;
  out.reserve(image.pixels.size());
  for (float v : image.pixels)
    out.push_back(static_cast<uint16_t>(
        std::lround(std::clamp(encodeSrgb ? srgb(v) : pqEncode(v), 0.0f, 1.0f) * 65535)));
  return out;
}
avifRGBImage rgbImage(const Image &image, std::vector<uint16_t> &pixels) {
  avifRGBImage rgb{};
  rgb.width = image.width;
  rgb.height = image.height;
  rgb.depth = 16;
  rgb.format = AVIF_RGB_FORMAT_RGB;
  rgb.isFloat = AVIF_FALSE;
  rgb.chromaDownsampling = AVIF_CHROMA_DOWNSAMPLING_BEST_QUALITY;
  rgb.pixels = reinterpret_cast<uint8_t *>(pixels.data());
  rgb.rowBytes = image.width * 6;
  return rgb;
}
void writeFile(const std::string &path, const void *data, size_t size) {
  std::ofstream stream(path, std::ios::binary);
  stream.write(static_cast<const char *>(data), size);
  if (!stream)
    throw std::runtime_error("Cannot write thumbnail");
}
void encodeAvif(const Image &sdr, const Image &hdr, int quality, int gainQuality,
                const std::string &output) {
  auto base = std::unique_ptr<avifImage, decltype(&avifImageDestroy)>(
      avifImageCreate(sdr.width, sdr.height, 10, AVIF_PIXEL_FORMAT_YUV444), avifImageDestroy);
  if (!base)
    throw std::bad_alloc();
  base->colorPrimaries = sdr.primaries;
  base->transferCharacteristics = AVIF_TRANSFER_CHARACTERISTICS_SRGB;
  base->matrixCoefficients = AVIF_MATRIX_COEFFICIENTS_BT601;
  base->yuvRange = AVIF_RANGE_FULL;
  auto sdrPixels = encodedPixels(sdr, true), hdrPixels = encodedPixels(hdr, false);
  auto baseRgb = rgbImage(sdr, sdrPixels), altRgb = rgbImage(hdr, hdrPixels);
  check(avifImageRGBToYUV(base.get(), &baseRgb));
  base->gainMap = avifGainMapCreate();
  if (!base->gainMap)
    throw std::bad_alloc();
  base->gainMap->image = avifImageCreate(sdr.width, sdr.height, 8, AVIF_PIXEL_FORMAT_YUV444);
  if (!base->gainMap->image)
    throw std::bad_alloc();
  avifDiagnostics diag{};
  check(avifRGBImageComputeGainMap(&baseRgb, sdr.primaries, AVIF_TRANSFER_CHARACTERISTICS_SRGB,
                                   &altRgb, hdr.primaries, AVIF_TRANSFER_CHARACTERISTICS_PQ,
                                   base->gainMap, &diag));
  base->gainMap->altColorPrimaries = hdr.primaries;
  base->gainMap->altTransferCharacteristics = AVIF_TRANSFER_CHARACTERISTICS_PQ;
  base->gainMap->altMatrixCoefficients = AVIF_MATRIX_COEFFICIENTS_BT601;
  base->gainMap->altYUVRange = AVIF_RANGE_FULL;
  base->gainMap->altDepth = 10;
  base->gainMap->altPlaneCount = 3;
  auto encoder = std::unique_ptr<avifEncoder, decltype(&avifEncoderDestroy)>(avifEncoderCreate(),
                                                                             avifEncoderDestroy);
  if (!encoder)
    throw std::bad_alloc();
  encoder->maxThreads = 1;
  encoder->speed = 6;
  encoder->quality = quality;
  encoder->qualityGainMap = gainQuality;
  avifRWData encoded = AVIF_DATA_EMPTY;
  const auto result = avifEncoderWrite(encoder.get(), base.get(), &encoded);
  if (result != AVIF_RESULT_OK) {
    avifRWDataFree(&encoded);
    check(result);
  }
  try {
    writeFile(output, encoded.data, encoded.size);
  } catch (...) {
    avifRWDataFree(&encoded);
    throw;
  }
  avifRWDataFree(&encoded);
}
void encodeJpeg(const Image &sdr, const Image &hdr, int quality, int gainQuality,
                const std::string &output) {
  std::vector<uint8_t> base(size_t(sdr.width) * sdr.height * 4, 255);
  std::vector<uint16_t> alternate(base.size(), toHalf(1));
  float peak = 1;
  for (size_t i = 0; i < sdr.pixels.size(); ++i) {
    const size_t index = i / 3 * 4 + i % 3;
    base[index] =
        static_cast<uint8_t>(std::lround(std::clamp(srgb(sdr.pixels[i]), 0.0f, 1.0f) * 255));
    alternate[index] = toHalf(hdr.pixels[i]);
    peak = std::max(peak, hdr.pixels[i]);
  }
  uhdr_raw_image_t sdrRaw{UHDR_IMG_FMT_32bppRGBA8888,
                          gamut(sdr.primaries),
                          UHDR_CT_SRGB,
                          UHDR_CR_FULL_RANGE,
                          sdr.width,
                          sdr.height,
                          {base.data(), nullptr, nullptr},
                          {sdr.width, 0, 0}};
  uhdr_raw_image_t hdrRaw{UHDR_IMG_FMT_64bppRGBAHalfFloat,
                          gamut(hdr.primaries),
                          UHDR_CT_LINEAR,
                          UHDR_CR_FULL_RANGE,
                          hdr.width,
                          hdr.height,
                          {alternate.data(), nullptr, nullptr},
                          {hdr.width, 0, 0}};
  auto encoder = std::unique_ptr<uhdr_codec_private_t, decltype(&uhdr_release_encoder)>(
      uhdr_create_encoder(), uhdr_release_encoder);
  if (!encoder)
    throw std::bad_alloc();
  check(uhdr_enc_set_raw_image(encoder.get(), &sdrRaw, UHDR_SDR_IMG));
  check(uhdr_enc_set_raw_image(encoder.get(), &hdrRaw, UHDR_HDR_IMG));
  check(uhdr_enc_set_quality(encoder.get(), quality, UHDR_BASE_IMG));
  check(uhdr_enc_set_quality(encoder.get(), gainQuality, UHDR_GAIN_MAP_IMG));
  check(uhdr_enc_set_gainmap_scale_factor(encoder.get(), 1));
  check(uhdr_enc_set_using_multi_channel_gainmap(encoder.get(), 1));
  check(uhdr_enc_set_target_display_peak_brightness(encoder.get(),
                                                    std::clamp(peak * 203, 203.0f, 10000.0f)));
  check(uhdr_encode(encoder.get()));
  const auto *encoded = uhdr_get_encoded_stream(encoder.get());
  if (!encoded)
    throw std::runtime_error("Missing JPEG output");
  writeFile(output, encoded->data, encoded->data_sz);
}
#include "analysis.h"
} // namespace

int main(int argc, char **argv) {
  bool allowSdrFallback = true;
  try {
    if (argc == 2 &&
        (std::string(argv[1]) == "--version" || std::string(argv[1]) == "--analysis-version")) {
      char codecs[256];
      avifCodecVersions(codecs);
      const bool analysisVersion = std::string(argv[1]) == "--analysis-version";
      std::cout << (analysisVersion ? "afilmory-image-analysis/1 " : "afilmory-hdr-thumbnail/1 ")
                << CODEC_REVISION << (analysisVersion ? ANALYSIS_REVISION : "") << " libavif/"
                << avifVersion() << " libultrahdr/" << UHDR_LIB_VERSION_STR << ' ' << codecs
                << '\n';
      return 0;
    }
    const bool analysis = argc == 6 && std::string(argv[1]) == "--analyze";
    if (analysis) {
      const uint64_t limit = std::stoull(argv[3]);
      const int orientation = std::stoi(argv[4]);
      if (!limit || orientation < 1 || orientation > 8 || std::string(argv[5]) != "v1")
        throw std::runtime_error("Invalid analysis arguments");
      std::ifstream stream(argv[2], std::ios::binary | std::ios::ate);
      if (!stream || stream.tellg() > 512 * 1024 * 1024)
        throw std::runtime_error("Cannot read analysis input or input exceeds 512 MiB");
      stream.seekg(0);
      std::vector<uint8_t> input((std::istreambuf_iterator<char>(stream)), {});
      analyze(input, limit, orientation);
      return 0;
    }
    if (argc != 9)
      throw std::runtime_error("Usage: afilmory-hdr-thumbnail input output jpeg|avif width quality "
                               "gainQuality pixelLimit orientation");
    const std::string format = argv[3];
    const int width = std::stoi(argv[4]), quality = std::stoi(argv[5]),
              gainQuality = std::stoi(argv[6]), orientation = std::stoi(argv[8]);
    const uint64_t limit = std::stoull(argv[7]);
    if ((format != "jpeg" && format != "avif") || width < 2 || width > 4096 || quality < 1 ||
        quality > 100 || gainQuality < 1 || gainQuality > 100 || orientation < 1 ||
        orientation > 8 || !limit)
      throw std::runtime_error("Invalid thumbnail arguments");
    std::ifstream stream(argv[1], std::ios::binary | std::ios::ate);
    if (!stream)
      throw std::runtime_error("Cannot read input");
    if (stream.tellg() > 512 * 1024 * 1024)
      throw std::runtime_error("Input exceeds 512 MiB");
    stream.seekg(0);
    std::vector<uint8_t> input((std::istreambuf_iterator<char>(stream)), {});
    avifROData view{input.data(), input.size()};
    std::pair<Image, Image> images;
    if (avifPeekCompatibleFileType(&view)) {
      allowSdrFallback = false;
      images = decodeAvif(input, limit, allowSdrFallback);
    } else if (input.size() > 2 && input[0] == 255 && input[1] == 216) {
      if (!is_uhdr_image(input.data(), static_cast<int>(input.size())))
        throw NoGainMap{};
      images = {decodeJpeg(input, false, limit, orientation),
                decodeJpeg(input, true, limit, orientation)};
    } else {
      throw Unsupported("HDR thumbnails currently accept JPEG and AVIF gain maps");
    }
    auto &sdr = images.first;
    auto &hdr = images.second;
    if (sdr.width != hdr.width || sdr.height != hdr.height)
      throw std::runtime_error("Rendition dimensions differ");
    // libultrahdr requires even dimensions. Share geometry between both formats.
    uint32_t w = std::min<uint32_t>(width, sdr.width) / 2 * 2;
    uint32_t h = std::min(sdr.height / 2 * 2,
                          uint32_t(std::lround(double(sdr.height) * w / sdr.width / 2)) * 2);
    if (w < 2 || h < 2)
      throw Unsupported("Image too small for a gain-map thumbnail");
    sdr = resize(sdr, w, h);
    hdr = resize(hdr, w, h);
    if (format == "avif")
      encodeAvif(sdr, hdr, quality, gainQuality, argv[2]);
    else
      encodeJpeg(sdr, hdr, quality, gainQuality, argv[2]);
    std::cout << "{\"width\":" << w << ",\"height\":" << h << "}\n";
    return 0;
  } catch (const NoGainMap &) {
    return 3;
  } catch (const Unsupported &error) {
    std::cerr << error.what() << '\n';
    if (!allowSdrFallback)
      std::cerr << "Cannot safely fall back to the AVIF primary as SDR\n";
    return allowSdrFallback ? 2 : 1;
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}

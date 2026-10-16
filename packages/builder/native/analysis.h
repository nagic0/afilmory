// Included after the shared native decoder; analysis always precedes resizing.
void writeColor(std::ostream &out, avifColorPrimaries cp, avifTransferCharacteristics tc, int depth,
                const char *source) {
  out << "{\"source\":\"" << source << "\",\"primaries\":" << cp << ",\"transfer\":" << tc
      << ",\"bitDepth\":" << depth << '}';
}

void writeSdrHistogram(std::ostream &out, const Image &image) {
  std::vector<uint64_t> bins[4];
  for (auto &channel : bins)
    channel.resize(256);
  // Linear base RGB -> linear sRGB, before transfer encoding and clipping.
  const double p3[9] = {1.224940176,  -0.224940176, 0,          -0.042056955, 1.042056955, 0,
                        -0.019637555, -0.078636046, 1.098273601};
  const double bt2020[9] = {1.660491002,  -0.587641139, -0.072849863, -0.124550475, 1.132899897,
                            -0.008349423, -0.018150763, -0.100578898, 1.118729661};
  const double *matrix = image.primaries == AVIF_COLOR_PRIMARIES_SMPTE432 ? p3 : bt2020;
  for (size_t i = 0; i < image.pixels.size(); i += 3) {
    int encoded[3];
    for (int c = 0; c < 3; ++c) {
      double value = image.pixels[i + c];
      if (image.primaries != AVIF_COLOR_PRIMARIES_BT709)
        value = matrix[c * 3] * image.pixels[i] + matrix[c * 3 + 1] * image.pixels[i + 1] +
                matrix[c * 3 + 2] * image.pixels[i + 2];
      encoded[c] = std::lround(srgb(std::clamp(value, 0.0, 1.0)) * 255);
      ++bins[c][encoded[c]];
    }
    ++bins[3][std::lround(.2126 * encoded[0] + .7152 * encoded[1] + .0722 * encoded[2])];
  }
  const char *names[] = {"red", "green", "blue", "luminance"};
  const double count = image.pixels.size() / 3;
  out << '{';
  for (int c = 0; c < 4; ++c) {
    if (c)
      out << ',';
    out << '"' << names[c] << "\":[";
    for (int i = 0; i < 256; ++i) {
      if (i)
        out << ',';
      out << bins[c][i] / count;
    }
    out << ']';
  }
  out << '}';
}

void writeHdrHistogram(std::ostream &out, const Image &image, double headroom) {
  const double p3[] = {.228974564, .691738522, .079286914};
  const double bt2020[] = {.262700212, .677998072, .059301716};
  const double bt709[] = {.2126, .7152, .0722};
  const double *weights = image.primaries == AVIF_COLOR_PRIMARIES_SMPTE432 ? p3
                          : image.primaries == AVIF_COLOR_PRIMARIES_BT2020 ? bt2020
                                                                           : bt709;
  std::vector<float> values;
  values.reserve(image.pixels.size() / 3);
  double peak = 0;
  size_t above = 0;
  for (size_t i = 0; i < image.pixels.size(); i += 3) {
    double y = weights[0] * image.pixels[i] + weights[1] * image.pixels[i + 1] +
               weights[2] * image.pixels[i + 2];
    if (!std::isfinite(y) || y < 0)
      throw std::runtime_error("Invalid HDR luminance");
    values.push_back(y);
    peak = std::max(peak, y);
    above += y > 1;
  }
  const int minStops = -12, maxStops = std::max(3, int(std::ceil(std::log2(std::max(peak, 1.0)))));
  std::vector<uint64_t> bins(256);
  for (float y : values) {
    const double stops = y > 0 ? std::log2(y) : minStops;
    const int bin =
        std::clamp(int(std::floor((stops - minStops) / (maxStops - minStops) * 256)), 0, 255);
    ++bins[bin];
  }
  auto percentile = [&](double fraction) {
    const size_t index = size_t(std::ceil(fraction * values.size())) - 1;
    std::nth_element(values.begin(), values.begin() + index, values.end());
    return values[index];
  };
  out << "{\"minStops\":" << minStops << ",\"maxStops\":" << maxStops
      << ",\"pixelCount\":" << values.size()
      << ",\"aboveWhiteRatio\":" << double(above) / values.size() << ",\"peak\":" << peak
      << ",\"p99\":" << percentile(.99) << ",\"p999\":" << percentile(.999)
      << ",\"declaredHeadroom\":" << headroom << ",\"bins\":[";
  for (int i = 0; i < 256; ++i) {
    if (i)
      out << ',';
    out << double(bins[i]) / values.size();
  }
  out << "]}";
}

void analyze(const std::vector<uint8_t> &input, uint64_t limit, int orientation) {
  std::ostringstream out;
  out.precision(9);
  out << "{\"color\":";
  avifROData view{input.data(), input.size()};
  std::pair<Image, Image> images;
  double headroom = 1;
  bool hasGainMap = false;
  if (avifPeekCompatibleFileType(&view)) {
    auto dec = std::unique_ptr<avifDecoder, decltype(&avifDecoderDestroy)>(avifDecoderCreate(),
                                                                           avifDecoderDestroy);
    if (!dec)
      throw std::bad_alloc();
    dec->imageSizeLimit = static_cast<uint32_t>(std::min<uint64_t>(limit, UINT32_MAX));
    dec->imageContentToDecode = AVIF_IMAGE_CONTENT_ALL;
    check(avifDecoderSetIOMemory(dec.get(), input.data(), input.size()));
    check(avifDecoderParse(dec.get()));
    const auto *src = dec->image;
    writeColor(out, src->colorPrimaries, src->transferCharacteristics, src->depth,
               src->icc.size ? "icc" : "avif-nclx");
    hasGainMap = src->gainMap != nullptr;
    if (hasGainMap) {
      out << ",\"alternateColor\":";
      writeColor(out, src->gainMap->altColorPrimaries, src->gainMap->altTransferCharacteristics,
                 src->gainMap->altDepth, src->gainMap->altICC.size ? "icc" : "avif-nclx");
      const auto a = src->gainMap->alternateHdrHeadroom, b = src->gainMap->baseHdrHeadroom;
      if (!a.d || !b.d)
        throw std::runtime_error("Invalid gain-map headroom");
      headroom = std::exp2(std::max(double(a.n) / a.d, double(b.n) / b.d));
      bool safe = false;
      try {
        images = decodeAvif(input, limit, safe, AVIF_COLOR_PRIMARIES_BT2020);
      } catch (const Unsupported &) {
        // Do not invent SDR or HDR statistics for unsupported sources.
        out << ",\"status\":\"unavailable\"}";
        std::cout << out.str() << '\n';
        return;
      }
    } else if (src->transferCharacteristics == AVIF_TRANSFER_CHARACTERISTICS_PQ ||
               src->transferCharacteristics == AVIF_TRANSFER_CHARACTERISTICS_HLG) {
      out << ",\"status\":\"unavailable\"}";
      std::cout << out.str() << '\n';
      return;
    }
  } else {
    auto dec = std::unique_ptr<uhdr_codec_private_t, decltype(&uhdr_release_decoder)>(
        uhdr_create_decoder(), uhdr_release_decoder);
    if (!dec)
      throw std::bad_alloc();
    hasGainMap = is_uhdr_image(const_cast<uint8_t *>(input.data()), input.size());
    if (!hasGainMap) {
      out << "{\"source\":\"decoder\",\"bitDepth\":8}";
    } else {
      auto bytes = input;
      images = {decodeJpeg(bytes, false, limit, orientation),
                decodeJpeg(bytes, true, limit, orientation)};
      writeColor(out, images.first.primaries, AVIF_TRANSFER_CHARACTERISTICS_SRGB, 8,
                 "jpeg-gainmap");
      uhdr_compressed_image_t compressed{bytes.data(),        bytes.size(),
                                         bytes.size(),        UHDR_CG_UNSPECIFIED,
                                         UHDR_CT_UNSPECIFIED, UHDR_CR_UNSPECIFIED};
      check(uhdr_dec_set_image(dec.get(), &compressed));
      check(uhdr_dec_probe(dec.get()));
      const auto *metadata = uhdr_dec_get_gainmap_metadata(dec.get());
      if (!metadata)
        throw std::runtime_error("Missing JPEG gain-map metadata");
      headroom = metadata->hdr_capacity_max;
    }
  }
  if (hasGainMap) {
    out << ",\"sdr\":";
    writeSdrHistogram(out, images.first);
    out << ",\"hdr\":";
    writeHdrHistogram(out, images.second, headroom);
  }
  out << ",\"status\":\"" << (hasGainMap ? "complete" : "sdr-only") << "\"}";
  std::cout << out.str() << '\n';
}

# Development Guide

This document is for contributors and self-hosters who want to customize or run Afilmory from source.

## Workspace Layout

- `apps/web`: React + Vite SPA that consumes `photos-manifest.json` and generated thumbnails under `apps/web/public`.
- `apps/ssr`: Next.js wrapper that injects the manifest for SEO/OG and proxies SPA assets.
- `packages/builder`: Photo pipeline that syncs sources → processes images → writes manifest/thumbnails into the SPA.
- `config.json` + `site.config.ts`: Presentation/content config merged at runtime for both SPA and SSR.
- `builder.config.ts`: Builder pipeline config (storage, concurrency, repo sync, plugins).

## Quick Start (from source)

1. Install dependencies

```bash
pnpm install
```

2. Copy configs and fill values

```bash
cp config.example.json config.json
cp builder.config.default.ts builder.config.ts
```

3. Environment variables (`.env`)

- Storage: `S3_REGION`, `S3_ENDPOINT`, `S3_BUCKET_NAME`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PREFIX`, `S3_CUSTOM_DOMAIN`, `S3_EXCLUDE_REGEX`
- Repo sync (optional): `GIT_TOKEN`, `BUILDER_REPO_URL`, `BUILDER_REPO_BRANCH`

4. Build/update manifest and thumbnails (writes to `apps/web/src/data/photos-manifest.json` and `apps/web/public`)

```bash
pnpm run build:manifest             # incremental
pnpm run build:manifest -- --force # full rebuild
```

5. Run the app

```bash
pnpm dev              # SPA + SSR
pnpm --filter web dev # SPA only
pnpm --filter @afilmory/ssr dev # SSR wrapper only
```

## Builder Configuration (`builder.config.ts`)

The builder uses `defineBuilderConfig` from `@afilmory/builder`. `builder.config.default.ts` shows the recommended shape:

```ts
import os from 'node:os'

import { defineBuilderConfig, githubRepoSyncPlugin } from '@afilmory/builder'

import { env } from './env.js'

export default defineBuilderConfig(() => ({
  storage: {
    // Switch to { provider: 'local', basePath, baseUrl } for local-only testing.
    provider: 's3',
    bucket: env.S3_BUCKET_NAME,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    prefix: env.S3_PREFIX,
    customDomain: env.S3_CUSTOM_DOMAIN,
    excludeRegex: env.S3_EXCLUDE_REGEX,
    downloadConcurrency: 16,
  },
  system: {
    processing: { defaultConcurrency: 10, enableLivePhotoDetection: true, digestSuffixLength: 0 },
    observability: {
      showProgress: true,
      showDetailedStats: true,
      logging: { verbose: false, level: 'info', outputToFile: false },
      performance: {
        worker: { workerCount: os.cpus().length * 2, timeout: 30_000, useClusterMode: true, workerConcurrency: 2 },
      },
    },
  },
  plugins: [
    githubRepoSyncPlugin({
      repo: {
        enable: false,
        url: process.env.BUILDER_REPO_URL ?? '',
        token: env.GIT_TOKEN,
        branch: process.env.BUILDER_REPO_BRANCH ?? 'main',
      },
    }),
  ],
}))
```

Notes:

- B2/GitHub storage are also supported (see comments in `builder.config.ts`).
- Outputs land in `apps/web/public/thumbnails` and `apps/web/src/data/photos-manifest.json`.

## HDR thumbnails (experimental)

Thumbnail output is a **build-time** setting, independent of the large-image GPU
viewer.
The default remains an SDR JPEG.
Gain-map modes use an SDR base and the
browser's native image rendering; SDR sources remain SDR.
Live Photo video is
unchanged.
AVIF mode requires an AVIF-capable browser; a browser that decodes AVIF
but ignores its gain map displays the SDR base.
There is no automatic JPEG
fallback for browsers that cannot decode AVIF.

```ts
export default {
  system: {
    processing: {
      defaultConcurrency: 2,
      thumbnails: {
        mode: 'avif-gainmap', // 'sdr' | 'jpeg-gainmap' | 'avif-gainmap'
        width: 600,
        quality: 85,
        gainMapQuality: 95,
        onUnsupported: 'sdr', // warning + SDR, or 'error' to reject the build
        encoderPath: '/absolute/path/to/afilmory-hdr-thumbnail',
      },
    },
    observability: {
      performance: { worker: { workerConcurrency: 1, timeout: 150_000 } },
    },
  }
}
```

Omitting `quality` selects 100 for SDR, 90 for JPEG gain maps, and 85 for AVIF
gain maps.
Quality scales are codec-specific.
HDR decoding reconstructs full-size
SDR and HDR renditions before resizing in linear light, so start with low
concurrency, particularly with large camera images.
Both gain-map modes use an
even width/height (at most a one-pixel rounding difference) and do not upscale.
AVIF output uses 10-bit YUV444 and an 8-bit, full-resolution RGB gain map.

HDR modes require the optional native executable.
Install a C++17 compiler,
CMake, pkg-config, libavif (1.4.1 or newer) with an AV1 encoder/decoder, and
libultrahdr (1.4.0 or newer).
On macOS these libraries are available through
Homebrew.
Other systems may need to build the libraries from source.
The normal
SDR build needs none of these additional dependencies.

```sh
cmake -S packages/builder/native -B .local/hdr-native -DCMAKE_BUILD_TYPE=Release
cmake --build .local/hdr-native --parallel 2
# Set encoderPath to the resulting executable, or install it on PATH:
cmake --install .local/hdr-native --prefix "$HOME/.local"
```

The native codec accepts JPEG gain maps and opaque AVIF gain maps with
BT.709, Display P3 or BT.2020 colour information.
AVIF ICC profiles,
alpha, non-square pixels and animation are currently unsupported.
Clean aperture,
rotation and mirroring are applied to both renditions; JPEG EXIF orientation is
also applied.
Unsupported inputs produce a per-image warning and an SDR output,
or a failure with `onUnsupported: 'error'`.
A missing native executable, corrupt
input or codec failure is an error, not an SDR fallback.
HDR builds with failed
photos stop before saving/publishing the manifest.
Inputs without a safely
recoverable SDR rendition (such as HDR-only AVIF, or an unsupported HDR primary)
fail instead of falling back.
No HDR is synthesized for SDR originals.
Unsupported HDR source formats should be converted to a supported
gain-map input before building.

Incremental builds identify a thumbnail by the original bytes, normalized output
settings and codec versions.
Output filenames contain the encoded file's SHA-256.
The builder checks source ETag/mtime/size before skipping an original download.
Changing only the thumbnail mode or quality does not invalidate EXIF/tone data.

| Change                               | Work performed                                                             |
| ------------------------------------ | -------------------------------------------------------------------------- |
| No source/config changes             | Reuse existing thumbnails                                                  |
| Add/replace one source               | Generate that source's selected variant                                    |
| First switch to another mode/quality | Generate missing variants for the current collection                       |
| Switch back to a cached variant      | Restore it and update the manifest, without fetching originals or encoding |
| Change width/encoder version         | Generate variants using the new recipe                                     |
| Missing/corrupt cached file          | Regenerate the affected variant                                            |
| `--force-thumbnails`                 | Re-encode the selected variant for every selected source                   |

Variants and their indexes live in `apps/web/.cache/thumbnails`; only the current
manifest's files live in `apps/web/public/thumbnails`.
Preserve both directories
and the manifest across CI runs. `githubRepoSyncPlugin` stores variant cache in
`thumbnail-cache/` in its assets repository automatically.
Without that plugin,
restore the cache with CI caching, including a restore prefix that survives
configuration changes.
A cache miss is always safe, but costs another encoding.
Existing installations using legacy photo-ID JPEG filenames rebuild thumbnails
once to populate this cache; subsequent builds use the per-image recipes.
Unused variants are retained for switching back; delete the private cache
explicitly to reclaim space.
It must not be published as website content.

ThumbHash and OG images use the SDR base.
CDN upload plugins infer MIME from the
actual output extension.
These settings do not change the original images or
enable any large-image GPU functionality.

Validation:

```sh
node --import tsx --test packages/builder/src/image/thumbnail.test.ts
# Include native JPEG/AVIF round trips and independent reference decoders:
AFILMORY_HDR_TEST_ENCODER="$PWD/.local/hdr-native/afilmory-hdr-thumbnail" \
  node --import tsx --test packages/builder/src/image/thumbnail.test.ts
```

The native tests additionally require `ultrahdr_app` and `avifgainmaputil` on PATH.
The small synthetic fixtures can be regenerated with
`python3 packages/builder/native/generate-fixtures.py`.
They contain four known
SDR/HDR luminance bands and no photographs.
Native tests are skipped explicitly
when `AFILMORY_HDR_TEST_ENCODER` is unset.

## Original-image color and luminance analysis

The inspector uses build-time `analysis` data in the photo manifest. It does not
download a thumbnail or read a browser canvas to calculate histograms. The native
codec above is also required for JPEG/AVIF analysis, including when thumbnails
use SDR mode. Rebuild it after updating the analysis code.

For supported JPEG and AVIF gain-map originals, analysis reconstructs both
renditions at full resolution, before resizing. AVIF uses libavif and JPEG uses
libultrahdr. AVIF HDR reconstruction requests BT.2020 to avoid clipping to the
base image's narrower gamut before calculating luminance. Supported transforms
are applied before counting pixels.

- Color fields report the base image's declared CICP gamut, transfer and bit
  depth, with alternate-rendition color information when present. ICC sources
  are identified as ICC; their gamut/transfer are not inferred from an EXIF
  `Uncalibrated` label. The original EXIF label is shown separately.
- SDR RGB histograms and tone metrics use the original SDR rendition converted
  to sRGB, clipped to its range and quantized to 256 encoded-value bins. These
  metrics do not describe HDR highlights. The luminance channel is the existing
  weighted encoded-sRGB tone metric, not linear-light HDR luminance.
- HDR statistics use reconstructed linear-light luminance relative to SDR white
  (`1×`). The 256 histogram bins are uniformly spaced in exposure stops, from
  −12 EV to at least +3 EV, extending to the pixel peak when necessary. Black
  and values below the lower limit occupy the first bin. The axis marks
  `1×`, `2×`, `4×` and `8×`; this is not an absolute-nits scale.
- Above-white ratio counts pixels with luminance strictly greater than `1×`.
  P99 and P99.9 use the nearest-rank percentile of all reconstructed pixels;
  peak is their maximum. Encoding noise around `1×` can affect the ratio.
- Declared HDR headroom comes from gain-map metadata and is displayed separately
  from measured pixel values. Neither is a measurement of screen brightness.

Ordinary SDR sources have no HDR metrics. HDR-only PQ/HLG AVIF, SDR-base ICC gain
maps, gain maps with alpha, and other unsupported native structures show unavailable
analysis rather than fabricated HDR values. A missing native executable likewise
leaves JPEG/AVIF analysis unavailable. Corrupt input or a failing/incompatible
executable remains a build error, as does an ICC HDR base that the shared decoder
cannot safely reconstruct. This analysis support is independent of the
browser GPU viewer's support matrix.

Analysis is cached by original SHA-256 and analysis/decoder versions in
`apps/web/.cache/analysis`. Thumbnail mode, width and quality are not part of
this recipe. A first build backfills existing photos; unchanged originals then
reuse their analysis, including when thumbnail settings change. Updating the
analysis implementation invalidates analysis without invalidating thumbnail
variants unless shared decoding code also changed. `githubRepoSyncPlugin`
preserves this private cache in `analysis-cache/`; do not publish the cache as
website content. Force-manifest/full-force builds refresh analysis.

```sh
AFILMORY_HDR_TEST_ENCODER="$PWD/.local/hdr-native/afilmory-hdr-thumbnail" \
  node --import tsx --test packages/builder/src/image/analysis.test.ts
```

## Site Presentation Config (`config.json`)

`config.json` merges into `site.config.ts` for both SPA and SSR:

- `name` / `title` / `description` / `url` / `accentColor`
- `author`: `{ name, url, avatar }`
- `social`: `{ github?, twitter? }`
- `feed`: supports `folo.challenge.feedId` and `userId`
- `map`: map providers, e.g. `["maplibre"]`
- `mapStyle`: `builtin` or provider-specific style
- `mapProjection`: `globe` or `mercator`

## Common Commands

```bash
# Lint and format
pnpm lint
pnpm format

# Type check (web)
pnpm --filter web type-check

# Build production
pnpm build
```

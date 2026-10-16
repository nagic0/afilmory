import type { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { HistogramData, PhotoAnalysis, PhotoManifestItem } from '@afilmory/typing'
import sharp from 'sharp'

import { workdir } from '../path.js'
import type { ThumbnailSettings } from '../types/config.js'
import { atomicWrite } from './thumbnail-cache.js'
import { digest } from './thumbnail-config.js'

const exec = promisify(execFile)
const runtimes = new Map<string, Promise<{ recipe: string, available: boolean, encoderPath: string }>>()

export function analysisRuntime(settings?: ThumbnailSettings) {
  const encoderPath = settings?.encoderPath ?? 'afilmory-hdr-thumbnail'
  let runtime = runtimes.get(encoderPath)
  if (!runtime) {
    runtime = (async () => {
      let version = 'unavailable'
      try {
        version = (await exec(encoderPath, ['--analysis-version'], { timeout: 10_000 })).stdout.trim()
        if (!version.startsWith('afilmory-image-analysis/1 ')) {
          throw new Error('Incompatible image analysis codec')
        }
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
      return {
        recipe: digest(JSON.stringify({ analysis: 1, version, sharp: sharp.versions })),
        available: version !== 'unavailable',
        encoderPath,
      }
    })()
    runtimes.set(encoderPath, runtime)
  }
  return runtime
}

export async function analysisIsCurrent(item: PhotoManifestItem, settings?: ThumbnailSettings) {
  return (
    item.analysis?.recipe === (await analysisRuntime(settings)).recipe
    && item.analysis?.sourceDigest === item.thumbnailCache?.sourceDigest
  )
}

export function histogramFromRgb(data: Uint8Array, channels: number): HistogramData {
  const result: HistogramData = {
    red: Array.from({ length: 256 }).fill(0) as number[],
    green: Array.from({ length: 256 }).fill(0) as number[],
    blue: Array.from({ length: 256 }).fill(0) as number[],
    luminance: Array.from({ length: 256 }).fill(0) as number[],
  }
  const count = data.length / channels
  for (let i = 0; i < data.length; i += channels) {
    result.red[data[i]]++
    result.green[data[i + 1]]++
    result.blue[data[i + 2]]++
    result.luminance[Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])]++
  }
  for (const bins of Object.values(result)) {
    for (let i = 0; i < bins.length; i++) {
      bins[i] /= count
    }
  }
  return result
}

export async function analyzeOriginal(
  original: Buffer,
  processed: Buffer,
  settings?: ThumbnailSettings,
  limitInputPixels?: number | boolean,
  force = false,
  persist = true,
): Promise<PhotoAnalysis> {
  const runtime = await analysisRuntime(settings)
  const sourceDigest = digest(original)
  const cacheFile = path.join(workdir, '.cache/analysis', `${digest(`${runtime.recipe}:${sourceDigest}`)}.json`)
  if (!force) {
    try {
      const cached = JSON.parse(await readFile(cacheFile, 'utf8'))
      if (
        cached.sha256 === digest(JSON.stringify(cached.data))
        && cached.data.recipe === runtime.recipe
        && cached.data.sourceDigest === sourceDigest
      ) {
        return cached.data
      }
    }
    catch {
      /* A cache miss is regenerated from the original. */
    }
  }
  const metadata = await sharp(processed, { limitInputPixels }).metadata()
  let analysis: PhotoAnalysis = {
    recipe: runtime.recipe,
    sourceDigest,
    color: { source: metadata.icc ? 'icc' : 'decoder', bitDepth: metadata.bitsPerSample ?? 8 },
    status: 'sdr-only',
  }
  const nativeInput
    = (original[0] === 255 && original[1] === 216) || (metadata.format === 'heif' && metadata.compression === 'av1')
  if (runtime.available && nativeInput) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'afilmory-analysis-'))
    try {
      const input = path.join(directory, 'original')
      await writeFile(input, original)
      const limit
        = limitInputPixels === false || limitInputPixels === 0
          ? 4_294_967_295
          : typeof limitInputPixels === 'number'
            ? limitInputPixels
            : 268_402_689
      const { stdout } = await exec(
        runtime.encoderPath,
        ['--analyze', input, String(limit), String(metadata.orientation ?? 1), 'v1'],
        { timeout: 120_000, maxBuffer: 1024 * 1024 },
      )
      analysis = { ...analysis, ...JSON.parse(stdout), recipe: runtime.recipe, sourceDigest }
      if (metadata.icc && analysis.color.source === 'decoder') {
        analysis.color.source = 'icc'
      }
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  else if (nativeInput || original !== processed) {
    // Unknown HDR content must not be advertised as an authored SDR rendition.
    analysis.status = 'unavailable'
  }
  if (!analysis.sdr && analysis.status === 'sdr-only') {
    const { data, info } = await sharp(processed, { limitInputPixels })
      .rotate()
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    analysis.sdr = histogramFromRgb(data, info.channels)
  }
  if (persist) {
    await atomicWrite(cacheFile, JSON.stringify({ data: analysis, sha256: digest(JSON.stringify(analysis)) }))
  }
  return analysis
}

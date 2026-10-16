import type { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import sharp from 'sharp'

import type { ThumbnailSettings } from '../types/config.js'
import { thumbnailQuality } from './thumbnail-config.js'

const exec = promisify(execFile)

export interface EncodedThumbnail {
  buffer: Buffer
  extension: 'jpg' | 'avif'
  hdr: boolean
  warning?: string
}

export async function thumbnailEncoderVersion(settings: ThumbnailSettings): Promise<string> {
  if (settings.mode === 'sdr') {
    return ''
  }
  try {
    const { stdout } = await exec(settings.encoderPath, ['--version'], { timeout: 10_000, maxBuffer: 4096 })
    if (!stdout.startsWith('afilmory-hdr-thumbnail/1 ')) {
      throw new Error('Incompatible native thumbnail codec')
    }
    return stdout.trim()
  }
  catch (error) {
    throw new Error(
      `HDR thumbnails require afilmory-hdr-thumbnail. See DEVELOPMENT.md (HDR thumbnails). ${String(error)}`,
    )
  }
}

export async function encodeThumbnail(
  original: Buffer,
  processed: Buffer,
  settings: ThumbnailSettings,
  limitInputPixels?: number | boolean,
): Promise<EncodedThumbnail> {
  const avif = settings.mode === 'avif-gainmap'
  const extension = avif ? 'avif' : 'jpg'
  let warning: string | undefined

  if (settings.mode !== 'sdr') {
    const metadata = await sharp(processed, { limitInputPixels }).metadata()
    const isJpeg = original[0] === 0xFF && original[1] === 0xD8
    const isAvif = metadata.format === 'heif' && metadata.compression === 'av1'
    // Other SDR formats use Sharp. Never pass a preprocessed HEIC/JPEG to the HDR codec.
    if (isJpeg || isAvif) {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'afilmory-thumbnail-'))
      try {
        const input = path.join(directory, 'input')
        const output = path.join(directory, `output.${extension}`)
        await writeFile(input, original)
        const limit
          = limitInputPixels === false || limitInputPixels === 0
            ? 4_294_967_295
            : typeof limitInputPixels === 'number'
              ? limitInputPixels
              : 268_402_689
        await exec(
          settings.encoderPath,
          [
            input,
            output,
            avif ? 'avif' : 'jpeg',
            String(settings.width),
            String(thumbnailQuality(settings)),
            String(settings.gainMapQuality),
            String(limit),
            String(metadata.orientation ?? 1),
          ],
          { timeout: 120_000, maxBuffer: 16_384 },
        )
        const buffer = await readFile(output)
        await sharp(buffer).metadata() // Reject missing/truncated codec output before caching it.
        return { buffer, extension, hdr: true }
      }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (Number(code) === 2 && settings.onUnsupported === 'sdr') {
          warning = (error as Error & { stderr?: string }).stderr?.trim() || 'Unsupported HDR input'
        }
        else if (Number(code) !== 3) {
          throw error
        }
      }
      finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
    else if (original !== processed || metadata.gainMap) {
      warning = 'HDR preservation is supported only for original JPEG and AVIF gain maps'
      if (settings.onUnsupported === 'error') {
        throw new Error(warning)
      }
    }
  }

  const pipeline = sharp(processed, { limitInputPixels })
    .rotate()
    .resize(settings.width, null, { withoutEnlargement: true })
  const buffer = await (
    avif
      ? pipeline.avif({ quality: thumbnailQuality(settings), bitdepth: 10, chromaSubsampling: '4:4:4' })
      : pipeline.jpeg({ quality: thumbnailQuality(settings) })
  ).toBuffer()
  return { buffer, extension, hdr: false, warning }
}

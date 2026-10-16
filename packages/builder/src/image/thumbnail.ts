import type { Buffer } from 'node:buffer'
import path from 'node:path'

import type { ThumbnailCacheInfo } from '@afilmory/typing'

import { getGlobalLoggers } from '../photo/logger-adapter.js'
import type { ThumbnailSettings } from '../types/config.js'
import { generateBlurhash } from './blurhash.js'
import {
  atomicWrite,
  cacheKey,
  getThumbnailRuntime,
  readThumbnailCache,
  storeThumbnailCache,
  thumbnailCacheInfo,
  thumbnailDirectory,
} from './thumbnail-cache.js'
import { digest } from './thumbnail-config.js'
import { encodeThumbnail } from './thumbnail-encoder.js'

export interface GeneratedThumbnail {
  thumbnailUrl: string
  thumbnailBuffer: Buffer
  thumbHash: Uint8Array | null
  cache: ThumbnailCacheInfo
  hdr: boolean
}

export async function restoreThumbnail(
  sourceDigest: string,
  settings?: ThumbnailSettings,
  revision?: string,
  persist = true,
): Promise<GeneratedThumbnail | null> {
  if (!/^[a-f0-9]{64}$/.test(sourceDigest)) {
    return null
  }
  const { recipe } = await getThumbnailRuntime(settings)
  const hit = await readThumbnailCache(recipe, sourceDigest)
  if (!hit) {
    return null
  }
  if (persist) {
    await atomicWrite(path.join(thumbnailDirectory, hit.entry.fileName), hit.buffer)
  }
  if (hit.entry.warning) {
    getGlobalLoggers().thumbnail.warn(`SDR fallback (cached): ${hit.entry.warning}`)
  }
  return {
    thumbnailUrl: `/thumbnails/${hit.entry.fileName}`,
    thumbnailBuffer: hit.buffer,
    thumbHash: hit.entry.thumbHash ? Uint8Array.from(hit.entry.thumbHash) : null,
    cache: thumbnailCacheInfo(recipe, sourceDigest, hit.entry.fileName, revision),
    hdr: hit.entry.hdr,
  }
}

export async function generateThumbnailAndBlurhash(
  original: Buffer,
  processed: Buffer,
  settings?: ThumbnailSettings,
  revision?: string,
  force = false,
  persist = true,
  limitInputPixels?: number | boolean,
): Promise<GeneratedThumbnail> {
  const runtime = await getThumbnailRuntime(settings)
  const sourceDigest = digest(original)
  if (!force) {
    const hit = await restoreThumbnail(sourceDigest, runtime.settings, revision, persist)
    if (hit) {
      return hit
    }
  }
  const encoded = await encodeThumbnail(original, processed, runtime.settings, limitInputPixels)
  if (encoded.warning) {
    getGlobalLoggers().thumbnail.warn(`SDR fallback: ${encoded.warning}`)
  }
  // Sharp's normal decode reads the SDR base, not the HDR gain-map rendition.
  const thumbHash = await generateBlurhash(encoded.buffer, limitInputPixels)
  if (!thumbHash) {
    throw new Error('Could not generate thumbnail placeholder')
  }
  const key = cacheKey(runtime.recipe, sourceDigest)
  const fileName = `${digest(encoded.buffer)}.${encoded.extension}`
  if (persist) {
    await storeThumbnailCache(
      key,
      {
        fileName,
        sha256: digest(encoded.buffer),
        thumbHash: Array.from(thumbHash),
        hdr: encoded.hdr,
        warning: encoded.warning,
      },
      encoded.buffer,
    )
    await atomicWrite(path.join(thumbnailDirectory, fileName), encoded.buffer)
  }
  return {
    thumbnailUrl: `/thumbnails/${fileName}`,
    thumbnailBuffer: encoded.buffer,
    thumbHash,
    cache: thumbnailCacheInfo(runtime.recipe, sourceDigest, fileName, revision),
    hdr: encoded.hdr,
  }
}

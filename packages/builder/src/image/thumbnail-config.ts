import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import sharp from 'sharp'

import type { ThumbnailSettings } from '../types/config.js'

export function resolveThumbnailSettings(input: Partial<ThumbnailSettings> = {}): ThumbnailSettings {
  const settings: ThumbnailSettings = {
    mode: 'sdr',
    width: 600,
    gainMapQuality: 95,
    onUnsupported: 'sdr',
    encoderPath: 'afilmory-hdr-thumbnail',
    ...input,
  }
  if (!['sdr', 'jpeg-gainmap', 'avif-gainmap'].includes(settings.mode)) {
    throw new Error('Invalid thumbnail mode')
  }
  if (!Number.isInteger(settings.width) || settings.width < 2 || settings.width > 4096) {
    throw new Error('Thumbnail width must be an integer between 2 and 4096')
  }
  for (const quality of [settings.quality, settings.gainMapQuality]) {
    if (quality !== undefined && (!Number.isInteger(quality) || quality < 1 || quality > 100)) {
      throw new Error('Thumbnail quality must be an integer between 1 and 100')
    }
  }
  if (!['sdr', 'error'].includes(settings.onUnsupported)) {
    throw new Error('Invalid thumbnail fallback policy')
  }
  if (!settings.encoderPath?.trim()) {
    throw new Error('Thumbnail encoderPath must not be empty')
  }
  return settings
}

export function thumbnailQuality(settings: ThumbnailSettings): number {
  return settings.quality ?? (settings.mode === 'sdr' ? 100 : settings.mode === 'jpeg-gainmap' ? 90 : 85)
}

export function digest(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

export function thumbnailRecipe(settings: ThumbnailSettings, encoderVersion: string): string {
  return digest(
    JSON.stringify({
      // Bump when thumbnail processing or fallback changes, not for unrelated builder edits.
      version: 1,
      mode: settings.mode,
      width: settings.width,
      quality: thumbnailQuality(settings),
      gainMapQuality: settings.mode === 'sdr' ? undefined : settings.gainMapQuality,
      onUnsupported: settings.mode === 'sdr' ? undefined : settings.onUnsupported,
      sharp: sharp.versions,
      encoderVersion,
    }),
  )
}

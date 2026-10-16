import type { Buffer } from 'node:buffer'
import path from 'node:path'

import type { PhotoManifestItem, PickedExif, ToneAnalysis } from '@afilmory/typing'
import type { Sharp } from 'sharp'

import { HEIC_FORMATS } from '../constants/index.js'
import { extractExifData } from '../image/exif.js'
import { calculateHistogramAndAnalyzeTone } from '../image/histogram.js'
import { generateThumbnailAndBlurhash } from '../image/thumbnail.js'
import { getPhotoExecutionContext } from './execution-context.js'
import { getGlobalLoggers } from './logger-adapter.js'
import type { PhotoProcessorOptions } from './processor.js'

/**
 * 处理缩略图和 blurhash
 * 优先复用现有数据，如果不存在或需要强制更新则重新生成
 */
export async function processThumbnailAndBlurhash(
  imageBuffer: Buffer,
  originalBuffer: Buffer,
  revision: string | undefined,
  options: PhotoProcessorOptions,
) {
  const { builder } = getPhotoExecutionContext()
  const { limitInputPixels, thumbnails } = builder.getConfig().system.processing
  return await generateThumbnailAndBlurhash(
    originalBuffer,
    imageBuffer,
    thumbnails,
    revision,
    options.isForceMode || options.isForceThumbnails,
    !options.dryRun,
    limitInputPixels,
  )
}

/**
 * 处理 EXIF 数据
 * 优先复用现有数据，如果不存在或需要强制更新则重新提取
 */
export async function processExifData(
  imageBuffer: Buffer,
  rawImageBuffer: Buffer | undefined,
  photoKey: string,
  existingItem: PhotoManifestItem | undefined,
  options: PhotoProcessorOptions,
): Promise<PickedExif | null> {
  const loggers = getGlobalLoggers()

  // 检查是否可以复用现有数据
  if (!options.isForceMode && !options.isForceManifest && existingItem?.exif) {
    const photoId = path.basename(photoKey, path.extname(photoKey))
    loggers.exif.info(`复用现有 EXIF 数据：${photoId}`)
    return existingItem.exif
  }

  // 提取新的 EXIF 数据
  const ext = path.extname(photoKey).toLowerCase()
  const originalBuffer = HEIC_FORMATS.has(ext) ? rawImageBuffer : undefined

  return await extractExifData(imageBuffer, originalBuffer)
}

/**
 * 处理影调分析
 * 优先复用现有数据，如果不存在或需要强制更新则重新计算
 */
export async function processToneAnalysis(
  sharpInstance: Sharp,
  photoKey: string,
  existingItem: PhotoManifestItem | undefined,
  options: PhotoProcessorOptions,
): Promise<ToneAnalysis | null> {
  const loggers = getGlobalLoggers()

  // 检查是否可以复用现有数据
  if (!options.isForceMode && !options.isForceManifest && existingItem?.toneAnalysis) {
    const photoId = path.basename(photoKey, path.extname(photoKey))
    loggers.tone.info(`复用现有影调分析：${photoId}`)
    return existingItem.toneAnalysis
  }

  // 计算新的影调分析
  return await calculateHistogramAndAnalyzeTone(sharpInstance)
}

import type { Buffer } from 'node:buffer'

import type { PhotoManifestItem } from '@afilmory/typing'

import { analysisIsCurrent } from '../image/analysis.js'
import { sourceRevision, thumbnailIsCurrent } from '../image/thumbnail-cache.js'
import type { ThumbnailSettings } from '../types/config.js'
import type { PhotoProcessorOptions } from './processor.js'

export interface CacheableData {
  thumbnail?: {
    thumbnailUrl: string
    thumbnailBuffer: Buffer
    blurhash: string
  }
  exif?: PhotoManifestItem['exif']
  toneAnalysis?: PhotoManifestItem['toneAnalysis']
}

/**
 * 检查是否需要处理照片
 * 考虑文件更新状态和缓存存在性
 */
export async function shouldProcessPhoto(
  existingItem: PhotoManifestItem | undefined,
  obj: { LastModified?: Date, ETag?: string, Size?: number },
  options: PhotoProcessorOptions,
  settings?: ThumbnailSettings,
): Promise<{ shouldProcess: boolean, reason: string }> {
  // 强制模式下总是处理
  if (options.isForceMode) {
    return { shouldProcess: true, reason: '强制模式' }
  }

  // 新照片总是需要处理
  if (!existingItem) {
    return { shouldProcess: true, reason: '新照片' }
  }

  if (!(await analysisIsCurrent(existingItem, settings))) {
    return { shouldProcess: true, reason: '更新原图色彩与亮度分析' }
  }

  // 检查文件是否更新
  const revision = sourceRevision(obj)
  const fileNeedsUpdate = !revision || existingItem.thumbnailCache?.sourceRevision !== revision

  if (fileNeedsUpdate || options.isForceManifest) {
    return {
      shouldProcess: true,
      reason: fileNeedsUpdate ? '文件已更新' : '强制更新清单',
    }
  }

  const needsXmpBackfill
    = (options.xmpKeywordsEnabled && !Array.isArray((existingItem as Partial<PhotoManifestItem>).keywords))
      || (options.xmpRegionsEnabled && !Array.isArray((existingItem as Partial<PhotoManifestItem>).regions))

  if (needsXmpBackfill) {
    return {
      shouldProcess: true,
      reason: '补全 XMP 字段',
    }
  }

  // 检查缩略图是否存在
  const hasThumbnail = await thumbnailIsCurrent(existingItem, settings, revision)
  if (!hasThumbnail || options.isForceThumbnails) {
    return {
      shouldProcess: true,
      reason: options.isForceThumbnails ? '强制重新生成缩略图' : '缩略图缺失',
    }
  }

  return { shouldProcess: false, reason: '无需处理' }
}

/**
 * 检查缓存数据的完整性
 */
export function validateCacheData(
  existingItem: PhotoManifestItem | undefined,
  options: PhotoProcessorOptions,
): {
  needsThumbnail: boolean
  needsExif: boolean
  needsToneAnalysis: boolean
} {
  if (!existingItem) {
    return {
      needsThumbnail: true,
      needsExif: true,
      needsToneAnalysis: true,
    }
  }

  return {
    needsThumbnail: options.isForceMode || options.isForceThumbnails || !existingItem.thumbHash,
    needsExif: options.isForceMode || options.isForceManifest || !existingItem.exif,
    needsToneAnalysis: options.isForceMode || options.isForceManifest || !existingItem.toneAnalysis,
  }
}

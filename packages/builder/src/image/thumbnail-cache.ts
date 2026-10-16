import type { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { PhotoManifestItem, ThumbnailCacheInfo } from '@afilmory/typing'

import { workdir } from '../path.js'
import type { ThumbnailSettings } from '../types/config.js'
import { digest, resolveThumbnailSettings, thumbnailRecipe } from './thumbnail-config.js'
import { thumbnailEncoderVersion } from './thumbnail-encoder.js'

export const thumbnailDirectory = path.join(workdir, 'public/thumbnails')
export const thumbnailCacheDirectory = path.join(workdir, '.cache/thumbnails')

export interface ThumbnailCacheEntry {
  fileName: string
  sha256: string
  thumbHash: number[] | null
  hdr: boolean
  warning?: string
}

export interface ThumbnailRuntime {
  settings: ThumbnailSettings
  recipe: string
}

const runtimes = new WeakMap<ThumbnailSettings, Promise<ThumbnailRuntime>>()
const defaults = resolveThumbnailSettings()

export async function getThumbnailRuntime(input: ThumbnailSettings = defaults): Promise<ThumbnailRuntime> {
  let runtime = runtimes.get(input)
  if (!runtime) {
    runtime = (async () => {
      const settings = resolveThumbnailSettings(input)
      return { settings, recipe: thumbnailRecipe(settings, await thumbnailEncoderVersion(settings)) }
    })()
    runtimes.set(input, runtime)
  }
  return runtime
}

export function sourceRevision(source: { LastModified?: Date, ETag?: string, Size?: number }): string | undefined {
  if (!source.ETag && !source.LastModified) {
    return undefined
  }
  return digest(JSON.stringify([source.ETag ?? null, source.LastModified?.toISOString() ?? null, source.Size ?? null]))
}

function validHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value)
}

export function cacheKey(recipe: string, sourceDigest: string): string {
  if (!validHash(recipe) || !validHash(sourceDigest)) {
    throw new Error('Invalid thumbnail cache key')
  }
  return digest(`${recipe}:${sourceDigest}`)
}

export async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, data)
    await fs.rename(temporary, file)
  }
  finally {
    await fs.rm(temporary, { force: true })
  }
}

export async function readThumbnailCache(recipe: string, sourceDigest: string, directory = thumbnailCacheDirectory) {
  const key = cacheKey(recipe, sourceDigest)
  try {
    const entry = JSON.parse(await fs.readFile(path.join(directory, `${key}.json`), 'utf8')) as ThumbnailCacheEntry
    if (!validHash(entry.sha256) || !new RegExp(`^${entry.sha256}\\.(jpg|avif)$`).test(entry.fileName)) {
      return null
    }
    if (typeof entry.hdr !== 'boolean' || (entry.warning !== undefined && typeof entry.warning !== 'string')) {
      return null
    }
    if (
      !Array.isArray(entry.thumbHash)
      || entry.thumbHash.length === 0
      || entry.thumbHash.length > 100
      || !entry.thumbHash.every(v => Number.isInteger(v) && v >= 0 && v <= 255)
    ) {
      return null
    }
    const buffer = await fs.readFile(path.join(directory, entry.fileName))
    if (digest(buffer) !== entry.sha256) {
      return null
    }
    return { entry, buffer }
  }
  catch {
    return null
  }
}

export async function storeThumbnailCache(
  key: string,
  entry: ThumbnailCacheEntry,
  buffer: Buffer,
  directory = thumbnailCacheDirectory,
): Promise<void> {
  await atomicWrite(path.join(directory, entry.fileName), buffer)
  await atomicWrite(path.join(directory, `${key}.json`), JSON.stringify(entry))
}

export async function thumbnailIsCurrent(
  item: PhotoManifestItem,
  settings: ThumbnailSettings | undefined,
  revision: string | undefined,
): Promise<boolean> {
  const cached = item.thumbnailCache
  const { recipe } = await getThumbnailRuntime(settings)
  if (!cached || !item.thumbHash || !revision || cached.sourceRevision !== revision || cached.recipe !== recipe) {
    return false
  }
  if (!validHash(cached.sourceDigest)) {
    return false
  }
  const hit = await readThumbnailCache(recipe, cached.sourceDigest)
  if (!hit || hit.entry.fileName !== cached.fileName) {
    return false
  }
  try {
    const publicFile = await fs.readFile(path.join(thumbnailDirectory, hit.entry.fileName))
    return digest(publicFile) === hit.entry.sha256
  }
  catch {
    return false
  }
}

export function thumbnailCacheInfo(
  recipe: string,
  sourceDigest: string,
  fileName: string,
  revision?: string,
): ThumbnailCacheInfo {
  return { recipe, sourceDigest, fileName, sourceRevision: revision }
}

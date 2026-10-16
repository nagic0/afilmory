/* eslint-disable test/no-import-node-test -- Builder tests use Node's built-in runner, without a Vitest dependency. */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import sharp from 'sharp'

import { resolveBuilderConfig } from '../config/index.js'
import { atomicWrite, cacheKey, readThumbnailCache, sourceRevision, storeThumbnailCache } from './thumbnail-cache.js'
import { digest, resolveThumbnailSettings, thumbnailRecipe } from './thumbnail-config.js'
import { encodeThumbnail, thumbnailEncoderVersion } from './thumbnail-encoder.js'

const exec = promisify(execFile)
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const encoderPath = process.env.AFILMORY_HDR_TEST_ENCODER

it('default configuration preserves SDR; invalid settings fail before processing', () => {
  assert.equal(resolveThumbnailSettings().mode, 'sdr')
  const config = resolveBuilderConfig({ system: { processing: { thumbnails: { mode: 'avif-gainmap' } } } })
  assert.equal(config.system.processing.thumbnails?.width, 600)
  for (const input of [{ width: 0 }, { quality: 101 }, { gainMapQuality: 0 }, { width: 2.5 }]) {
    assert.throws(() => resolveThumbnailSettings(input))
  }
})

it('recipe invalidates only for output settings and codec versions', () => {
  const settings = resolveThumbnailSettings()
  const recipe = thumbnailRecipe(settings, '')
  assert.equal(recipe, thumbnailRecipe({ ...settings, gainMapQuality: 80, encoderPath: '/elsewhere' }, ''))
  assert.notEqual(recipe, thumbnailRecipe({ ...settings, quality: 90 }, ''))
  assert.notEqual(recipe, thumbnailRecipe({ ...settings, width: 500 }, ''))
  assert.notEqual(recipe, thumbnailRecipe({ ...settings, mode: 'avif-gainmap' }, 'codec/1'))
  assert.notEqual(thumbnailRecipe(settings, 'codec/1'), thumbnailRecipe(settings, 'codec/2'))
  assert.notEqual(cacheKey(recipe, digest('photo-1')), cacheKey(recipe, digest('photo-2')))
})

it('source revisions include ETag, size and modification time; unknown revisions never skip', () => {
  const revision = { ETag: 'a', Size: 10, LastModified: new Date('2026-01-01') }
  assert.notEqual(sourceRevision(revision), sourceRevision({ ...revision, ETag: 'b' }))
  assert.notEqual(sourceRevision(revision), sourceRevision({ ...revision, Size: 11 }))
  assert.equal(sourceRevision({}), undefined)
})

it('cache keeps independent variants and rejects missing, corrupt or unsafe entries', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'thumbnail-cache-test-'))
  t.after(() => fs.rm(folder, { recursive: true, force: true }))
  const source = digest('photo')
  const recipe = digest('sdr')
  const other = digest('avif')
  const buffer = Buffer.from('encoded thumbnail')
  const entry = { fileName: `${digest(buffer)}.jpg`, sha256: digest(buffer), thumbHash: [1, 2, 3], hdr: false }
  await storeThumbnailCache(cacheKey(recipe, source), entry, buffer, folder)
  await storeThumbnailCache(cacheKey(other, source), entry, buffer, folder)
  assert.deepEqual((await readThumbnailCache(recipe, source, folder))?.buffer, buffer)
  assert.ok(await readThumbnailCache(other, source, folder))
  assert.equal(await readThumbnailCache(recipe, digest('new photo'), folder), null)
  await atomicWrite(path.join(folder, entry.fileName), Buffer.from('truncated'))
  assert.equal(await readThumbnailCache(recipe, source, folder), null)
  await atomicWrite(
    path.join(folder, `${cacheKey(recipe, source)}.json`),
    JSON.stringify({ ...entry, fileName: '../escape.jpg' }),
  )
  assert.equal(await readThumbnailCache(recipe, source, folder), null)
  await assert.rejects(readThumbnailCache('../escape', source, folder))
})

it('generates SDR without a native codec and respects orientation and dimensions', async () => {
  const input = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#808080' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer()
  const result = await encodeThumbnail(input, input, resolveThumbnailSettings({ width: 60, encoderPath: '/missing' }))
  const metadata = await sharp(result.buffer).metadata()
  assert.equal(result.hdr, false)
  assert.equal(result.extension, 'jpg')
  assert.equal(metadata.width, 60)
  assert.equal(metadata.height, 90)
  assert.equal(metadata.orientation, undefined)
  await assert.rejects(
    thumbnailEncoderVersion(resolveThumbnailSettings({ mode: 'avif-gainmap', encoderPath: '/missing' })),
    /require/,
  )
})

function half(value: number): number {
  const exponent = (value >> 10) & 31
  return (
    (value & 0x8000 ? -1 : 1)
    * (exponent === 0 ? (value & 1023) * 2 ** -24 : (1024 + (value & 1023)) * 2 ** (exponent - 25))
  )
}

function pq(value: number): number {
  const p = value ** (32 / 2523)
  return (Math.max(p - 3424 / 4096, 0) / (2413 / 128 - (2392 / 128) * p)) ** (16384 / 2610) * (10000 / 203)
}

for (const inputFormat of ['jpg', 'avif']) {
  for (const mode of ['jpeg-gainmap', 'avif-gainmap'] as const) {
    it(`${inputFormat} → ${mode}: independent HDR reconstruction and SDR base`, { skip: !encoderPath }, async (t) => {
      const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'thumbnail-codec-test-'))
      t.after(() => fs.rm(folder, { recursive: true, force: true }))
      const input = await fs.readFile(path.join(fixtures, `steps.${inputFormat}`))
      const result = await encodeThumbnail(
        input,
        input,
        resolveThumbnailSettings({ mode, width: 64, quality: 95, encoderPath }),
      )
      assert.equal(result.hdr, true)
      const output = path.join(folder, `output.${result.extension}`)
      await fs.writeFile(output, result.buffer)
      const { data: base, info } = await sharp(result.buffer)
        .toColourspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true })
      assert.equal(info.width, 64)
      assert.equal(info.height, 48)
      const expectedSdr = [0.125, 0.25, 0.5, 0.75]
      for (let region = 0; region < 4; region++) {
        const value = base[(24 * 64 + region * 16 + 8) * 3] / 255
        const decoded = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
        assert.ok(Math.abs(decoded - expectedSdr[region]) < 0.025, `SDR region ${region}: ${decoded}`)
      }
      const decoded = path.join(folder, mode === 'jpeg-gainmap' ? 'hdr.raw' : 'hdr.png')
      let values: number[]
      if (mode === 'jpeg-gainmap') {
        await exec('ultrahdr_app', ['-m', '1', '-j', output, '-o', '0', '-O', '4', '-z', decoded])
        const raw = await fs.readFile(decoded)
        values = [0, 1, 2, 3].map(region => half(raw.readUInt16LE((24 * 64 + region * 16 + 8) * 8)))
      }
      else {
        await exec('avifgainmaputil', ['tonemap', output, decoded, '--headroom', '8', '--cicp-output', '1/16/6'])
        const raw = await sharp(decoded).toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer()
        values = [0, 1, 2, 3].map(region => pq(raw.readUInt16LE((24 * 64 + region * 16 + 8) * 6) / 65535))
      }
      const expected = [0.25, 1, 2, 4]
      values.forEach((value, i) =>
        assert.ok(Math.abs(value - expected[i]) / expected[i] < 0.08, `HDR region ${i}: ${value}`))
    })
  }
}

it('keeps ordinary SDR sources SDR in gain-map modes', { skip: !encoderPath }, async () => {
  const input = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#808080' } })
    .jpeg()
    .toBuffer()
  for (const mode of ['jpeg-gainmap', 'avif-gainmap'] as const) {
    const result = await encodeThumbnail(input, input, resolveThumbnailSettings({ mode, encoderPath }))
    assert.equal(result.hdr, false)
    assert.equal(result.warning, undefined)
    assert.equal(result.extension, mode === 'jpeg-gainmap' ? 'jpg' : 'avif')
  }
})

it('normalizes an HDR-base AVIF to an SDR-base gain-map thumbnail', { skip: !encoderPath }, async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'thumbnail-hdr-base-test-'))
  t.after(() => fs.rm(folder, { recursive: true, force: true }))
  const file = path.join(folder, 'hdr-base.avif')
  await exec('avifgainmaputil', ['swapbase', path.join(fixtures, 'steps.avif'), file, '-q', '100'])
  const input = await fs.readFile(file)
  const output = await encodeThumbnail(
    input,
    input,
    resolveThumbnailSettings({ mode: 'avif-gainmap', width: 64, encoderPath }),
  )
  assert.equal(output.hdr, true)
  const raw = await sharp(output.buffer).toColourspace('srgb').raw().toBuffer()
  const value = raw[(24 * 64 + 56) * 3] / 255
  const decoded = ((value + 0.055) / 1.055) ** 2.4
  assert.ok(Math.abs(decoded - 0.75) < 0.04, `Recovered SDR white band: ${decoded}`)
})

it('unsupported alpha gain map warns and falls back, or fails in strict mode', { skip: !encoderPath }, async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'thumbnail-unsupported-test-'))
  t.after(() => fs.rm(folder, { recursive: true, force: true }))
  const file = path.join(folder, 'alpha.avif')
  const base = path.join(folder, 'base.png')
  const alternate = path.join(folder, 'alternate.png')
  await sharp(path.join(fixtures, 'steps.jpg')).ensureAlpha(0.5).png().toFile(base)
  await exec('avifgainmaputil', ['tonemap', path.join(fixtures, 'steps.avif'), alternate, '--headroom', '8'])
  await exec('avifgainmaputil', [
    'combine',
    base,
    alternate,
    file,
    '--cicp-base',
    '1/13/6',
    '--cicp-alternate',
    '1/16/6',
  ])
  const input = await fs.readFile(file)
  const settings = resolveThumbnailSettings({ mode: 'avif-gainmap', encoderPath })
  const fallback = await encodeThumbnail(input, input, settings)
  assert.equal(fallback.hdr, false)
  assert.match(fallback.warning ?? '', /alpha/)
  await assert.rejects(encodeThumbnail(input, input, { ...settings, onUnsupported: 'error' }), /alpha/)
})

it('rejects HDR-only AVIF instead of treating its primary as an SDR fallback', { skip: !encoderPath }, async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'thumbnail-hdr-only-test-'))
  t.after(() => fs.rm(folder, { recursive: true, force: true }))
  const file = path.join(folder, 'hdr-only.avif')
  await exec('avifgainmaputil', [
    'tonemap',
    path.join(fixtures, 'steps.avif'),
    file,
    '--headroom',
    '8',
    '--cicp-output',
    '1/16/6',
  ])
  const input = await fs.readFile(file)
  const settings = resolveThumbnailSettings({ mode: 'avif-gainmap', encoderPath, onUnsupported: 'sdr' })
  await assert.rejects(encodeThumbnail(input, input, settings), /no authored SDR fallback/)
})

it('native codec errors do not request a silent SDR fallback', { skip: !encoderPath }, async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'thumbnail-corrupt-test-'))
  t.after(() => fs.rm(folder, { recursive: true, force: true }))
  const file = path.join(folder, 'truncated.avif')
  const input = await fs.readFile(path.join(fixtures, 'steps.avif'))
  await fs.writeFile(file, input.subarray(0, Math.floor(input.length / 2)))
  await assert.rejects(
    exec(encoderPath!, [file, path.join(folder, 'output.avif'), 'avif', '64', '85', '95', '100000', '1']),
    (error: unknown) => (error as { code: number }).code === 1,
  )
})

it(
  'native codec enforces pixel limits and applies JPEG orientation to both renditions',
  { skip: !encoderPath },
  async (t) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'thumbnail-geometry-test-'))
    t.after(() => fs.rm(folder, { recursive: true, force: true }))
    const output = path.join(folder, 'rotated.avif')
    const args = [path.join(fixtures, 'steps.jpg'), output, 'avif', '64', '95', '95', '100000', '6']
    await exec(encoderPath!, args)
    const metadata = await sharp(output).metadata()
    assert.equal(metadata.width, 64)
    assert.equal(metadata.height, 86)
    const pixels = await sharp(output).raw().toBuffer()
    assert.ok(pixels[(8 * 64 + 32) * 3] < pixels[(75 * 64 + 32) * 3])
    await assert.rejects(exec(encoderPath!, [...args.slice(0, 6), '10', '6']), /pixel limit/)
  },
)

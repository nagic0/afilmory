/* eslint-disable test/no-import-node-test -- Builder tests use Node's built-in runner. */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { it } from 'node:test'
import { promisify } from 'node:util'

import sharp from 'sharp'

import { analysisRuntime, analyzeOriginal, histogramFromRgb } from './analysis.js'
import { resolveThumbnailSettings } from './thumbnail-config.js'

const encoderPath = process.env.AFILMORY_HDR_TEST_ENCODER
const exec = promisify(execFile)
const fixture = (ext: string) => fs.readFile(new URL(`./fixtures/steps.${ext}`, import.meta.url))
const settings = resolveThumbnailSettings(encoderPath ? { encoderPath } : {})

it('SDR bins use the full source population and normalized sRGB code values', () => {
  const histogram = histogramFromRgb(Buffer.from([0, 0, 0, 255, 255, 255]), 3)
  for (const bins of Object.values(histogram)) {
    assert.equal(bins[0], 0.5)
    assert.equal(bins[255], 0.5)
    assert.equal(
      bins.reduce((a, b) => a + b),
      1,
    )
  }
})

for (const format of ['avif', 'jpg']) {
  it(
    `${format}: full-resolution reconstructed luminance and authored SDR statistics`,
    { skip: !encoderPath },
    async () => {
      const input = await fixture(format)
      const result = await analyzeOriginal(input, input, settings, undefined, true, false)
      assert.equal(result.status, 'complete')
      assert.equal(result.hdr?.pixelCount, 128 * 96)
      for (const value of [result.hdr!.peak, result.hdr!.p99, result.hdr!.p999]) {
        assert.ok(Math.abs(value - 4) < 0.1, `Expected 4×, received ${value}`)
      }
      assert.ok(result.hdr!.aboveWhiteRatio >= 0.49 && result.hdr!.aboveWhiteRatio <= 0.76)
      assert.equal(result.hdr?.minStops, -12)
      assert.equal(result.hdr?.maxStops, 3)
      assert.ok(Math.abs(result.hdr!.bins.reduce((a, b) => a + b) - 1) < 1e-6)
      assert.ok(result.sdr)
      for (const bins of Object.values(result.sdr!)) {
        assert.ok(Math.abs(bins.reduce((a, b) => a + b) - 1) < 1e-6)
      }
      if (format === 'avif') {
        assert.equal(result.color.primaries, 1)
        assert.equal(result.color.transfer, 13)
        assert.equal(result.color.bitDepth, 10)
        assert.equal(result.alternateColor?.transfer, 16)
        assert.ok(Math.abs(result.hdr!.declaredHeadroom - 4) < 0.1)
        assert.equal(result.hdr!.aboveWhiteRatio, 0.5)
      }
    },
  )
}

it(
  'analysis recipe and values are independent of thumbnail mode, dimensions and quality',
  { skip: !encoderPath },
  async () => {
    const input = await fixture('avif')
    const reference = await analyzeOriginal(input, input, settings, undefined, true, false)
    for (const mode of ['sdr', 'jpeg-gainmap', 'avif-gainmap'] as const) {
      const variant = { ...settings, mode, width: 32, quality: 10, gainMapQuality: 20 }
      assert.equal((await analysisRuntime(variant)).recipe, reference.recipe)
      assert.deepEqual(await analyzeOriginal(input, input, variant, undefined, true, false), reference)
    }
  },
)

it('ordinary SDR JPEG has no fabricated HDR metrics', { skip: !encoderPath }, async () => {
  const input = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } })
    .jpeg()
    .toBuffer()
  const result = await analyzeOriginal(input, input, settings, undefined, true, false)
  assert.equal(result.status, 'sdr-only')
  assert.equal(result.hdr, undefined)
  assert.ok(result.sdr)
})

it(
  'HDR-only AVIF reports unavailable instead of labelling its HDR primary as SDR',
  { skip: !encoderPath },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'analysis-hdr-only-'))
    t.after(() => fs.rm(directory, { recursive: true, force: true }))
    const output = path.join(directory, 'hdr.avif')
    await exec('avifgainmaputil', [
      'tonemap',
      new URL('./fixtures/steps.avif', import.meta.url).pathname,
      output,
      '--headroom',
      '8',
      '--cicp-output',
      '1/16/6',
    ])
    const input = await fs.readFile(output)
    const result = await analyzeOriginal(input, input, settings, undefined, true, false)
    assert.equal(result.status, 'unavailable')
    assert.equal(result.color.transfer, 16)
    assert.equal(result.sdr, undefined)
    assert.equal(result.hdr, undefined)
  },
)

it('missing native decoder exposes unavailable statistics instead of a fake HDR histogram', async () => {
  const input = await fixture('avif')
  const result = await analyzeOriginal(
    input,
    input,
    { ...settings, encoderPath: '/missing/afilmory-analysis' },
    undefined,
    true,
    false,
  )
  assert.equal(result.status, 'unavailable')
  assert.equal(result.sdr, undefined)
  assert.equal(result.hdr, undefined)
})

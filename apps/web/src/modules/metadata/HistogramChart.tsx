import type { PhotoAnalysis } from '@afilmory/typing'
import { clsxm, focusRing } from '@afilmory/utils'
import type { FC } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Row } from './formatExifData'

const channels = ['luminance', 'red', 'green', 'blue'] as const
const colors = ['text-text-secondary', 'text-red', 'text-green', 'text-blue']

function bars(values: number[], maximum: number) {
  const width = 256 / values.length
  return values
    .map((value, i) => {
      const height = maximum > 0 ? (value / maximum) * 96 : 0
      return `M${i * width},96v-${height}h${width * 0.8}v${height}Z`
    })
    .join(' ')
}

export const HistogramChart: FC<{ analysis?: PhotoAnalysis }> = ({ analysis }) => {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<'sdr' | 'hdr'>('sdr')
  const mode = selected === 'hdr' && analysis?.hdr ? 'hdr' : 'sdr'
  if (!analysis?.sdr) {
    return <p className="text-text-secondary text-xs">{t('exif.analysis.unavailable')}</p>
  }
  const hdr = analysis.hdr
  const values = mode === 'hdr' ? [hdr!.bins] : channels.map(channel => analysis.sdr![channel])
  const maximum = Math.max(...values.flat())
  const x = (stops: number) => ((stops - hdr!.minStops) / (hdr!.maxStops - hdr!.minStops)) * 256
  const ticks
    = mode === 'hdr'
      ? [
          { x: 0, label: '≤1/4096×' },
          ...Array.from({ length: hdr!.maxStops + 1 }, (_, stops) => ({ x: x(stops), label: `${2 ** stops}×` })),
        ]
      : [
          { x: 0, label: '0' },
          { x: 128, label: '128' },
          { x: 256, label: '255' },
        ]
  const multiple = (value: number) => `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}×`

  return (
    <div className="space-y-3" data-photo-analysis={mode}>
      <div className="bg-fill-quaternary flex rounded-lg p-1" role="group" aria-label={t('exif.analysis.rendition')}>
        {(['sdr', 'hdr'] as const).map(value => (
          <button
            key={value}
            type="button"
            disabled={value === 'hdr' && !hdr}
            aria-pressed={mode === value}
            onClick={() => setSelected(value)}
            className={clsxm(
              'flex-1 rounded-md px-3 py-1 text-xs transition-colors disabled:opacity-40',
              focusRing,
              mode === value ? 'bg-accent text-text' : 'text-text-secondary hover:bg-accent/10',
            )}
          >
            {value.toUpperCase()}
          </button>
        ))}
      </div>
      <p className="text-text-secondary text-xs">
        {t(mode === 'hdr' ? 'exif.analysis.hdr.scope' : 'exif.analysis.sdr.scope')}
      </p>
      <svg
        viewBox="-4 0 264 116"
        className="bg-fill-quinary w-full rounded-md"
        role="img"
        aria-label={t(mode === 'hdr' ? 'exif.analysis.hdr.chart' : 'exif.analysis.sdr.chart')}
      >
        {mode === 'hdr' && (
          <rect x={x(0)} width={256 - x(0)} height="96" className="text-accent" fill="currentColor" opacity="0.08" />
        )}
        {values.map((bins, i) => (
          <path
            key={channels[i]}
            d={bars(bins, maximum)}
            fill="currentColor"
            opacity={mode === 'hdr' ? 0.8 : 0.45}
            className={mode === 'hdr' ? 'text-accent' : colors[i]}
          />
        ))}
        {mode === 'hdr' && (
          <line
            x1={x(0)}
            x2={x(0)}
            y1="0"
            y2="96"
            stroke="currentColor"
            className="text-text-secondary"
            strokeDasharray="2 2"
          />
        )}
        {ticks.map(tick => (
          <text
            key={tick.label}
            x={tick.x}
            y="110"
            fill="currentColor"
            className="text-text-secondary"
            fontSize="8"
            textAnchor={tick.x === 0 ? 'start' : tick.x === 256 ? 'end' : 'middle'}
          >
            {tick.label}
          </text>
        ))}
      </svg>
      {mode === 'hdr' && hdr && (
        <div className="space-y-1">
          <Row
            label={t('exif.analysis.above-white')}
            value={`${(hdr.aboveWhiteRatio * 100).toLocaleString(undefined, { maximumFractionDigits: 3 })}%`}
          />
          <Row label={t('exif.analysis.p99')} value={multiple(hdr.p99)} />
          <Row label={t('exif.analysis.p999')} value={multiple(hdr.p999)} />
          <Row label={t('exif.analysis.peak')} value={multiple(hdr.peak)} />
          <Row
            label={t('exif.analysis.declared')}
            value={`${multiple(hdr.declaredHeadroom)} (+${Math.log2(hdr.declaredHeadroom).toFixed(2)} EV)`}
          />
          <p className="text-text-tertiary pt-1 text-xs">{t('exif.analysis.display-note')}</p>
        </div>
      )}
    </div>
  )
}

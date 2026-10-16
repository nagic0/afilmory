import type { ImageColorInfo, PhotoAnalysis } from '@afilmory/typing'
import { useTranslation } from 'react-i18next'

import { Row } from './formatExifData'

function colorDescription(color: ImageColorInfo) {
  const gamut: Record<number, string> = { 1: 'BT.709 / sRGB', 9: 'BT.2020', 12: 'Display P3' }
  const transfer: Record<number, string> = { 1: 'BT.709', 8: 'Linear', 13: 'sRGB', 16: 'PQ', 18: 'HLG' }
  return {
    gamut:
      color.source === 'icc'
        ? 'ICC'
        : (gamut[color.primaries ?? -1] ?? (color.primaries === undefined ? null : `CICP ${color.primaries}`)),
    transfer:
      color.source === 'icc'
        ? null
        : (transfer[color.transfer ?? -1] ?? (color.transfer === undefined ? null : `CICP ${color.transfer}`)),
  }
}

export function ColorInformation({ analysis, exifColor }: { analysis?: PhotoAnalysis, exifColor?: string | null }) {
  const { t } = useTranslation()
  const color = analysis?.color
  const description = color ? colorDescription(color) : null
  const alternate = analysis?.alternateColor ? colorDescription(analysis.alternateColor) : null
  return (
    <>
      {description?.gamut && <Row label={t('exif.analysis.gamut')} value={description.gamut} />}
      {description?.transfer && <Row label={t('exif.analysis.transfer')} value={description.transfer} />}
      {color && <Row label={t('exif.analysis.depth')} value={`${color.bitDepth}-bit`} />}
      {color && <Row label={t('exif.analysis.color-source')} value={t(`exif.analysis.source.${color.source}`)} />}
      {alternate?.gamut && (
        <Row
          label={t('exif.analysis.alternate')}
          value={[alternate.gamut, alternate.transfer].filter(Boolean).join(' · ')}
        />
      )}
      {exifColor && <Row label={t('exif.analysis.exif-tag')} value={exifColor} />}
    </>
  )
}

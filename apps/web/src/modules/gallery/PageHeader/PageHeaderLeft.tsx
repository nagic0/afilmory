import { clsxm, focusRing } from '@afilmory/utils'
import * as AvatarPrimitive from '@radix-ui/react-avatar'
import { useTranslation } from 'react-i18next'

import { siteConfig } from '~/config'
import { usePhotos } from '~/hooks/usePhotoViewer'

import { resolveSocialUrl, SocialIconButton } from './utils'

export const PageHeaderLeft = () => {
  const { t } = useTranslation()
  const visiblePhotoCount = usePhotos().length

  const githubUrl
    = siteConfig.social && siteConfig.social.github
      ? resolveSocialUrl(siteConfig.social.github, { baseUrl: 'https://github.com/' })
      : undefined
  const twitterUrl
    = siteConfig.social && siteConfig.social.twitter
      ? resolveSocialUrl(siteConfig.social.twitter, { baseUrl: 'https://twitter.com/', stripAt: true })
      : undefined
  const hasRss = true

  return (
    <div className="flex items-center gap-2">
      {siteConfig.author.avatar ? (
        <AvatarPrimitive.Root>
          <AvatarPrimitive.Image
            src={siteConfig.author.avatar}
            className="size-7 rounded-lg lg:size-8"
            alt={siteConfig.author.name}
          />
          <AvatarPrimitive.Fallback>
            <div className="flex size-7 items-center justify-center rounded-lg bg-white/10 lg:size-8">
              <i className="i-mingcute-camera-2-line text-sm text-white/60 lg:text-base" />
            </div>
          </AvatarPrimitive.Fallback>
        </AvatarPrimitive.Root>
      ) : (
        <div className="flex size-7 items-center justify-center rounded-lg bg-white/10 lg:size-8">
          <i className="i-mingcute-camera-2-line text-sm text-white/60 lg:text-base" />
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <h1 className="truncate text-sm font-semibold text-white lg:text-base">{siteConfig.name}</h1>
        <span className="text-xs text-white/40 lg:text-sm">{visiblePhotoCount}</span>
      </div>
      {siteConfig.author.url && (
        <a
          href={siteConfig.author.url}
          aria-label={t('gallery.homepage', { defaultValue: 'Homepage' })}
          title={t('gallery.homepage', { defaultValue: 'Homepage' })}
          className={clsxm(
            'text-text-secondary hover:bg-fill-tertiary hover:text-text flex min-h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg px-1 text-xs transition-colors duration-200 lg:px-2',
            focusRing,
          )}
        >
          <i className="i-mingcute-home-4-line text-base" aria-hidden="true" />
          <span className="hidden lg:inline">{t('gallery.homepage', { defaultValue: 'Homepage' })}</span>
        </a>
      )}
      {(githubUrl || twitterUrl || hasRss) && (
        <div className="ml-1 hidden items-center gap-1 border-l border-white/10 pl-2 lg:flex">
          {githubUrl && <SocialIconButton icon="i-mingcute-github-fill" title="GitHub" href={githubUrl} />}
          {twitterUrl && <SocialIconButton icon="i-mingcute-twitter-fill" title="Twitter" href={twitterUrl} />}
          {hasRss && <SocialIconButton icon="i-mingcute-rss-2-fill" title="RSS" href="/feed.xml" />}
        </div>
      )}
    </div>
  )
}

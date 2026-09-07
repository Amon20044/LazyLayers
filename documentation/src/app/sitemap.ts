import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';

const siteUrl = 'https://lazy-layers-cache.vercel.app';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${siteUrl}/docs`,
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    ...source.getPages().map((page) => ({
      url: `${siteUrl}${page.url}`,
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
  ];
}

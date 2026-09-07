import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Inter } from 'next/font/google';
import type { Metadata } from 'next';

const siteUrl = 'https://lazy-layers-cache.vercel.app';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'LazyLayers Docs — Node.js L1/L2 cache',
    template: '%s | LazyLayers Docs',
  },
  description:
    'Install and configure LazyLayers, a lightweight TypeScript hybrid L1/L2 cache for Node.js with Redis, invalidation, stampede protection, resilience, and observability.',
  applicationName: 'LazyLayers',
  generator: 'Next.js',
  referrer: 'strict-origin-when-cross-origin',
  alternates: {
    canonical: '/docs',
    types: {
      'text/plain': [{ url: '/llms.txt' }, { url: '/llms-full.txt' }],
    },
  },
  robots: {
    index: true,
    follow: true,
    'max-image-preview': 'large',
    'max-snippet': -1,
  },
  openGraph: {
    type: 'website',
    siteName: 'LazyLayers',
    title: 'LazyLayers Docs — Node.js L1/L2 cache',
    description:
      'Production-minded documentation for a lightweight TypeScript hybrid L1/L2 cache for Node.js.',
    url: `${siteUrl}/docs`,
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'LazyLayers Docs — Node.js L1/L2 cache',
    description: 'Install and configure LazyLayers for fast, resilient Node.js caching.',
  },
};

const inter = Inter({
  subsets: ['latin'],
});

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}

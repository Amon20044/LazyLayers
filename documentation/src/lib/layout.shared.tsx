import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2 font-bold tracking-tight text-base">
          <span className="flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-cyan-400 via-indigo-500 to-purple-600 text-white font-mono text-xs font-black">
            L
          </span>
          {appName}
        </span>
      ),
    },
    links: [
      {
        text: 'Website',
        url: 'https://lazy-layers-cache.vercel.app',
      },
      {
        text: 'npm',
        url: 'https://www.npmjs.com/package/lazy-layers-cache',
      },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}

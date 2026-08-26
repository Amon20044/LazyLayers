import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';
import React from 'react';

export function BrandLogo() {
  return (
    <div className="flex items-center gap-2.5 font-bold tracking-tight text-sm select-none">
      <svg className="size-6 shrink-0 text-foreground" viewBox="95 91 509 509" fill="none" aria-hidden="true">
        <path d="M131 443 L349 559 L568 443 L531 424 L351 520 L170 425 L131 443 Z" fill="currentColor" />
        <path d="M570 443 L350 561 L129 444 L128 462 L350 584 L563 472 L570 443 Z" fill="#D3F15D" />
        <path d="M128 378 L349 496 L570 378 L566 405 L351 518 L128 399 L128 378 Z" fill="#D3F15D" />
        <path d="M207 139 L230 150 L230 349 L207 338 L207 139 Z" fill="#D3F15D" />
        <path d="M404 107 L426 118 L427 299 L404 287 L404 107 Z" fill="#D3F15D" />
        <path d="M326 328 L480 411 L447 416 L326 351 L326 328 Z" fill="#D3F15D" />
        <path
          d="M403 107 L326 146 L326 326 L481 413 L373 429 L208 341 L205 139 L129 178 L129 377 L347 493 L569 377 L403 288 L403 107 Z"
          fill="currentColor"
        />
      </svg>
      <span className="font-semibold text-[15px]">{appName}</span>
      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-fd-secondary border border-fd-border text-fd-muted-foreground font-normal">
        v0.5
      </span>
    </div>
  );
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <BrandLogo />,
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

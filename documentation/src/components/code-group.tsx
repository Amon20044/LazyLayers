'use client';

import React, { useState } from 'react';
import { cn } from '@/lib/cn';

export function CodeGroup({ children }: { children: React.ReactNode }) {
  const childArray = React.Children.toArray(children).filter(
    (child) => React.isValidElement(child)
  ) as React.ReactElement[];
  if (childArray.length === 0) return null;

  const tabs = childArray.map((child, index) => {
    const props = (child.props || {}) as Record<string, any>;
    let label =
      props.title ||
      props['data-title'] ||
      props.name ||
      props.value ||
      props.label ||
      props['data-label'];

    if (!label && props.children && typeof props.children === 'object') {
      const grandProps = ((props.children as React.ReactElement).props || {}) as Record<string, any>;
      label = grandProps.title || grandProps['data-title'] || grandProps.className?.replace('language-', '');
    }

    if (!label) {
      label = `Tab ${index + 1}`;
    }

    return { label: String(label), child };
  });

  const [activeIndex, setActiveIndex] = useState(0);

  return (
    <div className="my-4 rounded-xl border border-fd-border bg-fd-card overflow-hidden shadow-sm not-prose">
      {/* Switchable Tab Bar */}
      <div className="flex items-center gap-1.5 border-b border-fd-border/70 bg-[#0E0E12] px-2.5 py-1.5 overflow-x-auto scrollbar-none">
        {tabs.map((tab, idx) => {
          const isActive = idx === activeIndex;
          return (
            <button
              key={idx}
              type="button"
              onClick={() => setActiveIndex(idx)}
              className={cn(
                'px-3 py-1 text-xs font-mono font-medium rounded-md transition-all cursor-pointer select-none',
                isActive
                  ? 'bg-[#181822] text-[#D3F15D] shadow-sm border border-fd-border/90 font-semibold'
                  : 'text-fd-muted-foreground hover:text-fd-foreground hover:bg-white/5',
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Active Code Block Container */}
      <div className="p-0 [&_figure]:!my-0 [&_figure]:!border-0 [&_figure]:!rounded-none [&_figure]:!bg-transparent [&_figure]:!shadow-none [&_figure_>_div:first-child]:!hidden">
        {tabs[activeIndex]?.child}
      </div>
    </div>
  );
}

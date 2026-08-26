import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import { AISearch, AISearchPanel, AISearchTrigger } from '@/components/ai/search';
import { MessageCircleIcon, ZapIcon, LayersIcon, RadioIcon, CodeIcon, SlidersIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { buttonVariants } from 'fumadocs-ui/components/ui/button';

export default function Layout({ children }: LayoutProps<'/docs'>) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      {...baseOptions()}
      tabMode="auto"
      tabs={[
        {
          title: 'Quickstart & Guides',
          description: 'Getting started and walkthroughs',
          url: '/docs',
          icon: <ZapIcon className="size-4 text-[#D3F15D]" />,
        },
        {
          title: 'Core Concepts',
          description: 'Layers, invalidation & resilience',
          url: '/docs/concepts/layers',
          icon: <LayersIcon className="size-4 text-cyan-400" />,
        },
        {
          title: 'Event Buses',
          description: 'Redis, RabbitMQ & NATS transports',
          url: '/docs/guides/event-buses',
          icon: <RadioIcon className="size-4 text-emerald-400" />,
        },
        {
          title: 'API Reference',
          description: 'Types and method signatures',
          url: '/docs/reference/api',
          icon: <CodeIcon className="size-4 text-indigo-400" />,
        },
        {
          title: 'Setups & Production',
          description: 'Cluster sizing & checklist',
          url: '/docs/setups/single-process',
          icon: <SlidersIcon className="size-4 text-purple-400" />,
        },
      ]}
    >
      <AISearch>
        <AISearchPanel />
        <AISearchTrigger
          position="float"
          className={cn(
            buttonVariants({
              variant: 'secondary',
              className:
                'text-fd-muted-foreground rounded-2xl border border-fd-border bg-fd-card/80 backdrop-blur-md shadow-lg hover:text-fd-foreground',
            }),
          )}
        >
          <MessageCircleIcon className="size-4.5 text-fd-primary" />
          Ask AI
        </AISearchTrigger>
      </AISearch>

      {children}
    </DocsLayout>
  );
}

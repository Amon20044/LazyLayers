import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { Callout } from 'fumadocs-ui/components/callout';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { File, Folder, Files } from 'fumadocs-ui/components/files';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import { CodeGroup } from '@/components/code-group';
import React from 'react';
import {
  Database,
  Cpu,
  Rocket,
  Layers,
  Zap,
  ShieldCheck,
  ShieldAlert,
  Radio,
  LineChart,
  FileArchive,
  Sliders,
  GraduationCap,
  Route,
  RefreshCw,
  Network,
  Code2,
  CheckSquare,
  History,
  Ban,
  ArrowDown10,
  Server,
  Box,
  Terminal,
  FileText,
  Sparkles,
} from 'lucide-react';

function resolveIcon(icon: React.ReactNode): React.ReactNode {
  if (!icon || typeof icon !== 'string') return icon;

  const key = icon.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const iconProps = { className: 'size-5 shrink-0' };

  switch (key) {
    case 'database':
    case 'redis':
    case 'sql':
      return <Database {...iconProps} className="size-5 shrink-0 text-cyan-400" />;
    case 'node-js':
    case 'nodejs':
    case 'node':
    case 'cpu':
    case 'hardware':
      return <Cpu {...iconProps} className="size-5 shrink-0 text-emerald-400" />;
    case 'rocket':
    case 'launch':
    case 'start':
      return <Rocket {...iconProps} className="size-5 shrink-0 text-amber-400" />;
    case 'layer-group':
    case 'layers':
    case 'stack':
      return <Layers {...iconProps} className="size-5 shrink-0 text-indigo-400" />;
    case 'bolt':
    case 'zap':
    case 'feather':
    case 'lightning':
    case 'flash':
      return <Zap {...iconProps} className="size-5 shrink-0 text-[#D3F15D]" />;
    case 'shield-check':
    case 'shield':
    case 'shield-halved':
    case 'security':
      return <ShieldCheck {...iconProps} className="size-5 shrink-0 text-emerald-400" />;
    case 'bolt-slash':
    case 'shield-alert':
      return <ShieldAlert {...iconProps} className="size-5 shrink-0 text-rose-400" />;
    case 'tower-broadcast':
    case 'radio':
    case 'broadcast':
    case 'event':
      return <Radio {...iconProps} className="size-5 shrink-0 text-purple-400" />;
    case 'chart-line':
    case 'chart':
    case 'gauge':
    case 'metrics':
      return <LineChart {...iconProps} className="size-5 shrink-0 text-cyan-400" />;
    case 'file-zipper':
    case 'archive':
    case 'zip':
      return <FileArchive {...iconProps} className="size-5 shrink-0 text-amber-400" />;
    case 'box':
    case 'boxes':
    case 'package':
      return <Box {...iconProps} className="size-5 shrink-0 text-orange-400" />;
    case 'sliders':
    case 'sliders-horizontal':
    case 'tune':
      return <Sliders {...iconProps} className="size-5 shrink-0 text-pink-400" />;
    case 'graduation-cap':
    case 'school':
    case 'learn':
    case 'book':
      return <GraduationCap {...iconProps} className="size-5 shrink-0 text-lime-400" />;
    case 'route':
    case 'map':
    case 'journey':
      return <Route {...iconProps} className="size-5 shrink-0 text-teal-400" />;
    case 'arrows-rotate':
    case 'refresh':
    case 'sync':
      return <RefreshCw {...iconProps} className="size-5 shrink-0 text-cyan-400" />;
    case 'network-wired':
    case 'network':
    case 'bus':
      return <Network {...iconProps} className="size-5 shrink-0 text-indigo-400" />;
    case 'code':
    case 'code2':
    case 'brackets':
      return <Code2 {...iconProps} className="size-5 shrink-0 text-amber-300" />;
    case 'terminal':
    case 'cli':
      return <Terminal {...iconProps} className="size-5 shrink-0 text-emerald-400" />;
    case 'clipboard-check':
    case 'checklist':
    case 'tasks':
      return <CheckSquare {...iconProps} className="size-5 shrink-0 text-emerald-400" />;
    case 'clock-rotate-left':
    case 'history':
    case 'time':
      return <History {...iconProps} className="size-5 shrink-0 text-amber-400" />;
    case 'ban':
    case 'circle-slash':
    case 'block':
      return <Ban {...iconProps} className="size-5 shrink-0 text-rose-400" />;
    case 'arrow-down-1-9':
    case 'sort':
    case 'order':
      return <ArrowDown10 {...iconProps} className="size-5 shrink-0 text-indigo-400" />;
    case 'server':
    case 'host':
      return <Server {...iconProps} className="size-5 shrink-0 text-blue-400" />;
    case 'file-text':
    case 'doc':
    case 'file':
      return <FileText {...iconProps} className="size-5 shrink-0 text-cyan-400" />;
    default:
      return <Sparkles {...iconProps} className="size-5 shrink-0 text-indigo-400" />;
  }
}

const CustomCard = ({ icon, ...props }: React.ComponentProps<typeof Card>) => {
  return <Card icon={resolveIcon(icon)} {...props} />;
};

const CustomTab = ({ title, value, children, ...props }: React.ComponentProps<typeof Tab> & { title?: string }) => {
  const tabValue = value ?? title ?? 'Tab';
  return (
    <Tab value={tabValue} {...props}>
      {children}
    </Tab>
  );
};

export function ParamField({
  name,
  type,
  required,
  default: defaultValue,
  children,
}: {
  name: string;
  type?: string;
  required?: boolean;
  default?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="my-3 rounded-lg border border-fd-border bg-fd-card p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2 font-mono">
        <span className="font-semibold text-fd-primary">{name}</span>
        {type && <span className="text-xs text-fd-muted-foreground">({type})</span>}
        {required && (
          <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-xs font-semibold text-rose-500">required</span>
        )}
        {defaultValue && <span className="text-xs text-fd-muted-foreground">default: {defaultValue}</span>}
      </div>
      {children && <div className="mt-2 text-fd-muted-foreground">{children}</div>}
    </div>
  );
}

export function ResponseField({
  name,
  type,
  required,
  children,
}: {
  name: string;
  type?: string;
  required?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="my-3 rounded-lg border border-fd-border bg-fd-card p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2 font-mono">
        <span className="font-semibold text-fd-primary">{name}</span>
        {type && <span className="text-xs text-fd-muted-foreground">({type})</span>}
        {required && (
          <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-xs font-semibold text-rose-500">required</span>
        )}
      </div>
      {children && <div className="mt-2 text-fd-muted-foreground">{children}</div>}
    </div>
  );
}

export function Expandable({ title = 'Properties', children }: { title?: string; children?: React.ReactNode }) {
  return (
    <details className="my-2 rounded-lg border border-fd-border bg-fd-muted/30 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-fd-foreground">{title}</summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

export function RequestExample({ children }: { children?: React.ReactNode }) {
  return <div className="my-2">{children}</div>;
}

export function ResponseExample({ children }: { children?: React.ReactNode }) {
  return <div className="my-2">{children}</div>;
}

export function Badge({ children }: { children?: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md bg-fd-primary/10 px-2 py-0.5 text-xs font-medium text-fd-primary">
      {children}
    </span>
  );
}

export function Frame({ children, caption }: { children?: React.ReactNode; caption?: string }) {
  return (
    <figure className="my-4 overflow-hidden rounded-lg border border-fd-border bg-fd-card p-2 text-center">
      {children}
      {caption && <figcaption className="mt-2 text-xs text-fd-muted-foreground">{caption}</figcaption>}
    </figure>
  );
}

export function Tooltip({ children, tip }: { children?: React.ReactNode; tip?: string }) {
  return (
    <span className="cursor-help underline decoration-dotted" title={tip}>
      {children}
    </span>
  );
}

export function Icon({ name, className }: { name?: string; className?: string }) {
  return resolveIcon(name) as React.ReactElement;
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Callout,
    Note: (props: React.ComponentProps<typeof Callout>) => <Callout type="info" {...props} />,
    Tip: (props: React.ComponentProps<typeof Callout>) => <Callout type="info" {...props} />,
    Info: (props: React.ComponentProps<typeof Callout>) => <Callout type="info" {...props} />,
    Warning: (props: React.ComponentProps<typeof Callout>) => <Callout type="warn" {...props} />,
    Check: (props: React.ComponentProps<typeof Callout>) => <Callout type="info" {...props} />,
    Card: CustomCard,
    Cards,
    CardGroup: Cards,
    Columns: Cards,
    Accordion,
    Accordions,
    AccordionGroup: Accordions,
    Tab: CustomTab,
    Tabs,
    CodeGroup,
    Step,
    Steps,
    File,
    Folder,
    Files,
    TypeTable,
    ParamField,
    ResponseField,
    Expandable,
    RequestExample,
    ResponseExample,
    Badge,
    Frame,
    Tooltip,
    Icon,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}

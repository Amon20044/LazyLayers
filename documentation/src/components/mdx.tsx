import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { Callout } from 'fumadocs-ui/components/callout';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { File, Folder, Files } from 'fumadocs-ui/components/files';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import React from 'react';

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
  return <span className={className} />;
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
    Card,
    Cards,
    CardGroup: Cards,
    Columns: Cards,
    Accordion,
    Accordions,
    AccordionGroup: Accordions,
    Tab: CustomTab,
    Tabs,
    CodeGroup: Tabs,
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

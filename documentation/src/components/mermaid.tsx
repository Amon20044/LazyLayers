'use client';

import React, { useEffect, useId, useState, useRef } from 'react';
import mermaid from 'mermaid';
import { cn } from '@/lib/cn';
import { extractTextFromNode } from '@/lib/extract-text';

interface MermaidProps {
  chart?: string;
  children?: React.ReactNode;
  title?: string;
  className?: string;
}

function normalizeMermaidCode(input: string, title?: string): string {
  let code = input
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

  // If title was "sequenceDiagram" or code contains sequence diagram syntax but missing sequenceDiagram header
  const isSequenceSyntax = 
    code.includes('->>') || 
    code.includes('-->>') || 
    code.includes('participant ') || 
    code.includes('actor ') ||
    title?.toLowerCase().includes('sequence');

  const hasHeader = 
    /^(sequenceDiagram|flowchart|graph|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|journey|mindmap|timeline|quadrantChart|C4Context|zenuml|sankey-beta|block-beta)\b/m.test(code);

  if (!hasHeader) {
    if (isSequenceSyntax) {
      code = `sequenceDiagram\n${code}`;
    } else {
      code = `flowchart TB\n${code}`;
    }
  }

  return code;
}

export function Mermaid({ chart, children, title, className }: MermaidProps) {
  const rawChart = typeof chart === 'string' 
    ? chart 
    : typeof children === 'string' 
      ? children 
      : extractTextFromNode(children);

  const cleanChart = normalizeMermaidCode(rawChart, title);
  const rawId = useId();
  const id = `mermaid-${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;
  
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!cleanChart) return;
    let isMounted = true;

    try {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'loose',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        themeVariables: {
          darkMode: true,
          background: '#08080B',
          mainBkg: '#121217',
          textColor: '#EDEDF0',
          primaryColor: '#181822',
          primaryTextColor: '#EDEDF0',
          primaryBorderColor: 'rgba(255, 255, 255, 0.12)',
          lineColor: '#8E8E9C',
          secondaryColor: '#141419',
          tertiaryColor: '#0E0E12',
          noteBkgColor: '#161620',
          noteTextColor: '#D3F15D',
          noteBorderColor: 'rgba(211, 241, 93, 0.35)',
          actorBkg: '#121218',
          actorBorder: 'rgba(255, 255, 255, 0.15)',
          actorTextColor: '#FFFFFF',
          actorLineColor: '#52525E',
          signalColor: '#A2A2B2',
          signalTextColor: '#EDEDF0',
          labelBoxBkgColor: '#161620',
          labelBoxBorderColor: 'rgba(255, 255, 255, 0.12)',
          labelTextColor: '#D2D2DC',
          loopTextColor: '#FFFFFF',
          activationBorderColor: '#D3F15D',
          activationBkgColor: '#181822',
          sequenceNumberColor: '#08080A',
          clusterBkg: '#0E0E14',
          clusterBorder: 'rgba(255, 255, 255, 0.10)',
          edgeLabelBackground: '#0E0E14',
          nodeBorder: 'rgba(255, 255, 255, 0.15)',
          nodeTextColor: '#EDEDF0',
        },
        flowchart: {
          curve: 'basis',
          htmlLabels: true,
          padding: 16,
          nodeSpacing: 40,
          rankSpacing: 40,
        },
        sequence: {
          diagramMarginX: 20,
          diagramMarginY: 20,
          actorMargin: 50,
          width: 150,
          height: 45,
          boxMargin: 10,
          boxTextMargin: 5,
          noteMargin: 10,
          messageMargin: 35,
          mirrorActors: false,
          useMaxWidth: true,
        },
      });

      mermaid
        .render(id, cleanChart)
        .then(({ svg: renderedSvg }) => {
          if (isMounted) {
            setSvg(renderedSvg);
            setError(null);
          }
        })
        .catch((err) => {
          if (isMounted) {
            console.error('Mermaid render error:', err);
            setError(err?.message || 'Failed to render Mermaid diagram');
          }
        });
    } catch (err: any) {
      if (isMounted) {
        setError(err?.message || 'Mermaid initialization error');
      }
    }

    return () => {
      isMounted = false;
    };
  }, [cleanChart, id]);

  if (!cleanChart) return null;

  const displayTitle = title && title !== 'sequenceDiagram' && title !== 'flowchart' ? title : null;

  return (
    <div
      className={cn(
        'my-6 rounded-xl border border-fd-border bg-[#08080B] shadow-md overflow-hidden not-prose',
        className
      )}
    >
      {displayTitle && (
        <div className="flex items-center gap-2 border-b border-fd-border/70 bg-[#0E0E12] px-4 py-2 text-xs font-mono font-medium text-fd-muted-foreground">
          <span className="inline-block size-2 rounded-full bg-[#D3F15D]/80" />
          <span>{displayTitle}</span>
        </div>
      )}

      <div
        ref={containerRef}
        className="p-6 overflow-x-auto flex justify-center items-center min-h-[100px] transition-opacity duration-300 [&_svg]:max-w-full [&_svg]:h-auto [&_svg]:mx-auto"
      >
        {error ? (
          <div className="text-xs font-mono text-rose-400 p-4 bg-rose-950/20 border border-rose-800/30 rounded-lg w-full">
            <p className="font-semibold mb-1">Diagram Render Error</p>
            <p className="text-fd-muted-foreground whitespace-pre-wrap">{cleanChart}</p>
          </div>
        ) : svg ? (
          <div
            className="w-full flex justify-center items-center"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="flex items-center gap-2 text-xs font-mono text-fd-muted-foreground animate-pulse">
            <span className="size-2 rounded-full bg-[#D3F15D] animate-ping" />
            <span>Rendering diagram...</span>
          </div>
        )}
      </div>
    </div>
  );
}

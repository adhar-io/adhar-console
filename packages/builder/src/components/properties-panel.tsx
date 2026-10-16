import React, { useState, useEffect, useCallback } from 'react';
import type { CanvasNode, ProjectFile } from '../lib/builder-types.ts';
import { isContainer } from '../lib/builder-types.ts';
import {
  parseClasses,
  buildClasses,
  FONT_SIZES,
  FONT_WEIGHTS,
  TEXT_COLORS,
  BG_COLORS,
  BORDER_COLORS,
  WIDTHS,
  HEIGHTS,
  SPACING_OPTIONS,
  GAPS,
} from '../lib/tailwind-parser.ts';
import type { ParsedStyles } from '../lib/tailwind-parser.ts';

// ─── Props ──────────────────────────────────────────────────────────────────

interface PropertiesPanelProps {
  selectedNode: CanvasNode | null;
  activeFile: ProjectFile | null;
  activeFilePath: string;
  isActivePage: boolean;
  pageFiles?: { id: string; name: string }[];
  onUpdateProp: (nodeId: string, key: string, value: any) => void;
  onDelete: (nodeId: string) => void;
}

// ─── Opacity options ────────────────────────────────────────────────────────

const OPACITY_OPTIONS = [
  { value: '', label: 'None' },
  ...([0, 5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 95, 100].map((v) => ({
    value: `opacity-${v}`,
    label: `${v}%`,
  }))),
];

// ─── Sub-components ─────────────────────────────────────────────────────────

function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border/50">
      <button type='button'
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 hover:bg-muted/50 transition-colors"
      >
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        <svg
          className={`h-3 w-3 text-muted-foreground transition-transform ${open ? 'rotate-0' : '-rotate-90'}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="px-3 pb-3 space-y-2">{children}</div>}
    </div>
  );
}

function FieldLabel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <label className={`block text-[10px] font-medium text-muted-foreground mb-1 ${className}`}>
      {children}
    </label>
  );
}

function SmallSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 w-full rounded-md border border-input bg-background px-2 text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring"
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function ToggleGroup({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: React.ReactNode; title?: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-md border border-input bg-muted/30 p-0.5">
      {options.map((o) => (
        <button type='button'
          key={o.value}
          title={o.title || String(o.label)}
          onClick={() => onChange(o.value === value ? '' : o.value)}
          className={`flex h-6 min-w-[26px] flex-1 items-center justify-center rounded-md text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
            value === o.value
              ? 'bg-primary/10 text-primary font-semibold shadow-sm'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SmallInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="h-7 w-full rounded-md border border-input bg-background px-2 text-[11px] text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-ring"
    />
  );
}

// ─── Spacing box model ──────────────────────────────────────────────────────

function SpacingBox({
  label,
  top,
  right,
  bottom,
  left,
  onChangeTop,
  onChangeRight,
  onChangeBottom,
  onChangeLeft,
}: {
  label: string;
  top: string;
  right: string;
  bottom: string;
  left: string;
  onChangeTop: (v: string) => void;
  onChangeRight: (v: string) => void;
  onChangeBottom: (v: string) => void;
  onChangeLeft: (v: string) => void;
}) {
  const opts = [{ value: '', label: '-' }, ...SPACING_OPTIONS];
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="relative flex flex-col items-center gap-1">
        {/* Top */}
        <select
          value={top}
          onChange={(e) => onChangeTop(e.target.value)}
          className="h-5 w-14 rounded-md border border-input bg-background px-1 text-center text-[10px] text-foreground outline-none"
        >
          {opts.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {/* Middle row: Left | Box | Right */}
        <div className="flex items-center gap-1">
          <select
            value={left}
            onChange={(e) => onChangeLeft(e.target.value)}
            className="h-5 w-14 rounded-md border border-input bg-background px-1 text-center text-[10px] text-foreground outline-none"
          >
            {opts.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <div className="flex h-5 w-10 items-center justify-center rounded-md border border-dashed border-muted-foreground/30 text-[10px] uppercase tracking-wider text-muted-foreground/50">
            {label === 'Padding' ? 'P' : 'M'}
          </div>
          <select
            value={right}
            onChange={(e) => onChangeRight(e.target.value)}
            className="h-5 w-14 rounded-md border border-input bg-background px-1 text-center text-[10px] text-foreground outline-none"
          >
            {opts.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        {/* Bottom */}
        <select
          value={bottom}
          onChange={(e) => onChangeBottom(e.target.value)}
          className="h-5 w-14 rounded-md border border-input bg-background px-1 text-center text-[10px] text-foreground outline-none"
        >
          {opts.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function PropertiesPanel({
  selectedNode,
  onUpdateProp,
  onDelete,
}: PropertiesPanelProps) {
  const [parsed, setParsed] = useState<ParsedStyles | null>(null);
  const [rawClassName, setRawClassName] = useState('');

  // Sync parsed state when selectedNode changes
  useEffect(() => {
    if (selectedNode) {
      const cn = selectedNode.props.className || '';
      setParsed(parseClasses(cn));
      setRawClassName(cn);
    } else {
      setParsed(null);
      setRawClassName('');
    }
  }, [selectedNode?.id, selectedNode?.props.className]);

  // Commit a change: update parsed, rebuild className, fire callback
  const commit = useCallback(
    (updater: (prev: ParsedStyles) => ParsedStyles) => {
      if (!selectedNode || !parsed) return;
      const next = updater({ ...parsed });
      setParsed(next);
      const newCn = buildClasses(next);
      setRawClassName(newCn);
      onUpdateProp(selectedNode.id, 'className', newCn);
    },
    [selectedNode, parsed, onUpdateProp],
  );

  // Update a single parsed field
  const set = useCallback(
    (key: keyof ParsedStyles, value: string) => {
      commit((p) => ({ ...p, [key]: value }));
    },
    [commit],
  );

  // ─── Empty state ────────────────────────────────────────────────────────

  if (!selectedNode) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground/50 px-6">
        <svg className="mb-3 h-8 w-8 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.042 21.672L13.684 16.6m0 0l-2.51 2.225.569-9.47 5.227 7.917-3.286-.672zM12 2.25V4.5m5.834.166l-1.591 1.591M20.25 10.5H18M7.757 14.743l-1.59 1.59M6 10.5H3.75m4.007-4.243l-1.59-1.59" />
        </svg>
        <p className="text-[11px] text-center">Select an element on the canvas to edit its properties</p>
      </div>
    );
  }

  if (!parsed) return null;

  const nodeType = selectedNode.type;
  const showLayout = isContainer(nodeType);
  const hasTextContent =
    selectedNode.props.children && typeof selectedNode.props.children === 'string';
  const showPlaceholder = ['input', 'textarea'].includes(nodeType);

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col text-foreground" style={{ width: "100%" }}>
      {/* ── 1. Node Info Header ────────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
            {nodeType}
          </span>
          <span className="text-[10px] text-muted-foreground truncate max-w-[120px]" title={selectedNode.id}>
            {selectedNode.id.slice(0, 12)}
          </span>
        </div>
        <button type='button'
          onClick={() => onDelete(selectedNode.id)}
          title="Delete element"
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>

      {/* ── 2. Content ─────────────────────────────────────────────────────── */}
      {(hasTextContent || showPlaceholder) && (
        <Section title="Content">
          {hasTextContent && (
            <div>
              <FieldLabel>Text content</FieldLabel>
              <SmallInput
                value={selectedNode.props.children || ''}
                onChange={(v) => onUpdateProp(selectedNode.id, 'children', v)}
                placeholder="Enter text..."
              />
            </div>
          )}
          {showPlaceholder && (
            <div>
              <FieldLabel>Placeholder</FieldLabel>
              <SmallInput
                value={selectedNode.props.placeholder || ''}
                onChange={(v) => onUpdateProp(selectedNode.id, 'placeholder', v)}
                placeholder="Placeholder text..."
              />
            </div>
          )}
        </Section>
      )}

      {/* ── 3. Layout ──────────────────────────────────────────────────────── */}
      {showLayout && (
        <Section title="Layout">
          <div>
            <FieldLabel>Flex Direction</FieldLabel>
            <ToggleGroup
              value={parsed.flexDir}
              onChange={(v) => set('flexDir', v)}
              options={[
                { value: 'flex-row', label: '\u2192', title: 'Row' },
                { value: 'flex-col', label: '\u2193', title: 'Column' },
                { value: 'flex-row-reverse', label: '\u2190', title: 'Row Reverse' },
                { value: 'flex-col-reverse', label: '\u2191', title: 'Column Reverse' },
              ]}
            />
          </div>

          <div>
            <FieldLabel>Justify Content</FieldLabel>
            <ToggleGroup
              value={parsed.justify}
              onChange={(v) => set('justify', v)}
              options={[
                { value: 'justify-start', label: <JustifyIcon type="start" />, title: 'Start' },
                { value: 'justify-center', label: <JustifyIcon type="center" />, title: 'Center' },
                { value: 'justify-end', label: <JustifyIcon type="end" />, title: 'End' },
                { value: 'justify-between', label: <JustifyIcon type="between" />, title: 'Space Between' },
                { value: 'justify-around', label: <JustifyIcon type="around" />, title: 'Space Around' },
              ]}
            />
          </div>

          <div>
            <FieldLabel>Align Items</FieldLabel>
            <ToggleGroup
              value={parsed.align}
              onChange={(v) => set('align', v)}
              options={[
                { value: 'items-start', label: <AlignIcon type="start" />, title: 'Start' },
                { value: 'items-center', label: <AlignIcon type="center" />, title: 'Center' },
                { value: 'items-end', label: <AlignIcon type="end" />, title: 'End' },
                { value: 'items-stretch', label: <AlignIcon type="stretch" />, title: 'Stretch' },
              ]}
            />
          </div>

          <div>
            <FieldLabel>Gap</FieldLabel>
            <SmallSelect
              value={parsed.gap}
              onChange={(v) => set('gap', v)}
              options={[{ value: '', label: 'None' }, ...GAPS.map((g) => ({ value: g, label: g.replace('gap-', '') }))]}
            />
          </div>
        </Section>
      )}

      {/* ── 4. Spacing ─────────────────────────────────────────────────────── */}
      <Section title="Spacing">
        <SpacingBox
          label="Padding"
          top={parsed.padT}
          right={parsed.padR}
          bottom={parsed.padB}
          left={parsed.padL}
          onChangeTop={(v) => set('padT', v)}
          onChangeRight={(v) => set('padR', v)}
          onChangeBottom={(v) => set('padB', v)}
          onChangeLeft={(v) => set('padL', v)}
        />
        <div className="h-1" />
        <SpacingBox
          label="Margin"
          top={parsed.marT}
          right={parsed.marR}
          bottom={parsed.marB}
          left={parsed.marL}
          onChangeTop={(v) => set('marT', v)}
          onChangeRight={(v) => set('marR', v)}
          onChangeBottom={(v) => set('marB', v)}
          onChangeLeft={(v) => set('marL', v)}
        />
      </Section>

      {/* ── 5. Typography ──────────────────────────────────────────────────── */}
      <Section title="Typography">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <FieldLabel>Font Size</FieldLabel>
            <SmallSelect
              value={parsed.fontSize}
              onChange={(v) => set('fontSize', v)}
              options={[{ value: '', label: 'Default' }, ...FONT_SIZES]}
            />
          </div>
          <div>
            <FieldLabel>Font Weight</FieldLabel>
            <SmallSelect
              value={parsed.fontWeight}
              onChange={(v) => set('fontWeight', v)}
              options={[{ value: '', label: 'Default' }, ...FONT_WEIGHTS]}
            />
          </div>
        </div>

        <div>
          <FieldLabel>Text Color</FieldLabel>
          <SmallSelect
            value={parsed.textColor}
            onChange={(v) => set('textColor', v)}
            options={[{ value: '', label: 'Default' }, ...TEXT_COLORS]}
          />
        </div>

        <div>
          <FieldLabel>Text Align</FieldLabel>
          <ToggleGroup
            value={parsed.textAlign}
            onChange={(v) => set('textAlign', v)}
            options={[
              { value: 'text-left', label: <TextAlignIcon type="left" />, title: 'Left' },
              { value: 'text-center', label: <TextAlignIcon type="center" />, title: 'Center' },
              { value: 'text-right', label: <TextAlignIcon type="right" />, title: 'Right' },
              { value: 'text-justify', label: <TextAlignIcon type="justify" />, title: 'Justify' },
            ]}
          />
        </div>
      </Section>

      {/* ── 6. Background ──────────────────────────────────────────────────── */}
      <Section title="Background">
        <div>
          <FieldLabel>Background Color</FieldLabel>
          <SmallSelect
            value={parsed.bgColor}
            onChange={(v) => set('bgColor', v)}
            options={BG_COLORS}
          />
        </div>
        <div>
          <FieldLabel>Opacity</FieldLabel>
          <SmallSelect
            value={parsed.opacity}
            onChange={(v) => set('opacity', v)}
            options={OPACITY_OPTIONS}
          />
        </div>
      </Section>

      {/* ── 7. Border ──────────────────────────────────────────────────────── */}
      <Section title="Border">
        <div>
          <FieldLabel>Border Width</FieldLabel>
          <ToggleGroup
            value={parsed.borderWidth}
            onChange={(v) => set('borderWidth', v)}
            options={[
              { value: '', label: '0', title: 'None' },
              { value: 'border', label: '1', title: '1px' },
              { value: 'border-2', label: '2', title: '2px' },
              { value: 'border-4', label: '4', title: '4px' },
            ]}
          />
        </div>
        <div>
          <FieldLabel>Border Radius</FieldLabel>
          <ToggleGroup
            value={parsed.borderRadius}
            onChange={(v) => set('borderRadius', v)}
            options={[
              { value: '', label: <RadiusIcon r={0} />, title: 'None' },
              { value: 'rounded-sm', label: <RadiusIcon r={2} />, title: 'SM' },
              { value: 'rounded', label: <RadiusIcon r={3} />, title: 'MD' },
              { value: 'rounded-md', label: <RadiusIcon r={4} />, title: 'MD+' },
              { value: 'rounded-lg', label: <RadiusIcon r={5} />, title: 'LG' },
              { value: 'rounded-xl', label: <RadiusIcon r={6} />, title: 'XL' },
              { value: 'rounded-2xl', label: <RadiusIcon r={7} />, title: '2XL' },
              { value: 'rounded-full', label: <RadiusIcon r={99} />, title: 'Full' },
            ]}
          />
        </div>
        <div>
          <FieldLabel>Border Color</FieldLabel>
          <SmallSelect
            value={parsed.borderColor}
            onChange={(v) => set('borderColor', v)}
            options={[{ value: '', label: 'None' }, ...BORDER_COLORS]}
          />
        </div>
      </Section>

      {/* ── 8. Size ────────────────────────────────────────────────────────── */}
      <Section title="Size">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <FieldLabel>Width</FieldLabel>
            <SmallSelect
              value={parsed.width}
              onChange={(v) => set('width', v)}
              options={WIDTHS}
            />
          </div>
          <div>
            <FieldLabel>Height</FieldLabel>
            <SmallSelect
              value={parsed.height}
              onChange={(v) => set('height', v)}
              options={HEIGHTS}
            />
          </div>
        </div>
      </Section>

      {/* ── 8b. Position (freeform mode) ──────────────────────────────────── */}
      {(selectedNode.x !== undefined || selectedNode.y !== undefined) && (
        <Section title="Position" defaultOpen>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <FieldLabel>X</FieldLabel>
              <input type="number" value={Math.round(selectedNode.x || 0)}
                onChange={(e) => onUpdateProp(selectedNode.id, 'x', parseInt(e.target.value) || 0)}
                className="input-sm text-[11px] tabular-nums" step={1} />
            </div>
            <div>
              <FieldLabel>Y</FieldLabel>
              <input type="number" value={Math.round(selectedNode.y || 0)}
                onChange={(e) => onUpdateProp(selectedNode.id, 'y', parseInt(e.target.value) || 0)}
                className="input-sm text-[11px] tabular-nums" step={1} />
            </div>
            <div>
              <FieldLabel>W</FieldLabel>
              <input type="number" value={Math.round(selectedNode.width || 0)}
                onChange={(e) => onUpdateProp(selectedNode.id, 'width', parseInt(e.target.value) || 0)}
                className="input-sm text-[11px] tabular-nums" step={1} min={10} />
            </div>
            <div>
              <FieldLabel>H</FieldLabel>
              <input type="number" value={Math.round(selectedNode.height || 0)}
                onChange={(e) => onUpdateProp(selectedNode.id, 'height', parseInt(e.target.value) || 0)}
                className="input-sm text-[11px] tabular-nums" step={1} min={10} />
            </div>
          </div>
        </Section>
      )}

      {/* Interactions live in the studio inspector (On click). */}

      {/* ── 10. Comments / Feedback ──────────────────────────────────────── */}
      <Section title={`Comments${selectedNode.comments?.length ? ` (${selectedNode.comments.length})` : ''}`} defaultOpen={false}>
        <div className="space-y-2">
          {/* Existing comments */}
          {(selectedNode.comments || []).map((comment) => (
            <div key={comment.id} className={`rounded-lg border p-2 text-[10px] ${comment.resolved ? 'border-border/30 opacity-50' : 'border-primary/20 bg-primary/[0.02]'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="font-semibold text-foreground">{comment.author}</span>
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground/40">{new Date(comment.timestamp).toLocaleDateString()}</span>
                  <button type='button'
                    onClick={() => {
                      const updated = (selectedNode.comments || []).map((c) => c.id === comment.id ? { ...c, resolved: !c.resolved } : c);
                      onUpdateProp(selectedNode.id, 'comments', updated);
                    }}
                    className="text-[9px] text-muted-foreground hover:text-foreground transition-colors"
                    title={comment.resolved ? 'Unresolve' : 'Resolve'}
                  >{comment.resolved ? '↩' : '✓'}</button>
                  <button type='button'
                    onClick={() => {
                      const updated = (selectedNode.comments || []).filter((c) => c.id !== comment.id);
                      onUpdateProp(selectedNode.id, 'comments', updated);
                    }}
                    className="text-[9px] text-destructive hover:text-destructive/80 transition-colors"
                    title="Delete"
                  >×</button>
                </div>
              </div>
              <p className="text-muted-foreground leading-relaxed">{comment.text}</p>
            </div>
          ))}

          {/* Add comment */}
          <div className="flex gap-1.5">
            <input
              id={`comment-input-${selectedNode.id}`}
              placeholder="Add a comment..."
              className="input-sm text-[10px] flex-1"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) {
                  const text = (e.target as HTMLInputElement).value.trim();
                  const newComment = { id: `c_${Date.now()}`, author: 'You', text, resolved: false, timestamp: Date.now() };
                  onUpdateProp(selectedNode.id, 'comments', [...(selectedNode.comments || []), newComment]);
                  (e.target as HTMLInputElement).value = '';
                }
              }}
            />
            <button type='button'
              onClick={() => {
                const input = document.getElementById(`comment-input-${selectedNode.id}`) as HTMLInputElement;
                if (input?.value.trim()) {
                  const newComment = { id: `c_${Date.now()}`, author: 'You', text: input.value.trim(), resolved: false, timestamp: Date.now() };
                  onUpdateProp(selectedNode.id, 'comments', [...(selectedNode.comments || []), newComment]);
                  input.value = '';
                }
              }}
              className="btn-icon-sm !h-7 !w-7"
              title="Add comment"
            >
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
            </button>
          </div>
        </div>
      </Section>

      {/* ── 11. Advanced ───────────────────────────────────────────────────── */}
      <Section title="Advanced" defaultOpen={false}>
        <div>
          <FieldLabel>Raw className</FieldLabel>
          <textarea
            value={rawClassName}
            onChange={(e) => {
              setRawClassName(e.target.value);
            }}
            onBlur={() => {
              if (!selectedNode) return;
              const next = parseClasses(rawClassName);
              setParsed(next);
              onUpdateProp(selectedNode.id, 'className', rawClassName);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
            className="h-20 w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-[10px] font-mono text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-ring"
            placeholder="Tailwind classes..."
            spellCheck={false}
          />
          <p className="mt-1 text-[10px] text-muted-foreground/60">
            Press Enter or blur to apply. Unknown classes are preserved.
          </p>
        </div>
      </Section>
    </div>
  );
}

// ─── Tiny SVG icons for visual toggles ──────────────────────────────────────

function JustifyIcon({ type }: { type: 'start' | 'center' | 'end' | 'between' | 'around' }) {
  const w = 18;
  const h = 10;
  const bar = 3;
  const positions: Record<string, number[]> = {
    start: [1, 5],
    center: [5, 9],
    end: [10, 14],
    between: [1, 14],
    around: [4, 11],
  };
  const [x1, x2] = positions[type];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="fill-current">
      <rect x={x1} y={2} width={bar} height={h - 4} rx={0.5} />
      <rect x={x2} y={2} width={bar} height={h - 4} rx={0.5} />
    </svg>
  );
}

function AlignIcon({ type }: { type: 'start' | 'center' | 'end' | 'stretch' }) {
  const w = 18;
  const h = 12;
  const bars: Record<string, Array<{ x: number; y: number; w: number; h: number }>> = {
    start: [
      { x: 3, y: 1, w: 3, h: 5 },
      { x: 8, y: 1, w: 3, h: 7 },
      { x: 13, y: 1, w: 3, h: 4 },
    ],
    center: [
      { x: 3, y: 2, w: 3, h: 5 },
      { x: 8, y: 1, w: 3, h: 7 },
      { x: 13, y: 3, w: 3, h: 4 },
    ],
    end: [
      { x: 3, y: 6, w: 3, h: 5 },
      { x: 8, y: 4, w: 3, h: 7 },
      { x: 13, y: 7, w: 3, h: 4 },
    ],
    stretch: [
      { x: 3, y: 1, w: 3, h: 10 },
      { x: 8, y: 1, w: 3, h: 10 },
      { x: 13, y: 1, w: 3, h: 10 },
    ],
  };
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="fill-current">
      {bars[type].map((b, i) => (
        <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx={0.5} />
      ))}
    </svg>
  );
}

function TextAlignIcon({ type }: { type: 'left' | 'center' | 'right' | 'justify' }) {
  const w = 14;
  const h = 10;
  const lines: Record<string, Array<{ x: number; w: number }>> = {
    left: [
      { x: 1, w: 12 },
      { x: 1, w: 8 },
      { x: 1, w: 10 },
    ],
    center: [
      { x: 1, w: 12 },
      { x: 3, w: 8 },
      { x: 2, w: 10 },
    ],
    right: [
      { x: 1, w: 12 },
      { x: 5, w: 8 },
      { x: 3, w: 10 },
    ],
    justify: [
      { x: 1, w: 12 },
      { x: 1, w: 12 },
      { x: 1, w: 12 },
    ],
  };
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="fill-current">
      {lines[type].map((l, i) => (
        <rect key={i} x={l.x} y={1 + i * 3} width={l.w} height={1.5} rx={0.5} />
      ))}
    </svg>
  );
}

function RadiusIcon({ r }: { r: number }) {
  const s = 12;
  const inset = 1;
  const size = s - inset * 2;
  const cr = r === 99 ? size / 2 : r;
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`}>
      <rect
        x={inset}
        y={inset}
        width={size}
        height={size}
        rx={cr}
        className="fill-none stroke-current"
        strokeWidth={1.5}
      />
    </svg>
  );
}

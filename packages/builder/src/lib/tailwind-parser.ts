// ─── Bidirectional Tailwind Class Parser ─────────────────────────────────────
// Parses a className string into structured properties,
// and rebuilds it after visual edits. Unknown classes are preserved.

export interface ParsedStyles {
  display: string;
  flexDir: string;
  justify: string;
  align: string;
  gap: string;
  padT: string; padR: string; padB: string; padL: string;
  marT: string; marR: string; marB: string; marL: string;
  fontSize: string;
  fontWeight: string;
  textColor: string;
  textAlign: string;
  bgColor: string;
  opacity: string;
  borderWidth: string;
  borderRadius: string;
  borderColor: string;
  width: string;
  height: string;
  other: string[];
}

// ─── Mapping tables ──────────────────────────────────────────────────────────

export const DISPLAYS = ['block', 'inline-block', 'inline', 'flex', 'inline-flex', 'grid', 'inline-grid', 'hidden'];
export const FLEX_DIRS = ['flex-row', 'flex-row-reverse', 'flex-col', 'flex-col-reverse'];
export const JUSTIFIES = ['justify-start', 'justify-center', 'justify-end', 'justify-between', 'justify-around', 'justify-evenly'];
export const ALIGNS = ['items-start', 'items-center', 'items-end', 'items-stretch', 'items-baseline'];
export const GAPS = ['gap-0', 'gap-0.5', 'gap-1', 'gap-1.5', 'gap-2', 'gap-2.5', 'gap-3', 'gap-4', 'gap-5', 'gap-6', 'gap-8', 'gap-10', 'gap-12', 'gap-16'];

const SPACING_VALS = ['0', '0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '5', '6', '7', '8', '9', '10', '11', '12', '14', '16', '20', '24', '28', '32', '36', '40', '44', '48', '52', '56', '60', '64', '72', '80', '96'];
export const SPACING_OPTIONS = SPACING_VALS.map((v) => ({ value: v, label: v }));

export const FONT_SIZES = [
  { value: 'text-xs', label: 'xs (12px)' }, { value: 'text-sm', label: 'sm (14px)' },
  { value: 'text-base', label: 'base (16px)' }, { value: 'text-lg', label: 'lg (18px)' },
  { value: 'text-xl', label: 'xl (20px)' }, { value: 'text-2xl', label: '2xl (24px)' },
  { value: 'text-3xl', label: '3xl (30px)' }, { value: 'text-4xl', label: '4xl (36px)' },
  { value: 'text-5xl', label: '5xl (48px)' }, { value: 'text-6xl', label: '6xl (60px)' },
];

export const FONT_WEIGHTS = [
  { value: 'font-thin', label: 'Thin' }, { value: 'font-extralight', label: 'Extra Light' },
  { value: 'font-light', label: 'Light' }, { value: 'font-normal', label: 'Normal' },
  { value: 'font-medium', label: 'Medium' }, { value: 'font-semibold', label: 'Semibold' },
  { value: 'font-bold', label: 'Bold' }, { value: 'font-extrabold', label: 'Extra Bold' },
  { value: 'font-black', label: 'Black' },
];

export const TEXT_ALIGNS = ['text-left', 'text-center', 'text-right', 'text-justify'];

export const TEXT_COLORS = [
  { value: 'text-foreground', label: 'Foreground' },
  { value: 'text-muted-foreground', label: 'Muted' },
  { value: 'text-primary', label: 'Primary' },
  { value: 'text-primary-foreground', label: 'Primary FG' },
  { value: 'text-secondary-foreground', label: 'Secondary FG' },
  { value: 'text-destructive', label: 'Destructive' },
  { value: 'text-white', label: 'White' },
  { value: 'text-black', label: 'Black' },
  { value: 'text-zinc-500', label: 'Zinc 500' },
  { value: 'text-zinc-400', label: 'Zinc 400' },
  { value: 'text-zinc-300', label: 'Zinc 300' },
];

export const BG_COLORS = [
  { value: '', label: 'None' },
  { value: 'bg-background', label: 'Background' },
  { value: 'bg-card', label: 'Card' },
  { value: 'bg-muted', label: 'Muted' },
  { value: 'bg-primary', label: 'Primary' },
  { value: 'bg-primary/10', label: 'Primary 10%' },
  { value: 'bg-primary/20', label: 'Primary 20%' },
  { value: 'bg-secondary', label: 'Secondary' },
  { value: 'bg-accent', label: 'Accent' },
  { value: 'bg-destructive', label: 'Destructive' },
  { value: 'bg-white', label: 'White' },
  { value: 'bg-zinc-50', label: 'Zinc 50' },
  { value: 'bg-zinc-100', label: 'Zinc 100' },
  { value: 'bg-zinc-900', label: 'Zinc 900' },
  { value: 'bg-zinc-950', label: 'Zinc 950' },
];

export const BORDER_WIDTHS = ['', 'border', 'border-2', 'border-4', 'border-8'];
export const BORDER_RADII = [
  { value: '', label: 'None' }, { value: 'rounded-sm', label: 'SM' }, { value: 'rounded', label: 'MD' },
  { value: 'rounded-md', label: 'MD+' }, { value: 'rounded-lg', label: 'LG' },
  { value: 'rounded-xl', label: 'XL' }, { value: 'rounded-2xl', label: '2XL' },
  { value: 'rounded-full', label: 'Full' },
];

export const BORDER_COLORS = [
  { value: 'border-border', label: 'Border' }, { value: 'border-input', label: 'Input' },
  { value: 'border-primary', label: 'Primary' }, { value: 'border-primary/30', label: 'Primary 30%' },
  { value: 'border-destructive', label: 'Destructive' },
  { value: 'border-transparent', label: 'Transparent' },
  { value: 'border-zinc-200', label: 'Zinc 200' }, { value: 'border-zinc-700', label: 'Zinc 700' },
];

export const WIDTHS = [
  { value: '', label: 'Auto' }, { value: 'w-full', label: 'Full' },
  { value: 'w-1/2', label: '1/2' }, { value: 'w-1/3', label: '1/3' }, { value: 'w-2/3', label: '2/3' },
  { value: 'w-1/4', label: '1/4' }, { value: 'w-3/4', label: '3/4' },
  { value: 'w-screen', label: 'Screen' }, { value: 'w-fit', label: 'Fit' },
  { value: 'w-min', label: 'Min' }, { value: 'w-max', label: 'Max' },
  { value: 'max-w-sm', label: 'Max SM' }, { value: 'max-w-md', label: 'Max MD' },
  { value: 'max-w-lg', label: 'Max LG' }, { value: 'max-w-xl', label: 'Max XL' },
  { value: 'max-w-2xl', label: 'Max 2XL' }, { value: 'max-w-4xl', label: 'Max 4XL' },
  { value: 'max-w-7xl', label: 'Max 7XL' },
];

export const HEIGHTS = [
  { value: '', label: 'Auto' }, { value: 'h-full', label: 'Full' },
  { value: 'h-screen', label: 'Screen' }, { value: 'h-fit', label: 'Fit' },
  { value: 'h-min', label: 'Min' }, { value: 'h-max', label: 'Max' },
  { value: 'min-h-[400px]', label: '400px' }, { value: 'min-h-[500px]', label: '500px' },
];

// ─── Parser ──────────────────────────────────────────────────────────────────

const PAD_RE = /^p([trbl])?-(\[?.+?\]?)$/;
const MAR_RE = /^-?m([trbl])?-(\[?.+?\]?)$/;
const PAD_X_RE = /^px-(\[?.+?\]?)$/;
const PAD_Y_RE = /^py-(\[?.+?\]?)$/;
const MAR_X_RE = /^mx-(\[?.+?\]?)$/;
const MAR_Y_RE = /^my-(\[?.+?\]?)$/;

export function parseClasses(className: string): ParsedStyles {
  const cls = (className || '').split(/\s+/).filter(Boolean);
  const result: ParsedStyles = {
    display: '', flexDir: '', justify: '', align: '', gap: '',
    padT: '', padR: '', padB: '', padL: '',
    marT: '', marR: '', marB: '', marL: '',
    fontSize: '', fontWeight: '', textColor: '', textAlign: '',
    bgColor: '', opacity: '',
    borderWidth: '', borderRadius: '', borderColor: '',
    width: '', height: '',
    other: [],
  };

  for (const c of cls) {
    if (DISPLAYS.includes(c)) { result.display = c; continue; }
    if (FLEX_DIRS.includes(c)) { result.flexDir = c; continue; }
    if (JUSTIFIES.includes(c)) { result.justify = c; continue; }
    if (ALIGNS.includes(c)) { result.align = c; continue; }
    if (c.startsWith('gap-')) { result.gap = c; continue; }

    // Padding
    const pm = c.match(PAD_RE);
    if (pm) {
      const side = pm[1]; const val = pm[2];
      if (!side) { result.padT = val; result.padR = val; result.padB = val; result.padL = val; }
      else if (side === 't') result.padT = val;
      else if (side === 'r') result.padR = val;
      else if (side === 'b') result.padB = val;
      else if (side === 'l') result.padL = val;
      continue;
    }
    const pxm = c.match(PAD_X_RE);
    if (pxm) { result.padR = pxm[1]; result.padL = pxm[1]; continue; }
    const pym = c.match(PAD_Y_RE);
    if (pym) { result.padT = pym[1]; result.padB = pym[1]; continue; }

    // Margin
    const mm = c.match(MAR_RE);
    if (mm) {
      const side = mm[1]; const val = mm[2];
      if (!side) { result.marT = val; result.marR = val; result.marB = val; result.marL = val; }
      else if (side === 't') result.marT = val;
      else if (side === 'r') result.marR = val;
      else if (side === 'b') result.marB = val;
      else if (side === 'l') result.marL = val;
      continue;
    }
    const mxm = c.match(MAR_X_RE);
    if (mxm) { result.marR = mxm[1]; result.marL = mxm[1]; continue; }
    const mym = c.match(MAR_Y_RE);
    if (mym) { result.marT = mym[1]; result.marB = mym[1]; continue; }

    // Typography
    if (FONT_SIZES.some((f) => f.value === c)) { result.fontSize = c; continue; }
    if (FONT_WEIGHTS.some((f) => f.value === c)) { result.fontWeight = c; continue; }
    if (TEXT_ALIGNS.includes(c)) { result.textAlign = c; continue; }
    if (c.startsWith('text-') && TEXT_COLORS.some((t) => t.value === c)) { result.textColor = c; continue; }

    // Background
    if (BG_COLORS.some((b) => b.value === c)) { result.bgColor = c; continue; }

    // Opacity
    if (c.startsWith('opacity-')) { result.opacity = c; continue; }

    // Border
    if (BORDER_WIDTHS.includes(c)) { result.borderWidth = c; continue; }
    if (BORDER_RADII.some((r) => r.value === c)) { result.borderRadius = c; continue; }
    if (BORDER_COLORS.some((b) => b.value === c)) { result.borderColor = c; continue; }

    // Size
    if (WIDTHS.some((w) => w.value === c)) { result.width = c; continue; }
    if (HEIGHTS.some((h) => h.value === c)) { result.height = c; continue; }

    // Unknown — preserve
    result.other.push(c);
  }

  return result;
}

export function buildClasses(p: ParsedStyles): string {
  const parts: string[] = [];

  if (p.display) parts.push(p.display);
  if (p.flexDir) parts.push(p.flexDir);
  if (p.justify) parts.push(p.justify);
  if (p.align) parts.push(p.align);
  if (p.gap) parts.push(p.gap);

  // Padding — try to collapse
  if (p.padT && p.padT === p.padR && p.padR === p.padB && p.padB === p.padL) {
    parts.push(`p-${p.padT}`);
  } else {
    if (p.padT && p.padT === p.padB && p.padL && p.padL === p.padR) {
      parts.push(`py-${p.padT}`); parts.push(`px-${p.padL}`);
    } else {
      if (p.padT) parts.push(`pt-${p.padT}`);
      if (p.padR) parts.push(`pr-${p.padR}`);
      if (p.padB) parts.push(`pb-${p.padB}`);
      if (p.padL) parts.push(`pl-${p.padL}`);
    }
  }

  // Margin — same collapse logic
  if (p.marT && p.marT === p.marR && p.marR === p.marB && p.marB === p.marL) {
    parts.push(`m-${p.marT}`);
  } else {
    if (p.marT && p.marT === p.marB && p.marL && p.marL === p.marR) {
      parts.push(`my-${p.marT}`); parts.push(`mx-${p.marL}`);
    } else {
      if (p.marT) parts.push(`mt-${p.marT}`);
      if (p.marR) parts.push(`mr-${p.marR}`);
      if (p.marB) parts.push(`mb-${p.marB}`);
      if (p.marL) parts.push(`ml-${p.marL}`);
    }
  }

  if (p.fontSize) parts.push(p.fontSize);
  if (p.fontWeight) parts.push(p.fontWeight);
  if (p.textColor) parts.push(p.textColor);
  if (p.textAlign) parts.push(p.textAlign);
  if (p.bgColor) parts.push(p.bgColor);
  if (p.opacity) parts.push(p.opacity);
  if (p.borderWidth) parts.push(p.borderWidth);
  if (p.borderRadius) parts.push(p.borderRadius);
  if (p.borderColor) parts.push(p.borderColor);
  if (p.width) parts.push(p.width);
  if (p.height) parts.push(p.height);

  parts.push(...p.other);

  return parts.filter(Boolean).join(' ');
}

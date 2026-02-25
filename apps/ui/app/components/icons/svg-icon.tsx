import spriteSvg from '#components/icons/generated/sprite.svg';
import type { SvgIcons } from '#components/icons/generated/svg-icons.js';
import manifoldPng from '#components/icons/raw/manifold.png?url';

const iconAliases: Record<string, SvgIcons> = {};

const pngIcons: Record<string, string> = {
  // Manifold has no SVG icon, this can be removed when there is one.
  manifold: manifoldPng,
};

export function SvgIcon({
  id,
  className,
  ...properties
}: React.SVGProps<SVGSVGElement> & { readonly id: string }): React.JSX.Element {
  const pngSrc = pngIcons[id];
  if (pngSrc) {
    return <img src={pngSrc} alt={id} className={className} />;
  }

  const resolvedIconId = iconAliases[id] ?? (id as SvgIcons);

  return (
    <svg {...properties} className={className} viewBox="0 0 56 56">
      <use href={`${spriteSvg}#${resolvedIconId}`} />
    </svg>
  );
}

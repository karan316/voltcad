/**
 * VoltCAD brand mark — an isometric cube (the CAD) with a lightning bolt
 * carved through its front faces as negative space (the volt).
 *
 * Three flat indigo tones give the cube form; the bolt is a mask cut, so the
 * mark sits cleanly on any background, light or dark. No gradients, no
 * strokes — scales from favicon to splash screen.
 *
 * Keep in sync with apps/web/public/favicon.svg (standalone copy).
 */
export function Logo(props: { size?: number; className?: string }) {
  const size = props.size ?? 24;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={props.className}
      aria-label="VoltCAD"
      role="img"
    >
      <defs>
        <mask id="voltcad-bolt-cut">
          <rect width="64" height="64" fill="#fff" />
          {/* the bolt — pierces from the top face through the bottom edge */}
          <polygon
            points="37,22 23.5,44 30.8,44 27.2,59.5 40.5,40 33.2,40"
            fill="#000"
          />
        </mask>
      </defs>
      <g mask="url(#voltcad-bolt-cut)">
        {/* top face */}
        <polygon points="32,4 56,17.5 32,31 8,17.5" fill="#7C97FF" />
        {/* left face */}
        <polygon points="8,17.5 32,31 32,60 8,46.5" fill="#1B2878" />
        {/* right face */}
        <polygon points="32,31 56,17.5 56,46.5 32,60" fill="#4761E0" />
      </g>
    </svg>
  );
}

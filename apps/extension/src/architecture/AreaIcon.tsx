import type { ReactNode } from 'react'
import { sollitLogo } from './sollitLogo.ts'

/** Every mark is drawn on the same dark tile, 18 by 18, so they sit alike on a light and a dark page. */
const TILE = '#16181d'

const react = (
  <g fill="none" stroke="#61dafb" strokeWidth={0.9}>
    <ellipse cx={9} cy={9} rx={6.6} ry={2.6} />
    <ellipse cx={9} cy={9} rx={6.6} ry={2.6} transform="rotate(60 9 9)" />
    <ellipse cx={9} cy={9} rx={6.6} ry={2.6} transform="rotate(120 9 9)" />
    <circle cx={9} cy={9} r={1.2} fill="#61dafb" stroke="none" />
  </g>
)

const sollit = (
  <g transform={`translate(2.5,${(18 - sollitLogo.height * 0.325) / 2}) scale(0.325)`} fill={sollitLogo.fill}>
    {sollitLogo.paths.map((d) => (
      <path key={d.slice(0, 24)} d={d} />
    ))}
  </g>
)

/** A key: the service that signs people in and hands out their tokens. */
const key = (
  <g fill="none" stroke="#f2c94c" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
    <circle cx={6.4} cy={11.6} r={2.6} />
    <path d="M8.3 9.7 L13.8 4.2 M11.6 6.4 L13.4 8.2 M13 5 L14.6 6.6" />
  </g>
)

/** A four-point spark, as AI features are marked everywhere. */
const spark = <path d="M9 3.2 L10.5 7.5 L14.8 9 L10.5 10.5 L9 14.8 L7.5 10.5 L3.2 9 L7.5 7.5 Z" fill="#bb6bd9" />

const phone = (
  <g fill="none" stroke="#61dafb" strokeWidth={1.2}>
    <rect x={5.6} y={3.2} width={6.8} height={11.6} rx={1.6} />
    <path d="M8 12.6 h2" strokeLinecap="round" />
  </g>
)

// ponytail: the names of one team's services; a repo setting from path to mark would let any team pick its own.
const marks: Record<string, ReactNode> = {
  web: react,
  react,
  frontend: react,
  core: sollit,
  claus: key,
  'ai-service': spark,
  ai: spark,
  mobile: phone,
}

/** What goes on the tile: the service's mark, or for one without a mark its first two letters. */
const markOf = (area: string) =>
  marks[area.toLowerCase()] ?? (
    <text x={9} y={12.2} textAnchor="middle" fontSize={8} fontWeight={600} fill="#e3e4e6" style={{ fontFamily: 'var(--font-sans)' }}>
      {area.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase()}
    </text>
  )

/** The tile's contents, for drawing inside another SVG at 18 by 18. */
export const AreaMark = ({ area }: { area: string }) => (
  <>
    <title>{area}</title>
    <rect width={18} height={18} rx={4.5} fill={TILE} />
    {markOf(area)}
  </>
)

/** Where a component's code lives, as its service's mark; the name is its label and tooltip. */
export const AreaIcon = ({ area, size = 16, className }: { area: string; size?: number; className?: string }) => (
  <svg role="img" aria-label={area} width={size} height={size} viewBox="0 0 18 18" className={className} style={{ flexShrink: 0 }}>
    <AreaMark area={area} />
  </svg>
)

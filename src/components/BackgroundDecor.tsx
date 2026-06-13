// Subtle, site-wide background texture: drifting warm contour waves and a
// scattering of survey "dots". Purely decorative, no client JS, low opacity so
// content stays perfectly readable. Sits behind all page content.

const VW = 1440;
const VH = 900;

// deterministic survey dots
const dots = [
  [140, 180],
  [360, 120],
  [620, 240],
  [880, 150],
  [1120, 220],
  [1320, 130],
  [240, 460],
  [560, 540],
  [820, 470],
  [1080, 560],
  [1300, 500],
  [180, 760],
  [480, 820],
  [760, 740],
  [1040, 820],
  [1280, 760],
];

export default function BackgroundDecor() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      <svg
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="xMidYMid slice"
        className="h-full w-full"
      >
        {/* drifting contour waves */}
        <g className="animate-drift">
          {Array.from({ length: 7 }).map((_, i) => {
            const y = 130 + i * 110;
            const amp = 26 + i * 4;
            return (
              <path
                key={i}
                d={`M -120 ${y} C 240 ${y - amp}, 480 ${y + amp}, 720 ${y - amp} S 1200 ${y + amp}, 1560 ${y}`}
                fill="none"
                stroke="#E58E3A"
                strokeOpacity={0.1}
                strokeWidth={1.5}
              />
            );
          })}
        </g>

        {/* survey dots */}
        {dots.map(([x, y], i) => (
          <g key={i}>
            <circle
              cx={x}
              cy={y}
              r={9}
              fill="none"
              stroke="#D97706"
              strokeOpacity={0.14}
              className="animate-pulse-slow"
              style={{ animationDelay: `${(i % 5) * 0.6}s` }}
            />
            <circle cx={x} cy={y} r={2.5} fill="#D97706" fillOpacity={0.22} />
          </g>
        ))}
      </svg>
    </div>
  );
}

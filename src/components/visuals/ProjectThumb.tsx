// Deterministic mini "site map" thumbnail derived from the project slug.
function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

// Warm, earthy terrain palettes (kept on-brand with the off-white / orange theme).
const palettes: [string, string, string][] = [
  ["#2a1c0f", "#E58E3A", "#D97706"],
  ["#26201a", "#B45309", "#F5C89B"],
  ["#241a12", "#C2410C", "#EA9C50"],
  ["#2b2620", "#8a6d3b", "#d9b382"],
  ["#1f1c17", "#a8551f", "#e0a44a"],
];

export function ProjectThumb({ seed }: { seed: string }) {
  const h = hash(seed);
  const rand = rng(h);
  const [bg, c1, c2] = palettes[h % palettes.length];
  const W = 400;
  const H = 225;

  const fields = Array.from({ length: 18 }).map(() => ({
    x: rand() * W,
    y: rand() * H,
    w: 24 + rand() * 60,
    h: 16 + rand() * 40,
    f: rand() > 0.5 ? c1 : c2,
    o: 0.15 + rand() * 0.35,
  }));

  const contour = (off: number) => {
    let d = `M -10 ${40 + off}`;
    for (let x = 0; x <= W + 10; x += 30) {
      d += ` L ${x} ${
        40 + off + Math.sin((x / W) * Math.PI * 3 + off) * (18 + off / 4)
      }`;
    }
    return d;
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid slice"
      className="h-full w-full transition-transform duration-500 group-hover:scale-105"
    >
      <rect width={W} height={H} fill={bg} />
      {fields.map((f, i) => (
        <rect
          key={i}
          x={f.x}
          y={f.y}
          width={f.w}
          height={f.h}
          fill={f.f}
          opacity={f.o}
          rx={2}
        />
      ))}
      <g fill="none" stroke={c2} strokeOpacity={0.4} strokeWidth={1}>
        {[0, 35, 70, 105, 140].map((o) => (
          <path key={o} d={contour(o)} />
        ))}
      </g>
      <g stroke="rgba(255,255,255,0.06)" strokeWidth={1}>
        {Array.from({ length: 9 }).map((_, i) => (
          <line key={i} x1={(i * W) / 8} y1={0} x2={(i * W) / 8} y2={H} />
        ))}
        {Array.from({ length: 5 }).map((_, i) => (
          <line key={`h${i}`} x1={0} y1={(i * H) / 4} x2={W} y2={(i * H) / 4} />
        ))}
      </g>
      <rect
        width={W}
        height={H}
        fill="none"
        stroke="rgba(0,0,0,0.3)"
        strokeWidth={2}
      />
    </svg>
  );
}

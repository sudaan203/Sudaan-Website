import { ImageResponse } from "next/og";
import { siteConfig } from "@/lib/site";

export const runtime = "edge";
export const alt = `${siteConfig.name}: ${siteConfig.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 80,
          background:
            "linear-gradient(135deg, #FAF7F2 0%, #F1E7D8 55%, #F5C89B 100%)",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: "linear-gradient(135deg, #E58E3A, #D97706)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "white",
              fontSize: 30,
              fontWeight: 800,
            }}
          >
            S
          </div>
          <div style={{ color: "#111111", fontSize: 30, fontWeight: 700 }}>
            {siteConfig.name}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              color: "#D97706",
              fontSize: 24,
              fontWeight: 600,
              letterSpacing: 4,
              textTransform: "uppercase",
            }}
          >
            Geospatial Analytics
          </div>
          <div
            style={{
              color: "#111111",
              fontSize: 64,
              fontWeight: 800,
              lineHeight: 1.05,
              maxWidth: 950,
            }}
          >
            Transforming Survey Data Into Actionable Intelligence
          </div>
        </div>

        <div style={{ color: "#2E2E2E", fontSize: 26 }}>
          LiDAR · Orthomosaics · DSM / DTM · Contours · Point Clouds · GIS
        </div>
      </div>
    ),
    { ...size }
  );
}

import { notFound } from "next/navigation";
import { requireSession } from "@/lib/portal/auth";
import { getSite, listVideos } from "@/lib/portal/store";

export default async function SiteVideosPage({
  params,
}: {
  params: Promise<{ siteSlug: string }>;
}) {
  const { siteSlug } = await params;
  const session = await requireSession(`/portal/${siteSlug}/videos`);

  const site = await getSite(session, siteSlug);
  if (!site) notFound();

  const videos = await listVideos(site.id);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-ink-900">Video</h2>
        <p className="mt-1 text-sm text-ink/70">
          Flight footage and walkthroughs recorded over this site.
        </p>
      </div>

      {videos.length === 0 ? (
        <div className="surface p-6">
          <p className="text-sm text-ink/70">No video has been published for this site.</p>
        </div>
      ) : (
        <ul className="space-y-6">
          {videos.map((video) => (
            <li key={video.id} className="surface overflow-hidden">
              <div className="aspect-video w-full bg-ink-900">
                <iframe
                  src={`https://www.youtube-nocookie.com/embed/${video.youtubeId}?rel=0&modestbranding=1`}
                  title={video.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="h-full w-full border-0"
                />
              </div>
              <p className="px-5 py-3 text-sm font-semibold text-ink-900">{video.title}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

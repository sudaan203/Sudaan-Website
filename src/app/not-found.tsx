import Link from "next/link";

export default function NotFound() {
  return (
    <section className="container-px flex min-h-[70vh] flex-col items-center justify-center text-center">
      <span className="eyebrow">Error 404</span>
      <h1 className="heading-xl mt-5">Off the map</h1>
      <p className="lead mt-5 max-w-md">
        The page you&apos;re looking for has drifted outside our survey extent.
        Let&apos;s get you back to known coordinates.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-4">
        <Link href="/" className="btn-primary">
          Back to home
        </Link>
        <Link href="/data-insights" className="btn-secondary">
          Explore Data Insights
        </Link>
      </div>
    </section>
  );
}

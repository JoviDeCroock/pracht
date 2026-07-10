import { Image } from "@pracht/image";

export function Component() {
  return (
    <section>
      <h1>Optimized images</h1>
      <p>
        These images are served through the <code>/api/_pracht/image</code> endpoint mounted in
        <code> src/api/_pracht/image.ts</code>. The component renders plain markup: responsive
        <code> srcset</code>, lazy loading, and reserved dimensions to avoid layout shift.
      </p>

      {/* Above the fold: eager + fetchpriority=high. */}
      <Image
        src="/banner.jpg"
        alt="Pracht banner"
        width={1200}
        height={280}
        priority
        sizes="(max-width: 1200px) 100vw, 1200px"
      />

      {/* Below the fold: lazy by default, fixed layout with 1x/2x candidates. */}
      <Image src="/banner.jpg" alt="Pracht banner thumbnail" width={384} height={90} />

      {/* Fill mode: stretches to a positioned parent, no intrinsic dimensions. */}
      <div style={{ position: "relative", width: "100%", height: "140px" }}>
        <Image src="/banner.jpg" alt="Pracht banner cover" fill style={{ objectFit: "cover" }} />
      </div>
    </section>
  );
}

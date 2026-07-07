import { h } from "preact";
import { render } from "preact-render-to-string";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cloudflareLoader,
  configureImage,
  Image,
  passthroughLoader,
  resetImageConfig,
  vercelLoader,
} from "../src/index.ts";

afterEach(() => {
  resetImageConfig();
  vi.restoreAllMocks();
});

describe("<Image> fixed layout", () => {
  it("renders width/height, a lazy async img, and a 1x/2x srcset snapped to breakpoints", () => {
    const html = render(h(Image, { src: "/hero.jpg", alt: "Hero", width: 640, height: 480 }));

    expect(html).toContain('width="640"');
    expect(html).toContain('height="480"');
    expect(html).toContain('alt="Hero"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).not.toContain("fetchpriority");

    // 1x snaps to 640, 2x (1280) snaps up to the next breakpoint (1920).
    expect(html).toContain("/api/_pracht/image?url=%2Fhero.jpg&amp;w=640&amp;q=75 1x");
    expect(html).toContain("/api/_pracht/image?url=%2Fhero.jpg&amp;w=1920&amp;q=75 2x");
    // The src attribute uses the largest candidate.
    expect(html).toContain('src="/api/_pracht/image?url=%2Fhero.jpg&amp;w=1920&amp;q=75"');
    // Fixed layout without a sizes prop must not emit a sizes attribute.
    expect(html).not.toContain("sizes=");
  });

  it("forwards the quality prop to the loader", () => {
    const html = render(
      h(Image, { src: "/hero.jpg", alt: "", width: 64, height: 64, quality: 50 }),
    );
    expect(html).toContain("q=50");
    expect(html).not.toContain("q=75");
  });
});

describe("<Image> responsive layout", () => {
  it("emits w descriptors across the device sizes when a sizes prop is present", () => {
    const html = render(
      h(Image, {
        src: "/hero.jpg",
        alt: "Hero",
        width: 1200,
        height: 800,
        sizes: "100vw",
      }),
    );

    expect(html).toContain('sizes="100vw"');
    for (const width of [640, 750, 828, 1080, 1200, 1920, 2048, 3840]) {
      expect(html).toContain(`w=${width}&amp;q=75 ${width}w`);
    }
    expect(html).toContain('src="/api/_pracht/image?url=%2Fhero.jpg&amp;w=3840&amp;q=75"');
  });

  it("drops candidates that a small vw hint can never select", () => {
    const html = render(
      h(Image, {
        src: "/thumb.jpg",
        alt: "Thumb",
        width: 320,
        height: 320,
        sizes: "25vw",
      }),
    );

    // 25vw of the smallest breakpoint (640) is 160; widths below stay out.
    expect(html).not.toContain("w=128&amp;");
    expect(html).toContain("w=256&amp;q=75 256w");
    expect(html).toContain("w=3840&amp;q=75 3840w");
  });

  it("respects configured custom deviceSizes", () => {
    configureImage({ deviceSizes: [400, 800], imageSizes: [] });
    const html = render(
      h(Image, { src: "/hero.jpg", alt: "", width: 400, height: 300, sizes: "100vw" }),
    );

    expect(html).toContain("w=400&amp;q=75 400w");
    expect(html).toContain("w=800&amp;q=75 800w");
    expect(html).not.toContain("w=3840");
  });
});

describe("<Image> priority", () => {
  it("switches to eager loading with fetchpriority high", () => {
    const html = render(
      h(Image, { src: "/hero.jpg", alt: "Hero", width: 640, height: 480, priority: true }),
    );

    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchpriority="high"');
    expect(html).toContain('decoding="async"');
  });
});

describe("<Image> fill mode", () => {
  it("absolutely positions the image, defaults sizes to 100vw, and omits dimensions", () => {
    const html = render(h(Image, { src: "/hero.jpg", alt: "Hero", fill: true }));

    expect(html).toMatch(/position:\s*absolute/);
    expect(html).toMatch(/height:\s*100%/);
    expect(html).toMatch(/width:\s*100%/);
    expect(html).not.toContain('width="');
    expect(html).not.toContain('height="');
    expect(html).toContain('sizes="100vw"');
    expect(html).toContain("w=3840&amp;q=75 3840w");
  });

  it("merges user styles on top of the fill styles", () => {
    const html = render(
      h(Image, { src: "/hero.jpg", alt: "Hero", fill: true, style: { objectFit: "cover" } }),
    );

    expect(html).toMatch(/position:\s*absolute/);
    expect(html).toMatch(/object-fit:\s*cover/);
  });
});

describe("<Image> loader selection", () => {
  it("prefers the per-component loader prop", () => {
    const html = render(
      h(Image, {
        src: "/hero.jpg",
        alt: "Hero",
        width: 640,
        height: 480,
        loader: cloudflareLoader,
      }),
    );

    expect(html).toContain("/cdn-cgi/image/width=640,quality=75,format=auto/hero.jpg 1x");
    expect(html).not.toContain("/api/_pracht/image");
  });

  it("uses the globally configured loader", () => {
    configureImage({ loader: vercelLoader });
    const html = render(h(Image, { src: "/hero.jpg", alt: "Hero", width: 640, height: 480 }));

    expect(html).toContain("/_vercel/image?url=%2Fhero.jpg&amp;w=640&amp;q=75 1x");
  });

  it("omits srcset entirely for the passthrough loader", () => {
    const html = render(
      h(Image, {
        src: "/hero.jpg",
        alt: "Hero",
        width: 640,
        height: 480,
        loader: passthroughLoader,
      }),
    );

    expect(html).toContain('src="/hero.jpg"');
    expect(html).not.toContain("srcset");
  });
});

describe("<Image> dev warnings", () => {
  it("warns when width/height are missing without fill", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(h(Image, { src: "/missing-dimensions.jpg", alt: "Broken" }));

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('missing required "width" and "height" props'),
    );
  });

  it("warns when fill is combined with explicit dimensions", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(h(Image, { src: "/fill-dimensions.jpg", alt: "Broken", fill: true, width: 100 }));

    expect(error).toHaveBeenCalledWith(expect.stringContaining('"fill" together with'));
  });

  it("does not warn when dimensions are provided", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(h(Image, { src: "/ok.jpg", alt: "Fine", width: 10, height: 10 }));

    expect(error).not.toHaveBeenCalled();
  });
});

import type { JSX } from "preact";

import type { ImageProps } from "./image-types.ts";

const FILL_STYLE: JSX.CSSProperties = {
  position: "absolute",
  height: "100%",
  width: "100%",
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
};

const FILL_STYLE_STRING = "position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;";

// Strict shape for blur data URIs before they are interpolated into an inline
// style. The character set after the comma (base64 plus percent-encoding)
// excludes quotes, parentheses, backslashes, and whitespace, so a value that
// matches cannot break out of `url("…")` and inject CSS.
const BLUR_DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=+-]+)*,[a-z0-9+/=._%-]*$/i;

export function isSafeBlurDataURL(value: string): boolean {
  return BLUR_DATA_URL_PATTERN.test(value);
}

export function mergeImageStyle(
  style: ImageProps["style"],
  blurDataURL: string | undefined,
  fill: boolean,
): string | JSX.CSSProperties | undefined {
  if (blurDataURL == null && !fill) return style;

  const blur = blurDataURL == null ? undefined : blurBackground(blurDataURL);
  const baseString = `${blur?.styleString ?? ""}${fill ? FILL_STYLE_STRING : ""}`;
  return typeof style === "string"
    ? `${baseString}${style}`
    : {
        ...blur?.styleObject,
        ...(fill ? FILL_STYLE : undefined),
        ...(style as JSX.CSSProperties | undefined),
      };
}

function blurBackground(blurDataURL: string): {
  styleString: string;
  styleObject: JSX.CSSProperties;
} {
  const image = `url("${blurDataURL}")`;
  return {
    styleString:
      `background-image:${image};background-size:cover;` +
      "background-position:50% 50%;background-repeat:no-repeat;",
    styleObject: {
      backgroundImage: image,
      backgroundSize: "cover",
      backgroundPosition: "50% 50%",
      backgroundRepeat: "no-repeat",
    },
  };
}

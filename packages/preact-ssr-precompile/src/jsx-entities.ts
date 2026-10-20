// The named character references the JSX transform decodes, as `name:hex code point`.
const NAMED_ENTITIES = new Map(
  (
    "quot:22 amp:26 apos:27 lt:3c gt:3e nbsp:a0 iexcl:a1 cent:a2 pound:a3 curren:a4 yen:a5 " +
    "brvbar:a6 sect:a7 uml:a8 copy:a9 ordf:aa laquo:ab not:ac shy:ad reg:ae macr:af deg:b0 " +
    "plusmn:b1 sup2:b2 sup3:b3 acute:b4 micro:b5 para:b6 middot:b7 cedil:b8 sup1:b9 ordm:ba " +
    "raquo:bb frac14:bc frac12:bd frac34:be iquest:bf Agrave:c0 Aacute:c1 Acirc:c2 " +
    "Atilde:c3 Auml:c4 Aring:c5 AElig:c6 Ccedil:c7 Egrave:c8 Eacute:c9 Ecirc:ca Euml:cb " +
    "Igrave:cc Iacute:cd Icirc:ce Iuml:cf ETH:d0 Ntilde:d1 Ograve:d2 Oacute:d3 Ocirc:d4 " +
    "Otilde:d5 Ouml:d6 times:d7 Oslash:d8 Ugrave:d9 Uacute:da Ucirc:db Uuml:dc Yacute:dd " +
    "THORN:de szlig:df agrave:e0 aacute:e1 acirc:e2 atilde:e3 auml:e4 aring:e5 aelig:e6 " +
    "ccedil:e7 egrave:e8 eacute:e9 ecirc:ea euml:eb igrave:ec iacute:ed icirc:ee iuml:ef " +
    "eth:f0 ntilde:f1 ograve:f2 oacute:f3 ocirc:f4 otilde:f5 ouml:f6 divide:f7 oslash:f8 " +
    "ugrave:f9 uacute:fa ucirc:fb uuml:fc yacute:fd thorn:fe yuml:ff OElig:152 oelig:153 " +
    "Scaron:160 scaron:161 Yuml:178 fnof:192 circ:2c6 tilde:2dc Alpha:391 Beta:392 " +
    "Gamma:393 Delta:394 Epsilon:395 Zeta:396 Eta:397 Theta:398 Iota:399 Kappa:39a " +
    "Lambda:39b Mu:39c Nu:39d Xi:39e Omicron:39f Pi:3a0 Rho:3a1 Sigma:3a3 Tau:3a4 " +
    "Upsilon:3a5 Phi:3a6 Chi:3a7 Psi:3a8 Omega:3a9 alpha:3b1 beta:3b2 gamma:3b3 delta:3b4 " +
    "epsilon:3b5 zeta:3b6 eta:3b7 theta:3b8 iota:3b9 kappa:3ba lambda:3bb mu:3bc nu:3bd " +
    "xi:3be omicron:3bf pi:3c0 rho:3c1 sigmaf:3c2 sigma:3c3 tau:3c4 upsilon:3c5 phi:3c6 " +
    "chi:3c7 psi:3c8 omega:3c9 thetasym:3d1 upsih:3d2 piv:3d6 ensp:2002 emsp:2003 " +
    "thinsp:2009 zwnj:200c zwj:200d lrm:200e rlm:200f ndash:2013 mdash:2014 lsquo:2018 " +
    "rsquo:2019 sbquo:201a ldquo:201c rdquo:201d bdquo:201e dagger:2020 Dagger:2021 " +
    "bull:2022 hellip:2026 permil:2030 prime:2032 Prime:2033 lsaquo:2039 rsaquo:203a " +
    "oline:203e frasl:2044 euro:20ac image:2111 weierp:2118 real:211c trade:2122 " +
    "alefsym:2135 larr:2190 uarr:2191 rarr:2192 darr:2193 harr:2194 crarr:21b5 lArr:21d0 " +
    "uArr:21d1 rArr:21d2 dArr:21d3 hArr:21d4 forall:2200 part:2202 exist:2203 empty:2205 " +
    "nabla:2207 isin:2208 notin:2209 ni:220b prod:220f sum:2211 minus:2212 lowast:2217 " +
    "radic:221a prop:221d infin:221e ang:2220 and:2227 or:2228 cap:2229 cup:222a int:222b " +
    "there4:2234 sim:223c cong:2245 asymp:2248 ne:2260 equiv:2261 le:2264 ge:2265 sub:2282 " +
    "sup:2283 nsub:2284 sube:2286 supe:2287 oplus:2295 otimes:2297 perp:22a5 sdot:22c5 " +
    "lceil:2308 rceil:2309 lfloor:230a rfloor:230b lang:2329 rang:232a loz:25ca spades:2660 " +
    "clubs:2663 hearts:2665 diams:2666"
  )
    .split(" ")
    .map((entry) => {
      const [name, code] = entry.split(":");
      return [name, String.fromCodePoint(Number.parseInt(code, 16))] as const;
    }),
);

const DECIMAL_REFERENCE = /^\+?[0-9]+$/;
const HEX_REFERENCE = /^\+?[0-9a-fA-F]+$/;

/**
 * Decodes HTML character references in JSX text and attribute strings the same
 * way the JSX transform does, since the parser leaves them encoded.
 */
export function decodeJsxEntities(value: string): string {
  if (!value.includes("&")) return value;

  return value.replace(/&([^&;]*);/g, (reference, word: string) => {
    if (word.startsWith("#")) {
      const isHex = word[1] === "x";
      const digits = word.slice(isHex ? 2 : 1);
      if (!(isHex ? HEX_REFERENCE : DECIMAL_REFERENCE).test(digits)) return reference;
      const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return reference;
      return String.fromCodePoint(codePoint);
    }

    return NAMED_ENTITIES.get(word) ?? reference;
  });
}

import { Fragment, type ReactNode } from "react";

/**
 * A translated text with the few tags it may carry: <b>, <code>, and links named in `links`
 * (<terms>..</terms> → links.terms). They nest, e.g. <b>..<code>..</code>..</b>.
 */
export function rich(s: string, links: Record<string, string> = {}): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const tag = m[1];
    if (tag !== "b" && tag !== "code" && !(tag in links)) continue;
    if (m.index > last) out.push(s.slice(last, m.index));
    const inner = rich(m[2], links);
    const k = out.length;
    if (tag === "b") out.push(<b key={k}>{inner}</b>);
    else if (tag === "code") out.push(<code key={k}>{inner}</code>);
    else out.push(<a key={k} href={links[tag]} target="_blank" rel="noreferrer">{inner}</a>);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out.map((n, i) => (typeof n === "string" ? <Fragment key={i}>{n}</Fragment> : n));
}

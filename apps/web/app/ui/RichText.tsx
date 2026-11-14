// Renders a notice body (the Markdown subset in lib/rich-text.ts) as React
// elements. No HTML is ever injected: marks, lists, links and images are built
// from parsed data, links are limited to http(s)/mailto/tel, and an image is
// only ever an uploaded event file resolved through the caller's imageSrc.
// No hooks and no "use client", so server pages and client shells share it.

import type { ReactNode } from "react";
import { parseRichText, type Inline } from "../../lib/rich-text";
import styles from "./RichText.module.css";

type Props = {
  source: string;
  /** Resolves an uploaded file id to a URL the viewer is allowed to fetch. */
  imageSrc: (fileId: string) => string;
  className?: string;
};

function renderInline(nodes: Inline[], imageSrc: Props["imageSrc"]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.t) {
      case "text": return node.v;
      case "br": return <br key={index} />;
      case "bold": return <strong key={index}>{renderInline(node.c, imageSrc)}</strong>;
      case "italic": return <em key={index}>{renderInline(node.c, imageSrc)}</em>;
      case "link": return <a key={index} href={node.href} target="_blank" rel="noopener noreferrer">{renderInline(node.c, imageSrc)}</a>;
      case "image":
        // eslint-disable-next-line @next/next/no-img-element
        return <img key={index} className={styles.image} src={imageSrc(node.fileId)} alt={node.alt} loading="lazy" />;
    }
  });
}

export default function RichText({ source, imageSrc, className }: Props) {
  return (
    <div className={className ? `${styles.rich} ${className}` : styles.rich}>
      {parseRichText(source).map((block, index) => {
        if (block.t === "p") return <p key={index}>{renderInline(block.c, imageSrc)}</p>;
        const Tag = block.t;
        return <Tag key={index}>{block.items.map((item, at) => <li key={at}>{renderInline(item, imageSrc)}</li>)}</Tag>;
      })}
    </div>
  );
}

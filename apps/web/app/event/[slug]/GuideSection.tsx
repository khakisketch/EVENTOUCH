import type { ReactNode } from "react";
import AttendeeSectionHeader from "./ui/AttendeeSectionHeader";
import L from "./home/home-layouts.module.css";
import styles from "./public-event.module.css";

// One section of the event guide: its title on the ground, then its card. The
// public guide and the console's phone preview both draw their sections with
// this, so the preview cannot drift from what attendees see.
export default function GuideSection({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section className={styles.section} id={id} aria-label={title}>
      <AttendeeSectionHeader className={`${L.sectionHead} ${styles.sectionHead}`} size="sm" title={title} />
      {children}
    </section>
  );
}
